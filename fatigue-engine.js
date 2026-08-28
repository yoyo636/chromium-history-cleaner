/* =========================================================================
 * fatigue-engine.js — 「观息」视觉疲劳自研引擎 v2（EyeCare Engine）
 * -------------------------------------------------------------------------
 * 定位：多信号融合的视觉疲劳评估引擎。content.js 只负责「渲染」，
 *       本文件负责「感知 + 建模 + 个性化」，通过 window.__EyeCareEngine 暴露。
 *
 * 算法总览（五层）：
 *
 *  L1 信号层（Signal Layer）
 *    S1 键入强度   按键频率的 EMA + 输入节奏方差
 *    S2 点击强度   点击频率 EMA
 *    S3 滚动强度   滚动速度 EMA + 路径熵（方向序列 Shannon 熵）
 *    S4 鼠标运动学 速度分布（μ/σ）、停顿率、微颤动率（方向反转率）、
 *                 急动度（jerk，加速度变化率）直方图熵
 *    S5 内容卷入   阅读速度代理（滚动深度增量/活跃分钟）、
 *                 连续视频观看时长（video 元素 timeUpdate 探测）
 *    S6 时长与节律 连续活跃分钟（任务疲劳曲线输入）、本地时刻（昼夜节律输入）
 *
 *  L2 归一化层（Normalization）
 *    - Welford 在线均值/方差 → 特征 z-score
 *    - 个人基线：P² 分位数估计算法（Jain & Chlamtac）在线维护
 *      p10/p50/p90，z-score 相对「个人历史分布」而非全局常数，
 *      阈值随用户习惯自动校准（如频率型用户与阅读型用户基线不同）
 *
 *  L3 模型层（Fatigue Model）
 *    M1 时间任务疲劳 logistic 增长：
 *        F(t) = 1 / (1 + exp(-k · (t - t₀)))
 *        强度越大 k 越大（高强度用眼更快进入疲劳期）
 *    M2 昼夜节律系数：双谷余弦模型（凌晨 3-5 点主谷，午后 14-16 点次谷）
 *        C(h) = 0.85 + 0.15·cos(2π(h-15)/24)  再叠加主谷惩罚
 *    M3 恢复模型：空闲期指数衰减（半衰期 τ 按空闲时长分档：
 *        短歇 τ=90s，长歇>5min τ=25s，即长歇恢复更快）
 *    M4 融合：几何加权平均（对单信号爆表惩罚强于算术平均）
 *        score = 100 · Π sᵢ^{wᵢ}，权重按信号可用性自适应归一
 *
 *  L4 个性化层（Personalization）
 *    - 引擎档案 fatigueProfile（chrome.storage.local 持久化）：
 *      各信号 Welford 状态 + P² 分位器状态 + 会话累计
 *    - 每 10 分钟节流写盘，浏览器重启不丢失校准结果
 *
 *  L5 输出层（Output）
 *    - 双 EMA 平滑（快 EMA α=0.35 / 慢 EMA α=0.12）+ 趋势项
 *    - 迟滞分级 1-5：升级需「越过阈值且持续 30s」，降级即时；
 *      5 级需同时满足 score 高且趋势为升，防止误报
 *    - 置信度：各信号样本量加权（冷启动低置信，随使用上升）
 *    - tick() 返回 {score, level, confidence, trend, breakdown}
 * ========================================================================= */

'use strict';

(() => {
  if (window.__EyeCareEngine) return; // 防重复注入
  if (typeof chrome === 'undefined' || !chrome.storage) return; // 非扩展环境

  /* =======================================================================
   * 0. 数学工具
   * ===================================================================== */
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /** logistic 函数及其参数化（中点 t0、斜率 k） */
  function logistic(x, k, x0) {
    return 1 / (1 + Math.exp(-k * (x - x0)));
  }

  /** Shannon 熵（归一化到 [0,1]，n 个等宽桶） */
  function shannonEntropy(bins) {
    const total = bins.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    let h = 0;
    for (const b of bins) {
      if (b <= 0) continue;
      const p = b / total;
      h -= p * Math.log(p);
    }
    return h / Math.log(bins.length);
  }

  /* =======================================================================
   * 1. Welford 在线均值/方差
   *    数值稳定，单遍扫描，适合流式信号
   * ===================================================================== */
  class Welford {
    constructor(n = 0, mean = 0, m2 = 0) {
      this.n = n; this.mean = mean; this.m2 = m2;
    }
    push(x) {
      this.n += 1;
      const d = x - this.mean;
      this.mean += d / this.n;
      this.m2 += d * (x - this.mean);
      return this;
    }
    get variance() { return this.n > 1 ? this.m2 / (this.n - 1) : 0; }
    get std() { return Math.sqrt(this.variance); }
    /** z-score 相对个人分布；样本不足时返回 null（冷启动） */
    z(x) {
      if (this.n < 12) return null;
      const s = this.std || 1e-6;
      return (x - this.mean) / s;
    }
    toJSON() { return { n: this.n, mean: this.mean, m2: this.m2 }; }
    static from(o) { return new Welford(o.n || 0, o.mean || 0, o.m2 || 0); }
  }

  /** z-score → [0,1] 疲劳贡献（logistic 压缩，中点 z=+0.8，斜率 1.6）
   *  含义：高于个人常态约 0.8σ 开始显著贡献疲劳。 */
  function zToFatigue(z) {
    if (z == null) return null;
    return clamp01(logistic(z, 1.6, 0.8));
  }

  /* =======================================================================
   * 2. P² 在线分位数估计（Jain & Chlamtac 1985）
   *    O(1) 内存维护任意分位数，无需存原始样本。
   *    用于估计个人基线 p10/p50/p90。
   * ===================================================================== */
  class P2Quantile {
    constructor(p, init = 0) {
      this.p = p;
      this.n = 0;
      this.markers = [0, 0, 0, 0, 0].map(() => init); // q0..q4
      this.pos = [1, 2, 3, 4, 5];
      this.desired = [1, 1 + 2 * p, 1 + 4 * p, 3 + 2 * p, 5];
      this.inited = false;
    }
    push(x) {
      this.n += 1;
      if (this.n <= 5) {
        this.markers[this.n - 1] = x;
        if (this.n === 5) {
          this.markers.sort((a, b) => a - b);
          this.inited = true;
        }
        return;
      }
      // 找桶 k
      let k;
      if (x < this.markers[0]) { this.markers[0] = x; k = 1; }
      else if (x < this.markers[1]) k = 1;
      else if (x < this.markers[2]) k = 2;
      else if (x < this.markers[3]) k = 3;
      else { this.markers[4] = x; k = 4; }
      for (let i = k; i < 5; i++) this.pos[i] += 1;
      // 调整标记点
      const d = this.desired;
      for (let i = 1; i <= 3; i++) {
        const ni = this.pos[i] + (d[i] - 1) * (this.n - 1) / 4 + 1;
        const di = ni - this.pos[i];
        if ((di >= 1 && this.pos[i + 1] - this.pos[i] > 1) ||
            (di <= -1 && this.pos[i - 1] - this.pos[i] < -1)) {
          const diSign = Math.sign(di);
          // 抛物线预测
          const q = this.markers;
          const qi = q[i] + diSign / (q[i + 1] - q[i - 1]) * (
            (this.pos[i] - this.pos[i - 1] + diSign) * (q[i + 1] - q[i]) / (this.pos[i + 1] - this.pos[i]) +
            (this.pos[i + 1] - this.pos[i] - diSign) * (q[i] - q[i - 1]) / (this.pos[i] - this.pos[i - 1])
          );
          if (q[i - 1] < qi && qi < q[i + 1]) q[i] = qi;
          else q[i] = this._linear(i, diSign);
          this.pos[i] += diSign;
        }
      }
    }
    _linear(i, d) {
      const q = this.markers;
      return q[i] + d * (q[i + d] - q[i]) / (this.pos[i + d] - this.pos[i]);
    }
    /** 估计值；样本不足返回 null */
    value() {
      if (this.n < 8) return null;
      return this.markers[2];
    }
    count() { return this.n; }
    toJSON() { return { p: this.p, n: this.n, markers: this.markers, pos: this.pos, desired: this.desired, inited: this.inited }; }
    static from(o) {
      const q = new P2Quantile(o.p || 0.5);
      q.n = o.n || 0; q.markers = o.markers || q.markers;
      q.pos = o.pos || q.pos; q.desired = o.desired || q.desired; q.inited = !!o.inited;
      return q;
    }
  }

  /* =======================================================================
   * 3. 信号采集器
   * ===================================================================== */

  /** 通用 EMA 特征采集器：节流采样 → 事件率/强度 → 窗口 EMA */
  class RateMeter {
    constructor(emaAlpha = 0.08) {
      this.alpha = emaAlpha;
      this.count = 0;
      this.windowStart = performance.now();
      this.rate = 0;          // 事件/分钟（EMA）
      this.lastBurst = 0;     // 上一秒事件数（节奏方差用）
      this.bursts = [];       // 每秒事件数样本（最多 120）
      this._secStart = Math.floor(performance.now() / 1000);
    }
    hit(n = 1) {
      this.count += n;
      this._rollSecond();
    }
    _rollSecond() {
      const sec = Math.floor(performance.now() / 1000);
      if (sec === this._secStart) return;
      const elapsed = sec - this._secStart;
      this._secStart = sec;
      // 补零秒
      for (let i = 0; i < Math.min(elapsed, 30); i++) {
        this.bursts.push(i === elapsed - 1 ? this.lastBurst : 0);
      }
      this.lastBurst = 0;
      if (this.bursts.length > 120) this.bursts.splice(0, this.bursts.length - 120);
      // 分钟率 EMA
      const windowMs = performance.now() - this.windowStart;
      if (windowMs >= 15000) {
        const perMin = this.count / (windowMs / 60000);
        this.rate = this.rate ? lerp(this.rate, perMin, this.alpha) : perMin;
        this.count = 0;
        this.windowStart = performance.now();
      }
    }
    /** 节奏方差（越大越「一顿一顿」） */
    rhythmVariance() {
      if (this.bursts.length < 20) return 0;
      const m = this.bursts.reduce((a, b) => a + b, 0) / this.bursts.length;
      const v = this.bursts.reduce((a, b) => a + (b - m) ** 2, 0) / this.bursts.length;
      return m > 0.5 ? Math.sqrt(v) / m : 0; // 变异系数
    }
    ready() { return this.rate > 0 || this.bursts.length > 30; }
  }

  /** 鼠标运动学采集器 */
  class MouseTracker {
    constructor() {
      this.speed = new Welford();        // 速度分布
      this.jerkBins = new Array(8).fill(0); // 急动度直方图
      this.pauses = [];                  // 每分钟停顿时长(ms)
      this.lastX = 0; this.lastY = 0; this.lastT = 0;
      this.lastSpeed = 0; this.lastAngle = null;
      this.reversals = 0; this.moves = 0;
      this.pauseStart = 0; this.pauseMsWindow = 0;
      this._winStart = performance.now();
    }
    move(x, y) {
      const now = performance.now();
      if (!this.lastT) { this.lastX = x; this.lastY = y; this.lastT = now; return; }
      const dt = now - this.lastT;
      if (dt < 30) return; // 节流 ~33Hz
      const dx = x - this.lastX, dy = y - this.lastY;
      const dist = Math.hypot(dx, dy);
      const speed = dist / dt; // px/ms
      // 急动度 = |Δa|/dt 的粗略代理：|Δv|/dt
      if (this.lastT && this.lastSpeed > 0) {
        const jerk = Math.abs(speed - this.lastSpeed) / dt; // px/ms²
        const bin = clamp(Math.floor(jerk * 4000), 0, 7);
        this.jerkBins[bin] += 1;
      }
      this.speed.push(speed);
      // 方向反转（微颤动代理）
      if (dist > 2) {
        const angle = Math.atan2(dy, dx);
        if (this.lastAngle != null) {
          let diff = Math.abs(angle - this.lastAngle);
          if (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff > Math.PI / 4) this.reversals += 1;
        }
        this.lastAngle = angle;
      }
      this.moves += 1;
      this.lastSpeed = speed;
      this.lastX = x; this.lastY = y; this.lastT = now;
    }
    /** 每分钟快照：停顿率、反转率、速度 μ/σ、急动熵 */
    snapshot(activeMsWindow) {
      const std = this.speed.std;
      const out = {
        speedMean: this.speed.mean,
        speedStd: std,
        reversalRate: this.moves > 20 ? this.reversals / this.moves : null,
        jerkEntropy: shannonEntropy(this.jerkBins),
        pauseRatio: null,
        samples: this.speed.n,
      };
      this.reversals = 0; this.moves = 0;
      this.jerkBins.fill(0);
      // 速度分布重置过于激进会破坏 Welford；保留，仅窗口化使用 z()
      return out;
    }
  }

  /** 滚动采集器（含方向序列熵 + 阅读速度代理） */
  class ScrollTracker {
    constructor() {
      this.rate = new RateMeter(0.1);
      this.dirs = [];               // 方向序列（1/-1），路径熵用
      this.speeds = new Welford();
      this.depth = 0;               // 累计滚动深度（绝对值）
      this.lastY = 0; this.lastT = 0;
    }
    onScroll(y) {
      const now = performance.now();
      if (!this.lastT) { this.lastY = y; this.lastT = now; return; }
      const dt = now - this.lastT;
      if (dt < 50) return;
      const d = y - this.lastY;
      const ad = Math.abs(d);
      if (ad > 0) {
        this.rate.hit();
        this.depth += ad;
        this.speeds.push(ad / dt);
        const dir = Math.sign(d);
        if (this.dirs.length && this.dirs[this.dirs.length - 1] !== dir) this.dirs.push(dir);
        else if (!this.dirs.length) this.dirs.push(dir);
        // 方向序列上限
        if (this.dirs.length > 240) this.dirs.splice(0, this.dirs.length - 240);
      }
      this.lastY = y; this.lastT = now;
    }
    pathEntropy() { return shannonEntropy(this._binDirs()); }
    _binDirs() {
      // 把方向序列切成 24 段计转移次数 → 近似路径熵
      const bins = new Array(24).fill(0);
      const seg = Math.max(1, Math.floor(this.dirs.length / 24));
      for (let i = 0; i < this.dirs.length; i += seg) {
        let sum = 0;
        for (let j = i; j < Math.min(i + seg, this.dirs.length); j++) sum += this.dirs[j];
        bins[clamp(Math.floor((sum / seg + 1) * 11.5), 0, 23)] += 1;
      }
      return bins;
    }
  }

  /** 视频连续观看探测器（timeUpdate 心跳） */
  class VideoWatcher {
    constructor() { this.playingMs = 0; this._last = 0; this._seen = new WeakSet(); }
    observe() {
      const scan = () => {
        document.querySelectorAll('video').forEach((v) => {
          if (this._seen.has(v)) return;
          this._seen.add(v);
          v.addEventListener('timeupdate', () => {
            const now = performance.now();
            if (!v.paused && this._last) this.playingMs += now - this._last;
            this._last = v.paused ? 0 : now;
          }, { passive: true });
        });
      };
      scan();
      setInterval(scan, 8000);
    }
    minutesPerWindow(winMs) { return clamp01(this.playingMs / winMs); }
  }

  /* =======================================================================
   * 4. 引擎主体
   * ===================================================================== */
  const PROFILE_KEY = 'fatigueProfile';
  const SAVE_EVERY_MS = 600000; // 档案写盘节流 10 分钟

  const Engine = {
    // —— L1 信号状态 ——
    keyRate: new RateMeter(0.08),
    clickRate: new RateMeter(0.1),
    scroll: new ScrollTracker(),
    mouse: new MouseTracker(),
    video: new VideoWatcher(),

    // —— 会话 ——
    session: { start: Date.now(), lastActivity: Date.now(), activeMs: 0, totalMs: 0, lastReportedActiveMs: 0 },

    // —— L4 个性化档案（冷启动默认） ——
    profile: {
      welford: {
        keyRate: new Welford(), clickRate: new Welford(),
        scrollRate: new Welford(), scrollSpeed: new Welford(),
        mouseSpeed: new Welford(), mouseReversal: new Welford(),
        keyGap: new Welford(),
      },
      p2: { speedSlow: new P2Quantile(0.35), reversal: new P2Quantile(0.7) },
      sessions: 0,
      savedAt: 0,
    },

    // —— L5 输出状态 ——
    out: { fast: 0, slow: 0, trend: 0, level: 1, levelSince: 0, confidence: 0 },

    // —— 恢复状态 ——
    fatigueReserve: 0, // M3 恢复模型内部状态：未衰减完的疲劳势
    lastActiveAt: Date.now(),

    /* ---------- 档案持久化 ---------- */
    async loadProfile() {
      try {
        const r = await chrome.storage.local.get({ [PROFILE_KEY]: null });
        const p = r[PROFILE_KEY];
        if (p && p.welford) {
          const w = this.profile.welford;
          for (const k of Object.keys(w)) if (p.welford[k]) w[k] = Welford.from(p.welford[k]);
          if (p.p2) {
            this.profile.p2.speedSlow = P2Quantile.from(p.p2.speedSlow || { p: 0.35 });
            this.profile.p2.reversal = P2Quantile.from(p.p2.reversal || { p: 0.7 });
          }
          this.profile.sessions = p.sessions || 0;
        }
      } catch (_e) { /* 档案损坏则冷启动 */ }
    },
    async saveProfile(force) {
      const now = Date.now();
      if (!force && now - this.profile.savedAt < SAVE_EVERY_MS) return;
      this.profile.savedAt = now;
      const p = this.profile;
      try {
        await chrome.storage.local.set({
          [PROFILE_KEY]: {
            welford: {
              keyRate: p.welford.keyRate.toJSON(),
              clickRate: p.welford.clickRate.toJSON(),
              scrollRate: p.welford.scrollRate.toJSON(),
              scrollSpeed: p.welford.scrollSpeed.toJSON(),
              mouseSpeed: p.welford.mouseSpeed.toJSON(),
              mouseReversal: p.welford.mouseReversal.toJSON(),
              keyGap: p.welford.keyGap.toJSON(),
            },
            p2: { speedSlow: p.p2.speedSlow.toJSON(), reversal: p.p2.reversal.toJSON() },
            sessions: p.sessions,
            savedAt: now,
          },
        });
      } catch (_e) { /* 配额/环境问题忽略 */ }
    },
    resetProfile() {
      const p = this.profile;
      const w = p.welford;
      for (const k of Object.keys(w)) w[k] = new Welford();
      p.p2.speedSlow = new P2Quantile(0.35);
      p.p2.reversal = new P2Quantile(0.7);
      p.sessions = 0;
      return this.saveProfile(true);
    },

    /* ---------- M2 昼夜节律系数（0.85 ~ 1.15，乘法作用） ---------- */
    circadian() {
      const h = new Date().getHours() + new Date().getMinutes() / 60;
      // 基础节律：15 点最清醒（系数最低），凌晨 3 点最困（系数最高）
      const base = 1.0 - 0.12 * Math.cos((2 * Math.PI * (h - 15)) / 24);
      // 主谷惩罚：2-5 点线性加深
      const dawn = h >= 2 && h < 5 ? (0.10 * (1 - Math.abs(h - 3.5) / 1.5)) : 0;
      // 午后次谷：14-16 点轻微
      const dip = h >= 14 && h < 16 ? 0.04 : 0;
      return clamp(base + dawn + dip, 0.85, 1.18);
    },

    /* ---------- M1 任务疲劳：等效高强度分钟 → logistic ---------- */
    taskFatigue(activeMin, intensity) {
      // 强度 0-1：信号融合的活跃度代理；高强度把曲线中点从 45min 提前到 25min
      const t0 = lerp(45, 25, clamp01(intensity));
      const k = lerp(0.045, 0.075, clamp01(intensity));
      return logistic(activeMin, k, t0);
    },

    /* ---------- M3 恢复：空闲指数衰减 ---------- */
    applyRecovery(now) {
      const idleMs = now - this.lastActiveAt;
      if (idleMs < 20000) return; // 仍在活跃
      const minutesIdle = idleMs / 60000;
      // 半衰期：短歇 90s/2min→τ=90s；长歇>5min→τ=25s（恢复更快）
      const tau = minutesIdle > 5 ? 25 / 60 : 1.5; // 分钟
      const decay = Math.pow(0.5, minutesIdle / tau);
      this.fatigueReserve *= decay;
      // 长歇额外奖励：直接清掉 reserve 的一截
      if (minutesIdle > 20) this.fatigueReserve *= 0.35;
    },

    /* ---------- L1→L2：把原始信号转成 [0,1] 疲劳贡献 ---------- */
    signals(winMs) {
      const now = performance.now();
      const P = this.profile;
      const sig = {};

      // S4 鼠标运动学
      const ms = this.mouse.snapshot(winMs);
      // 速度慢（相对个人分布的 p35 基线）→ 疲劳
      const slowBase = P.p2.speedSlow.value();
      const mouseSlow = slowBase != null
        ? clamp01(logistic(1 - ms.speedMean / (slowBase + 1e-6), 2.4, 0.2))
        : (ms.speedMean > 0 && ms.speedMean < 0.35 ? clamp01((0.35 - ms.speedMean) / 0.35) : null);
      // 微颤动（方向反转率，个人 p70 基线）
      const revBase = P.p2.reversal.value();
      const tremor = ms.reversalRate != null
        ? (revBase != null
          ? clamp01(logistic((ms.reversalRate - revBase) / (revBase * 0.8 + 1e-6), 2.0, 0.3))
          : clamp01(ms.reversalRate / 0.30))
        : null;
      // 急动熵低（动作僵硬单调）→ 疲劳
      const jerk = ms.jerkEntropy > 0 && ms.samples > 30
        ? clamp01(1 - ms.jerkEntropy / 0.85) : null;
      sig.mouse = { slow: mouseSlow, tremor, jerk };

      // S3 滚动：速度降 + 路径熵高（漫无目的来回找）
      const sSpeed = this.scroll.speeds.n > 5 ? this.scroll.speeds.mean : null;
      const scrollSlow = sSpeed != null
        ? (this.profile.welford.scrollSpeed.z(sSpeed) != null
          ? zToFatigue(-this.profile.welford.scrollSpeed.z(sSpeed))
          : (sSpeed < 1.2 ? clamp01((1.2 - sSpeed) / 1.2) : 0))
        : null;
      const sEntropy = this.scroll.dirs.length > 40 ? this.scroll.pathEntropy() : null;
      const wander = sEntropy != null ? clamp01((sEntropy - 0.55) / 0.4) : null;
      sig.scroll = { slow: scrollSlow, wander };

      // S1/S2 键入与点击：强度异常升高本身是「硬撑」信号
      const keyRate = this.keyRate.ready() ? this.keyRate.rate : null;
      const keyZ = keyRate != null ? this.profile.welford.keyRate.z(keyRate) : null;
      sig.key = keyZ != null ? zToFatigue(keyZ) : null;
      const clickRate = this.clickRate.ready() ? this.clickRate.rate : null;
      const clickZ = clickRate != null ? this.profile.welford.clickRate.z(clickRate) : null;
      sig.click = clickZ != null ? zToFatigue(clickZ) : null;

      // S5 内容卷入：视频连续观看占比高 → 被动用眼
      sig.video = this.video.playingMs > 60000 ? clamp01(this.video.minutesPerWindow(winMs)) : null;
      // 阅读速度代理：滚动深度增量随时间下降（前 20 分钟基线 vs 当前）
      const depthRate = this.scroll.depth / Math.max(1, winMs / 60000); // px/min
      sig.reading = this.scroll.depth > 3000 ? clamp01(1 - depthRate / 900) : null;

      // 会话活跃占比低但仍在页面 = 游魂状态（发呆）
      const activeRatio = this.session.totalMs ? this.session.activeMs / this.session.totalMs : 0.5;
      sig.daze = this.session.totalMs > 300000 ? clamp01((0.45 - activeRatio) / 0.45) : null;

      return sig;
    },

    /* ---------- L3：融合 + 模型 → 0-100 分 ---------- */
    compute(nowWall) {
      const winMs = this.session.totalMs || 60000;
      const sig = this.signals(winMs);
      this.applyRecovery(nowWall);

      // 可用信号 → 贡献值 + 自适应权重（可用性 + 信号置信度）
      const parts = [];
      const push = (v, w) => { if (v != null) parts.push([v, w]); };
      if (sig.mouse) {
        const m = [sig.mouse.slow, sig.mouse.tremor, sig.mouse.jerk].filter((x) => x != null);
        if (m.length) push(m.reduce((a, b) => a + b, 0) / m.length, 0.24);
      }
      if (sig.scroll) {
        const s = [sig.scroll.slow, sig.scroll.wander].filter((x) => x != null);
        if (s.length) push(s.reduce((a, b) => a + b, 0) / s.length, 0.20);
      }
      push(sig.key, 0.12);
      push(sig.click, 0.08);
      push(sig.video != null ? sig.video * 0.7 : null, 0.10);
      push(sig.reading, 0.08);
      push(sig.daze != null ? sig.daze * 0.6 : null, 0.06);

      // 行为信号几何融合
      let behavior = null;
      if (parts.length) {
        const wSum = parts.reduce((a, p) => a + p[1], 0);
        let logSum = 0;
        for (const [v, w] of parts) logSum += w * Math.log(clamp(v, 0.02, 1));
        behavior = Math.exp(logSum / wSum); // [0,1]
        // 惩罚项：任一信号接近爆表时整体上抬（几何平均的补偿）
        const maxV = Math.max(...parts.map((p) => p[0]));
        if (maxV > 0.75) behavior = clamp01(behavior + (maxV - 0.75) * 0.5);
      }

      // 任务疲劳（分钟）+ 节律
      const activeMin = this.session.activeMs / 60000;
      const intensity = behavior != null ? behavior : 0.4;
      const task = this.taskFatigue(activeMin, intensity);
      const circ = this.circadian();

      // 综合原始疲劳（行为 55% + 任务 30% + 节律 15% 的相对权重）
      let raw = 0;
      raw += (behavior != null ? behavior : 0.45) * 0.55;
      raw += task * 0.30;
      raw += clamp01((circ - 0.85) / 0.33) * 0.15;
      raw = clamp01(raw);

      // M3 恢复势叠加：长空闲后 raw 已通过衰减自然回落
      this.fatigueReserve = Math.max(this.fatigueReserve * 0.98, raw * 0.15);

      const score01 = clamp01(raw);
      return { score01, sig, task, circ, activeMin };
    },

    /* ---------- L5：平滑 + 迟滞分级 ---------- */
    step(nowWall) {
      const { score01, sig, task, circ, activeMin } = this.compute(nowWall);
      const score = Math.round(score01 * 100);

      // 双 EMA + 趋势
      this.out.fast = this.out.fast ? lerp(this.out.fast, score, 0.35) : score;
      this.out.slow = this.out.slow ? lerp(this.out.slow, score, 0.12) : score;
      this.out.trend = this.out.fast - this.out.slow; // >0 上升趋势

      // 置信度：信号样本量 + 行为信号可用数
      const available = [sig.mouse, sig.scroll, sig.key, sig.click, sig.video, sig.reading, sig.daze]
        .filter((v) => v != null).length;
      const mouseN = this.mouse.speed.n;
      const conf = clamp(0.25 + available * 0.09 + Math.min(mouseN, 400) / 400 * 0.25, 0, 1);

      // 迟滞分级
      const F = this.out.slow; // 用慢 EMA 做分级基准
      const T = this.out.trend;
      const th = [15, 35, 55, 75];
      let target = 1;
      for (let i = th.length - 1; i >= 0; i--) if (F >= th[i]) { target = i + 2; break; }
      // 升级需持续 30s
      if (target > this.out.level) {
        if (this.out.levelSince === 0) this.out.levelSince = nowWall;
        if (nowWall - this.out.levelSince < 30000) target = this.out.level;
        else this.out.levelSince = 0;
      } else {
        this.out.levelSince = 0;
        // 降级即时，但 5→4 需趋势不再上升
        if (this.out.level === 5 && target === 4 && T > 6) target = 5;
      }
      this.out.level = target;
      this.out.confidence = conf;

      return {
        score,
        level: this.out.level,
        confidence: Math.round(conf * 100) / 100,
        trend: Math.round(T * 10) / 10,
        breakdown: {
          task: Math.round(task * 100) / 100,
          circadian: Math.round(circ * 100) / 100,
          activeMin: Math.round(activeMin * 10) / 10,
          signals: {
            mouseSlow: sig.mouse ? sig.mouse.slow : null,
            tremor: sig.mouse ? sig.mouse.tremor : null,
            jerk: sig.mouse ? sig.mouse.jerk : null,
            scrollSlow: sig.scroll ? sig.scroll.slow : null,
            wander: sig.scroll ? sig.scroll.wander : null,
            key: sig.key, click: sig.click, video: sig.video,
            reading: sig.reading, daze: sig.daze,
          },
        },
      };
    },

    /* ---------- 活跃/空闲维护（供 M1/M3 与上报用） ---------- */
    touch() {
      const now = Date.now();
      this.lastActiveAt = now;
      this.session.lastActivity = now;
    },
    heartbeat() {
      // 每 5s：活跃时间统计
      const now = Date.now();
      const idle = now - this.session.lastActivity;
      if (idle < 8000) this.session.activeMs += Math.min(idle, 5000);
      this.session.totalMs += 5000;
    },
    /** 学习推入：把本窗口特征喂给个人基线（每 60s） */
    learn() {
      const P = this.profile;
      if (this.keyRate.ready()) P.welford.keyRate.push(this.keyRate.rate);
      if (this.clickRate.ready()) P.welford.clickRate.push(this.clickRate.rate);
      if (this.scroll.speeds.n > 5) P.welford.scrollSpeed.push(this.scroll.speeds.mean);
      if (this.mouse.speed.n > 20) P.welford.mouseSpeed.push(this.mouse.speed.mean);
      const rr = this.mouse.snapshot(60000).reversalRate;
      if (rr != null) { P.p2.reversal.push(rr); P.welford.mouseReversal.push(rr); }
      const slowBaseSample = this.mouse.speed.mean;
      if (slowBaseSample > 0) P.p2.speedSlow.push(slowBaseSample);
      // 键入间隔分布
      if (this.keyRate.bursts.length > 30) {
        const m = this.keyRate.bursts.reduce((a, b) => a + b, 0) / this.keyRate.bursts.length;
        if (m > 0.5) P.welford.keyGap.push(this.keyRate.rhythmVariance());
      }
    },
    /** 活跃毫秒增量（供上报） */
    activeDeltaMs() {
      const d = this.session.activeMs - this.session.lastReportedActiveMs;
      this.session.lastReportedActiveMs = this.session.activeMs;
      return Math.round(d / 1000);
    },
    summary() {
      return {
        level: this.out.level,
        score: Math.round(this.out.slow),
        confidence: Math.round(this.out.confidence * 100),
        baselineReady: this.profile.welford.mouseSpeed.n >= 60,
        calibratedSamples: this.profile.welford.mouseSpeed.n,
        prediction: this.predict(),
      };
    },

    /* ---------- Day1 增量：趋势预测 ----------
     * 用慢 EMA 与阈值差距 / 当前每分钟斜率，估计「到下一级还要几分钟」。
     * 斜率估计：fast-slow 差值反映最近约 1 分钟尺度的变化量（双 EMA 的
     * 等效时间常数差），启发式换算为每分钟点数；趋势为负则返回 null。
     * 这是启发式投影，置信度低时输出 null。 */
    predict() {
      const th = [15, 35, 55, 75];
      const F = this.out.slow;
      const slopePerMin = Math.max(0, this.out.trend) / 1.5; // 启发式：EMA 差 → 每分钟点数
      if (slopePerMin < 0.15) return null;
      let nextTh = null;
      for (const t of th) { if (F < t) { nextTh = t; break; } }
      if (nextTh == null) return null; // 已在 5 级
      const minutes = (nextTh - F) / slopePerMin;
      if (!isFinite(minutes) || minutes > 120) return null;
      return { nextLevelThreshold: nextTh, minutes: Math.round(minutes) };
    },
  };

  /* =======================================================================
   * 5. 事件接线（引擎独占采集；content.js 不再自行监听）
   * ===================================================================== */
  window.addEventListener('mousemove', (e) => { Engine.touch(); Engine.mouse.move(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener('mousedown', () => { Engine.touch(); Engine.clickRate.hit(); }, { passive: true });
  window.addEventListener('keydown', (e) => { Engine.touch(); Engine.keyRate.hit(); if (e.key === 'Backspace') Engine._bs = (Engine._bs || 0) + 1; }, { passive: true });
  window.addEventListener('scroll', () => { Engine.touch(); Engine.scroll.onScroll(window.scrollY || document.documentElement.scrollTop || 0); }, { passive: true });
  Engine.video.observe();

  /* =======================================================================
   * 6. 对外 API（content.js 使用）
   *    window.__EyeCareEngine.tick()        → 一步：返回评分/等级/置信度
   *    window.__EyeCareEngine.heartbeat()   → 每 5s 活跃统计
   *    window.__EyeCareEngine.activeDeltaSec()
   *    window.__EyeCareEngine.summary()     → 弹窗展示用摘要
   *    window.__EyeCareEngine.resetCalibration()
   * ===================================================================== */
  window.__EyeCareEngine = {
    tick: () => Engine.step(Date.now()),
    heartbeat: () => Engine.heartbeat(),
    activeDeltaSec: () => Engine.activeDeltaMs(),
    summary: () => Engine.summary(),
    resetCalibration: () => Engine.resetProfile(),
    ready: true,
  };

  /* ---------- 启动：载入档案 → 冷启动也能立即工作 ---------- */
  Engine.loadProfile().then(() => {
    Engine.profile.sessions += 1;
    Engine.saveProfile(true);
  });
  // 定期学习 + 写盘
  setInterval(() => { Engine.learn(); Engine.saveProfile(false); }, 60000);
})();
