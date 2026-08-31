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

  /** Welford 合并（Chan et al. 并行算法）：把批次 b 并入 a */
  function welfordMerge(a, b) {
    if (!a || a.n === 0) return new Welford(b.n, b.mean, b.m2);
    if (!b || b.n === 0) return new Welford(a.n, a.mean, a.m2);
    const n = a.n + b.n;
    const d = b.mean - a.mean;
    return new Welford(n, a.mean + (d * b.n) / n, a.m2 + b.m2 + (d * d * a.n * b.n) / n);
  }

  /** Welford 增量提取：cur 相对 prev 的新增样本批次（合并的逆运算）。
   *  多标签页档案合并用：每个页面只应贡献「自上次写盘以来的增量」，
   *  否则同一份样本会被反复合并进存储，均值被稀释、样本量虚高。 */
  function welfordDelta(prev, cur) {
    const nB = cur.n - prev.n;
    if (nB <= 0) return null; // 无新增（或被重置，由调用方特判）
    if (prev.n === 0) return new Welford(cur.n, cur.mean, cur.m2);
    const meanB = (cur.n * cur.mean - prev.n * prev.mean) / nB;
    const dm = prev.mean - meanB;
    const m2B = Math.max(0, cur.m2 - prev.m2 - ((prev.n * nB) / cur.n) * dm * dm);
    return new Welford(nB, meanB, m2B);
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
      this.lastX = 0; this.lastY = 0; this.lastT = 0;
      this.lastSpeed = 0; this.lastAngle = null;
      this.reversals = 0; this.moves = 0;
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
    /** 每分钟窗口统计（纯读取，无副作用）——评分路径必须用 peek */
    peek() {
      return {
        speedMean: this.speed.mean,
        speedStd: this.speed.std,
        reversalRate: this.moves > 20 ? this.reversals / this.moves : null,
        jerkEntropy: shannonEntropy(this.jerkBins),
        samples: this.speed.n,
      };
    }
    /** 每分钟快照并清零窗口计数——只有 learn() 拥有窗口边界的重置权。
     * 历史 bug：评分路径（signals→compute）也调用本方法，与 learn() 互相
     * 清零计数，导致 reversalRate 恒为 null、微颤动信号长期失效。 */
    snapshot() {
      const out = this.peek();
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

  /* ---------- Day2 增量：内容类型自适应权重 ----------
   * 动机：同样的信号在不同页面里含义相反。
   *   - 代码页上「持续高速键入」是正常工作，不是硬撑；
   *   - 长文页上「来回滚动」是扫读，不是漫无目的；
   *   - 表格页上「频繁点击」是切筛选，不是躁动。
   * 因此同一份信号在不同页面应走不同的权重表 + 不同的分级阈值。
   *
   * 两层调节：
   *   ① PAGE_WEIGHTS      融合权重（各类信号在总分里的占比）
   *   ② PAGE_SIGNAL_SCALE 信号折减（该类页面里「本就正常」的动作打折扣，
   *                       折算后再进入几何融合，避免把工作节奏当成疲劳）
   *   ③ PAGE_THRESHOLD_SHIFT 分级阈值偏移（持续专注型页面放宽升级条件）
   */
  const PAGE_WEIGHTS = {
    code:    { mouse: 0.16, scroll: 0.16, key: 0.20, click: 0.06, video: 0.04, reading: 0.10, daze: 0.06 },
    article: { mouse: 0.28, scroll: 0.26, key: 0.08, click: 0.08, video: 0.10, reading: 0.10, daze: 0.06 },
    table:   { mouse: 0.24, scroll: 0.24, key: 0.12, click: 0.10, video: 0.06, reading: 0.06, daze: 0.06 },
    generic: { mouse: 0.24, scroll: 0.20, key: 0.12, click: 0.08, video: 0.10, reading: 0.08, daze: 0.06 },
  };
  const PAGE_SIGNAL_SCALE = {
    code:    { wander: 0.80, key: 0.60, click: 0.90, daze: 1.00 },
    article: { wander: 0.70, key: 1.00, click: 1.00, daze: 1.10 },
    table:   { wander: 0.85, key: 0.90, click: 0.70, daze: 1.00 },
    generic: { wander: 1.00, key: 1.00, click: 1.00, daze: 1.00 },
  };
  // code 页持续专注最长，放宽最多；长文慢读次之；表格页轻微
  const PAGE_THRESHOLD_SHIFT = { code: 3, article: 2, table: 1, generic: 0 };
  const PAGE_CACHE_MS = 60000; // 页面类型检测缓存（DOM 扫描不必每 tick 都做）
  const PAGE_SCAN_CAP = 400;   // 单类元素最多统计 400 个，防止超长页面卡顿

  const PAGE_LABEL = { code: '代码', article: '长文', table: '表格', generic: '通用' };

  /* ---------- Day8：爆表信号源 → 针对性休息动作 ----------
   * 光说「你累了」没用，得说清「你是哪种累」：
   * 鼠标僵、滚动乱、打字猛、看得久，对应的恢复动作完全不同。 */
  const SIGNAL_ADVICE = {
    mouse: { label: '鼠标动作变慢变僵', action: '放下鼠标，手腕画圈 10 次，再看 6 米外 20 秒' },
    scroll: { label: '滚动开始来回打转', action: '先写下你要找什么，再决定还找不找' },
    key: { label: '打字节奏异常', action: '停手 1 分钟：握拳—张开 10 次，松一松肩颈' },
    click: { label: '点击变得频繁', action: '关掉多余的标签页，只留一个当前任务' },
    video: { label: '连续被动看视频', action: '起身走动 3 分钟，剩下的明天倍速看' },
    reading: { label: '阅读速度下滑', action: '闭眼 30 秒，再刻意眨眼 10 次润一下眼' },
    daze: { label: '人在心不在', action: '承认走神：换个简单小任务，或真的休息 5 分钟' },
  };

  /** 生成针对性休息建议（3 级以下不打扰；最多给两条，避免又长又不做） */
  function restAdvice(top, level, activeMin, circ) {
    if (level < 3) return null;
    const parts = [];
    if (circ >= 1.05) parts.push('现在是昼夜节律低谷，硬撑不如小睡 20 分钟');
    if (activeMin >= 45) parts.push(`已连续 ${Math.round(activeMin)} 分钟，起身接杯水走动 2 分钟`);
    if (top && SIGNAL_ADVICE[top.key]) {
      const a = SIGNAL_ADVICE[top.key];
      parts.push(`主要是「${a.label}」（占 ${Math.round(top.share * 100)}%）——${a.action}`);
    }
    return parts.length ? parts.slice(0, 2).join('；') : null;
  }

  /**
   * 页面类型检测：DOM 结构特征 + 编辑器特征 + 文本体量，返回类型与判定依据。
   * 判定顺序 code → table → article → generic（越具体的形态优先）。
   */
  function detectPageType() {
    const d = { editor: false, codeNodes: 0, codeChars: 0, tables: 0, cells: 0, paras: 0, textChars: 0 };
    try {
      // ① 在线编辑器：命中即铁证（Monaco / CodeMirror / Ace / 高亮容器）
      d.editor = !!document.querySelector(
        '.monaco-editor, .CodeMirror, .cm-content, .cm-editor, .ace_editor, .view-lines, [data-mode-id]'
      );
      // ② 代码节点：数「块」不够（一行一 <code> 也会虚高），同时统计字符量
      const codeNodes = document.querySelectorAll('pre, code');
      d.codeNodes = codeNodes.length;
      for (let i = 0; i < Math.min(codeNodes.length, PAGE_SCAN_CAP); i++) {
        d.codeChars += (codeNodes[i].textContent || '').length;
      }
      // ③ 表格：单元格数比表格数更能区分「数据表」与「排版用 table」
      const tables = document.querySelectorAll('table');
      d.tables = tables.length;
      for (let i = 0; i < Math.min(tables.length, 40); i++) {
        d.cells += tables[i].querySelectorAll('td, th').length;
      }
      // ④ 长文：段落数 + 正文字符量
      const paras = document.querySelectorAll('p');
      d.paras = paras.length;
      for (let i = 0; i < Math.min(paras.length, PAGE_SCAN_CAP); i++) {
        d.textChars += (paras[i].textContent || '').length;
      }
    } catch (_e) { /* 极端 DOM 异常时按 generic 兜底 */ }

    let type = 'generic';
    let reason = '未匹配到明确形态';
    if (d.editor || d.codeNodes > 8 || d.codeChars > 3000) {
      type = 'code';
      reason = d.editor ? '检测到在线代码编辑器'
        : `代码块 ${d.codeNodes} 处 / ${d.codeChars} 字符`;
    } else if (d.cells > 120 || d.tables > 3) {
      type = 'table';
      reason = `表格 ${d.tables} 个 / 单元格 ${d.cells} 个`;
    } else if (d.paras > 20 || d.textChars > 3000) {
      type = 'article';
      reason = `正文 ${d.paras} 段 / ${d.textChars} 字符`;
    }
    return { type, reason, detail: d };
  }

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
      // Backlog：等级转移计数 trans[from*5+to]（5×5 扁平成 25 长度）
      markov: { trans: new Array(25).fill(0), samples: 0 },
      sessions: 0,
      savedAt: 0,
    },

    // —— L5 输出状态 ——
    out: { fast: 0, slow: 0, trend: 0, level: 1, levelSince: 0, confidence: 0 },

    // —— 恢复状态 ——
    fatigueReserve: 0, // M3 恢复模型内部状态：未衰减完的疲劳势
    lastActiveAt: Date.now(),

    /* ---------- 档案持久化 ---------- */
    _serializeProfile() {
      const p = this.profile;
      return {
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
        markov: { trans: p.markov.trans.slice(), samples: p.markov.samples },
        sessions: p.sessions,
        savedAt: Date.now(),
      };
    },
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
          if (p.markov && Array.isArray(p.markov.trans) && p.markov.trans.length === 25) {
            this.profile.markov = { trans: p.markov.trans, samples: p.markov.samples || 0 };
          }
        }
      } catch (_e) { /* 档案损坏则冷启动 */ }
      // 合并基线：载入的存储态即「本页面已贡献过的部分」
      this._lastSaved = this._serializeProfile();
    },
    /* 多标签页读-合并-写：每个页面只合并「自上次写盘以来的增量」。
     * 直接整写会让多开的标签页互相覆盖同一份档案（旧 bug：
     * 个性化基线在多开场景下不可靠）。无跨标签互斥锁可用，
     * 10 分钟节流写盘下并发冲突概率极低，残留竞争可接受。 */
    async saveProfile(force) {
      const now = Date.now();
      if (!force && now - this.profile.savedAt < SAVE_EVERY_MS) return;
      this.profile.savedAt = now;
      const p = this.profile;
      const prev = this._lastSaved;
      try {
        const r = await chrome.storage.local.get({ [PROFILE_KEY]: null });
        const stored = r[PROFILE_KEY];
        let out;
        if (!stored || !stored.welford || !prev) {
          out = this._serializeProfile();
        } else {
          const welford = {};
          for (const k of Object.keys(p.welford)) {
            const cur = p.welford[k];
            const pv = prev.welford[k] || { n: 0, mean: 0, m2: 0 };
            if (cur.n < pv.n) {
              // 本地档案被 resetProfile 清零：以本地为准覆盖存储
              welford[k] = cur.toJSON();
            } else {
              const delta = welfordDelta(Welford.from(pv), cur);
              welford[k] = delta
                ? welfordMerge(Welford.from(stored.welford[k] || { n: 0 }), delta).toJSON()
                : (stored.welford[k] || cur.toJSON());
            }
          }
          // P² 分位器算法上不支持合并：保留样本量更大的一方（被打回冷启动时以本地为准）
          const pickP2 = (key) => {
            const cur = p.p2[key].toJSON();
            const st = stored.p2 && stored.p2[key];
            const pvN = prev.p2 && prev.p2[key] ? prev.p2[key].n || 0 : 0;
            if (cur.n < pvN) return cur; // 本地重置
            return st && (st.n || 0) > cur.n ? st : cur;
          };
          // 马尔可夫：按增量累加转移计数；本地重置（负增量）则覆盖
          const stM = stored.markov && Array.isArray(stored.markov.trans) && stored.markov.trans.length === 25
            ? stored.markov : { trans: new Array(25).fill(0), samples: 0 };
          const pvM = prev.markov || { trans: new Array(25).fill(0), samples: 0 };
          let markov;
          if (p.markov.samples < pvM.samples) {
            markov = { trans: p.markov.trans.slice(), samples: p.markov.samples };
          } else {
            const trans = stM.trans.map((v, i) => v + Math.max(0, p.markov.trans[i] - (pvM.trans[i] || 0)));
            markov = { trans, samples: stM.samples + Math.max(0, p.markov.samples - pvM.samples) };
          }
          const sessions = p.sessions < prev.sessions
            ? p.sessions
            : (stored.sessions || 0) + Math.max(0, p.sessions - prev.sessions);
          out = {
            welford,
            p2: { speedSlow: pickP2('speedSlow'), reversal: pickP2('reversal') },
            markov,
            sessions,
            savedAt: now,
          };
        }
        await chrome.storage.local.set({ [PROFILE_KEY]: out });
        this._lastSaved = this._serializeProfile();
      } catch (_e) { /* 配额/环境问题忽略 */ }
    },
    resetProfile() {
      const p = this.profile;
      const w = p.welford;
      for (const k of Object.keys(w)) w[k] = new Welford();
      p.p2.speedSlow = new P2Quantile(0.35);
      p.p2.reversal = new P2Quantile(0.7);
      p.markov = { trans: new Array(25).fill(0), samples: 0 };
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

      // S4 鼠标运动学（peek 纯读取；窗口计数由 learn() 统一重置）
      const ms = this.mouse.peek();
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
      // Day8：顺带记下信号名，用于「这次到底是谁把分数顶上去的」归因
      const parts = [];
      const push = (v, w, name) => { if (v != null) parts.push([v, w, name]); };
      // Day2：页面类型检测（缓存 60s）→ 自适应权重表 + 信号折减
      const nowP = Date.now();
      if (!this.pageInfo || nowP - (this.pageTypeAt || 0) > PAGE_CACHE_MS) {
        this.pageInfo = detectPageType();
        this.pageType = this.pageInfo.type;
        this.pageTypeAt = nowP;
      }
      const PW = PAGE_WEIGHTS[this.pageType] || PAGE_WEIGHTS.generic;
      const PS = PAGE_SIGNAL_SCALE[this.pageType] || PAGE_SIGNAL_SCALE.generic;
      if (sig.mouse) {
        const m = [sig.mouse.slow, sig.mouse.tremor, sig.mouse.jerk].filter((x) => x != null);
        if (m.length) push(m.reduce((a, b) => a + b, 0) / m.length, PW.mouse, 'mouse');
      }
      if (sig.scroll) {
        // wander 在该类页面里可能是正常动作（长文扫读 / 代码跳转），按类型折减
        const slow = sig.scroll.slow;
        const wander = sig.scroll.wander != null ? sig.scroll.wander * PS.wander : null;
        const s = [slow, wander].filter((x) => x != null);
        if (s.length) push(s.reduce((a, b) => a + b, 0) / s.length, PW.scroll, 'scroll');
      }
      push(sig.key != null ? sig.key * PS.key : null, PW.key, 'key');
      push(sig.click != null ? sig.click * PS.click : null, PW.click, 'click');
      push(sig.video != null ? sig.video * 0.7 : null, PW.video, 'video');
      push(sig.reading, PW.reading, 'reading');
      push(sig.daze != null ? sig.daze * 0.6 * PS.daze : null, PW.daze, 'daze');

      // 行为信号几何融合
      let behavior = null;
      let topSignal = null;
      if (parts.length) {
        const wSum = parts.reduce((a, p) => a + p[1], 0);
        let logSum = 0;
        for (const [v, w] of parts) logSum += w * Math.log(clamp(v, 0.02, 1));
        behavior = Math.exp(logSum / wSum); // [0,1]
        // 惩罚项：任一信号接近爆表时整体上抬（几何平均的补偿）
        const maxV = Math.max(...parts.map((p) => p[0]));
        if (maxV > 0.75) behavior = clamp01(behavior + (maxV - 0.75) * 0.5);
        /* Day8：信号归因。几何平均的对数可加，
         * 因此 log(behavior) = Σ wᵢ·log vᵢ / Σ wᵢ 中每一项的占比可以精确拆分；
         * log v 全为负，占比 ∈ [0,1] 且总和为 1 —— 这不是拍脑袋的权重显示，
         * 而是「这一分里各信号各占多少」的真实归因。 */
        if (logSum < -1e-9) {
          let bestShare = -1;
          for (const [v, w, name] of parts) {
            const share = (w * Math.log(clamp(v, 0.02, 1))) / logSum;
            if (share > bestShare) {
              bestShare = share;
              topSignal = { key: name, label: SIGNAL_ADVICE[name] ? SIGNAL_ADVICE[name].label : name, value: Math.round(v * 100) / 100, share: Math.round(share * 100) / 100 };
            }
          }
        }
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
      return { score01, sig, task, circ, activeMin, topSignal };
    },

    /* ---------- L5：平滑 + 迟滞分级 ---------- */
    step(nowWall) {
      const { score01, sig, task, circ, activeMin, topSignal } = this.compute(nowWall);
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

      // 迟滞分级（Day2：阈值按页面类型偏移，code 页放宽 3 分）
      const F = this.out.slow; // 用慢 EMA 做分级基准
      const T = this.out.trend;
      const shift = PAGE_THRESHOLD_SHIFT[this.pageType] || 0;
      const th = [15 + shift, 35 + shift, 55 + shift, 75 + shift];
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

      /* Backlog：马尔可夫转移矩阵 —— 记录等级之间的真实跳变。
       * 与 predict() 的「线性外推」互补：外推只回答「按当前斜率几时到下一级」，
       * 转移矩阵回答「历史上从这个等级出发，实际最可能去哪」。 */
      const prevLevel = this.out.prevLevel || this.out.level;
      if (prevLevel !== this.out.level) {
        const M = this.profile.markov;
        M.trans[(prevLevel - 1) * 5 + (this.out.level - 1)] += 1;
        M.samples += 1;
      }
      this.out.prevLevel = this.out.level;
      // Day8：针对性休息建议（3 级以下为 null，不打扰）
      this.out.advice = restAdvice(topSignal, this.out.level, activeMin, circ);

      return {
        score,
        level: this.out.level,
        confidence: Math.round(conf * 100) / 100,
        trend: Math.round(T * 10) / 10,
        advice: this.out.advice,
        topSignal,
        breakdown: {
          pageType: this.pageType || 'generic',
          pageTypeLabel: PAGE_LABEL[this.pageType] || PAGE_LABEL.generic,
          pageTypeReason: this.pageInfo ? this.pageInfo.reason : '',
          thresholdShift: shift,
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

    /* ---------- Day6 增量：引擎自诊断 ----------
     * 检查各信号估计器的健康度：
     *   cold       样本不足（n < 12），基线尚未建立
     *   ok         正常工作
     *   degenerate 方差塌缩（std < 1e-4 且样本充足）——该信号失去区分度，
     *              融合时应视为不可用（由调用方按 status 过滤）
     * 输出用于弹窗「引擎状态」展示与保存到档案，方便排查误判来源。 */
    diagnostics() {
      const W = this.profile.welford;
      const check = (name, w) => {
        const std = w.std;
        let status = 'ok';
        if (w.n < 12) status = 'cold';
        else if (std < 1e-4) status = 'degenerate';
        return { name, n: w.n, mean: Math.round(w.mean * 1000) / 1000, std: Math.round(std * 10000) / 10000, status };
      };
      const signals = [
        check('keyRate', W.keyRate),
        check('clickRate', W.clickRate),
        check('scrollSpeed', W.scrollSpeed),
        check('mouseSpeed', W.mouseSpeed),
        check('mouseReversal', W.mouseReversal),
        check('keyGap', W.keyGap),
      ];
      const p2 = {
        speedSlow: { n: this.profile.p2.speedSlow.count(), ready: this.profile.p2.speedSlow.value() != null },
        reversal: { n: this.profile.p2.reversal.count(), ready: this.profile.p2.reversal.value() != null },
      };
      const okCount = signals.filter((s) => s.status === 'ok').length;
      return {
        signals,
        p2,
        health: okCount >= 4 ? 'good' : okCount >= 2 ? 'warming' : 'cold',
        pageType: this.pageType || 'generic',
      };
    },

    /* ---------- Day2：页面类型信息（供 content.js 渲染与弹窗展示） ----------
     * 复用缓存的判定结果，避免重复 DOM 扫描；缓存过期时顺带刷新。 */
    pageTypeInfo() {
      const nowP = Date.now();
      if (!this.pageInfo || nowP - (this.pageTypeAt || 0) > PAGE_CACHE_MS) {
        this.pageInfo = detectPageType();
        this.pageType = this.pageInfo.type;
        this.pageTypeAt = nowP;
      }
      return {
        type: this.pageType,
        label: PAGE_LABEL[this.pageType] || PAGE_LABEL.generic,
        reason: this.pageInfo.reason,
        detail: this.pageInfo.detail,
        weights: PAGE_WEIGHTS[this.pageType] || PAGE_WEIGHTS.generic,
        scale: PAGE_SIGNAL_SCALE[this.pageType] || PAGE_SIGNAL_SCALE.generic,
        thresholdShift: PAGE_THRESHOLD_SHIFT[this.pageType] || 0,
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
      const rr = this.mouse.snapshot().reversalRate;
      if (rr != null) { P.p2.reversal.push(rr); P.welford.mouseReversal.push(rr); }
      const slowBaseSample = this.mouse.speed.mean;
      if (slowBaseSample > 0) P.p2.speedSlow.push(slowBaseSample);
      // 键入间隔分布
      if (this.keyRate.bursts.length > 30) {
        const m = this.keyRate.bursts.reduce((a, b) => a + b, 0) / this.keyRate.bursts.length;
        if (m > 0.5) P.welford.keyGap.push(this.keyRate.rhythmVariance());
      }
    },
    /** 活跃毫秒增量（供上报）。注意：返回真实毫秒。
     * 历史 bug：曾返回秒（d/1000）却命名为 Ms，background 再按毫秒换算，
     * 导致护眼时长统计缩小 60 倍。 */
    activeDeltaMs() {
      const d = this.session.activeMs - this.session.lastReportedActiveMs;
      this.session.lastReportedActiveMs = this.session.activeMs;
      return Math.round(d);
    },
    summary() {
      return {
        level: this.out.level,
        score: Math.round(this.out.slow),
        confidence: Math.round(this.out.confidence * 100),
        baselineReady: this.profile.welford.mouseSpeed.n >= 60,
        calibratedSamples: this.profile.welford.mouseSpeed.n,
        prediction: this.predict(),
        diagnostics: this.diagnostics(),
        markov: this.markov(),
        advice: this.out.advice || null,
      };
    },

    /* ---------- Day1 增量：趋势预测 ----------
     * 用慢 EMA 与阈值差距 / 当前每分钟斜率，估计「到下一级还要几分钟」。
     * 斜率估计：fast-slow 差值反映最近约 1 分钟尺度的变化量（双 EMA 的
     * 等效时间常数差），启发式换算为每分钟点数；趋势为负则返回 null。
     * 这是启发式投影，置信度低时输出 null。 */
    predict() {
      // Day2：与分级保持一致，阈值按当前页面类型偏移
      const shift = PAGE_THRESHOLD_SHIFT[this.pageType] || 0;
      const th = [15 + shift, 35 + shift, 55 + shift, 75 + shift];
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

    /* ---------- Backlog：马尔可夫链（等级跳变建模） ----------
     * 状态 = 疲劳等级 1..5，转移计数由 step() 累积。
     * 两个输出：
     *   ① next        从当前等级出发，历史上最可能去的下一等级及其概率
     *   ② stationary  转移矩阵的稳态分布（幂迭代 60 轮），
     *                 即「长期使用下，你停留在各等级的时间占比」
     * 高等级占比（4+5）可以直接回答「我是不是经常累到 4 级以上」。 */
    markov() {
      const M = this.profile.markov;
      const rowSum = (i) => {
        let s = 0;
        for (let j = 0; j < 5; j++) s += M.trans[i * 5 + j];
        return s;
      };
      const cur = clamp(this.out.level, 1, 5) - 1;
      const total = rowSum(cur);
      let next = null;
      if (total > 0) {
        let bestJ = 0; let bestC = -1;
        for (let j = 0; j < 5; j++) {
          const c = M.trans[cur * 5 + j];
          if (c > bestC) { bestC = c; bestJ = j; }
        }
        next = { level: bestJ + 1, p: Math.round((bestC / total) * 100) / 100, samples: total };
      }
      // 稳态分布：无出边的行视为吸收态（概率留在原地）
      let v = [0.2, 0.2, 0.2, 0.2, 0.2];
      for (let it = 0; it < 60; it++) {
        const nv = new Array(5).fill(0);
        for (let i = 0; i < 5; i++) {
          const rs = rowSum(i);
          if (rs <= 0) { nv[i] += v[i]; continue; }
          for (let j = 0; j < 5; j++) nv[j] += v[i] * (M.trans[i * 5 + j] / rs);
        }
        const s = nv.reduce((a, b) => a + b, 0) || 1;
        v = nv.map((x) => x / s);
      }
      return {
        samples: M.samples,
        current: this.out.level,
        next,
        stationary: v.map((x) => Math.round(x * 100) / 100),
        highRatio: Math.round((v[3] + v[4]) * 100),
      };
    },
  };

  /* =======================================================================
   * 5. 事件接线（引擎独占采集；content.js 不再自行监听）
   * ===================================================================== */
  window.addEventListener('mousemove', (e) => { Engine.touch(); Engine.mouse.move(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener('mousedown', () => { Engine.touch(); Engine.clickRate.hit(); }, { passive: true });
  window.addEventListener('keydown', (e) => { Engine.touch(); Engine.keyRate.hit(); }, { passive: true });
  window.addEventListener('scroll', () => { Engine.touch(); Engine.scroll.onScroll(window.scrollY || document.documentElement.scrollTop || 0); }, { passive: true });
  Engine.video.observe();

  /* =======================================================================
   * 6. 对外 API（content.js 使用）
   *    window.__EyeCareEngine.tick()        → 一步：返回评分/等级/置信度
   *    window.__EyeCareEngine.heartbeat()   → 每 5s 活跃统计
   *    window.__EyeCareEngine.activeDeltaMs() → 活跃毫秒增量（真实毫秒）
   *    window.__EyeCareEngine.summary()     → 弹窗展示用摘要
   *    window.__EyeCareEngine.resetCalibration()
   * ===================================================================== */
  window.__EyeCareEngine = {
    tick: () => Engine.step(Date.now()),
    heartbeat: () => Engine.heartbeat(),
    activeDeltaMs: () => Engine.activeDeltaMs(),
    summary: () => Engine.summary(),
    pageType: () => Engine.pageTypeInfo(),
    diagnostics: () => Engine.diagnostics(),
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
