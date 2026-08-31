/* -------------------------------------------------------------------------
 * modules/realestate.js — 房地产开发（隐藏工具集，密码解锁）
 * 三件套，全部纯本地计算，不联网、不存任何输入数据：
 *   ① 房贷计算  等额本息 / 等额本金，支持商贷 + 公积金组合贷
 *   ② 交易税费  契税 / 增值税 / 个税（常见规则，城市差异见提示）
 *   ③ 租金回报  年化毛收益 / 静态回本年限
 * 面向办公场景：输入默认值即有合理结果，改一个数立即重算。
 * ------------------------------------------------------------------------- */

'use strict';

(function () {
  const HC = window.HC;
  const WAN = 10000;

  const fmtWan = (n) => (Math.round(n * 100) / 100).toLocaleString('zh-CN');
  const fmtMoney = (n) => Math.round(n).toLocaleString('zh-CN');
  const num = (el, fb) => {
    const v = parseFloat(el.value);
    return isFinite(v) ? v : fb;
  };

  HC.modules.realestate = {
    render(container) {
      const root = HC.el('div', { class: 'view' });

      const tabWrap = HC.el('div', { class: 'presets' });
      const body = HC.el('div', {});
      const TABS = [
        ['loan', '🏦 房贷计算', renderLoan],
        ['tax', '🧾 交易税费', renderTax],
        ['rent', '📈 租金回报', renderRent],
      ];
      let cur = 'loan';
      const btns = TABS.map(([k, label, fn]) => {
        const b = HC.el('button', {
          class: 'chip' + (k === cur ? ' active' : ''),
          text: label,
          onclick: () => {
            cur = k;
            btns.forEach((x, i) => x.className = 'chip' + (TABS[i][0] === cur ? ' active' : ''));
            body.innerHTML = '';
            fn(body);
          },
        });
        tabWrap.appendChild(b);
        return b;
      });

      root.appendChild(
        HC.el('div', { class: 'row glass', style: 'display:block;padding:12px;' }, [
          HC.el('div', { class: 'opt-name', text: '🏠 房地产开发工具' }),
          HC.el('div', { class: 'opt-desc', style: 'margin:4px 0 10px;',
            text: '房贷 / 税费 / 租金回报，全部本地计算，不联网、不保存任何输入。' }),
          tabWrap,
        ])
      );
      root.appendChild(body);
      container.appendChild(root);
      renderLoan(body);
    },
  };

  /* ============================ ① 房贷计算 ============================ */
  function renderLoan(body) {
    const amt = HC.el('input', { class: 'input', type: 'number', value: '200', min: '1' });        // 商贷（万）
    const gAmt = HC.el('input', { class: 'input', type: 'number', value: '0', min: '0' });         // 公积金（万）
    const years = HC.el('input', { class: 'input', type: 'number', value: '30', min: '1', max: '30' });
    const rCom = HC.el('input', { class: 'input', type: 'number', value: '3.6', step: '0.01' });   // 商贷年利率 %
    const rFund = HC.el('input', { class: 'input', type: 'number', value: '2.85', step: '0.01' }); // 公积金年利率 %
    const way = HC.el('select', { class: 'input' });
    [
      ['interest', '等额本息（月供固定）'],
      ['principal', '等额本金（月供递减）'],
    ].forEach(([v, l]) => way.appendChild(HC.el('option', { value: v, text: l })));

    const out = HC.el('div', { class: 'opt-list' });

    function calc() {
      const P1 = Math.max(0, num(amt, 0)) * WAN;
      const P2 = Math.max(0, num(gAmt, 0)) * WAN;
      const n = Math.max(1, Math.round(num(years, 30) * 12));
      const r1 = Math.max(0.0001, num(rCom, 3.6) / 100 / 12);
      const r2 = Math.max(0.0001, num(rFund, 2.85) / 100 / 12);
      const P = P1 + P2;
      out.innerHTML = '';
      if (P <= 0) {
        out.appendChild(HC.el('div', { class: 'empty', text: '请输入贷款金额' }));
        return;
      }

      if (way.value === 'interest') {
        // 等额本息：两笔分别算月供再相加
        const m1 = P1 > 0 ? P1 * r1 * Math.pow(1 + r1, n) / (Math.pow(1 + r1, n) - 1) : 0;
        const m2 = P2 > 0 ? P2 * r2 * Math.pow(1 + r2, n) / (Math.pow(1 + r2, n) - 1) : 0;
        const m = m1 + m2;
        const total = m * n;
        out.appendChild(row('每月月供（固定）', '¥ ' + fmtMoney(m), true));
        out.appendChild(row('还款总额', '¥ ' + fmtMoney(total)));
        out.appendChild(row('支付利息总额', '¥ ' + fmtMoney(total - P)));
        out.appendChild(row('利息 / 本金', Math.round((total - P) / P * 100) + '%'));
      } else {
        // 等额本金：月供 = 本金/n + 剩余本金 × 月利率
        const principal = P / n;
        const first = principal + P * r1 + (P2 > 0 ? 0 : 0);
        // 组合贷两笔利率不同，首月 = 各自首月之和
        const f1 = P1 > 0 ? P1 / n + P1 * r1 : 0;
        const f2 = P2 > 0 ? P2 / n + P2 * r2 : 0;
        const firstM = f1 + f2;
        // 末月：剩余本金只剩最后一份
        const l1 = P1 > 0 ? P1 / n + (P1 / n) * r1 : 0;
        const l2 = P2 > 0 ? P2 / n + (P2 / n) * r2 : 0;
        const lastM = l1 + l2;
        const totalInterest1 = P1 > 0 ? (n + 1) * P1 * r1 / 2 : 0;
        const totalInterest2 = P2 > 0 ? (n + 1) * P2 * r2 / 2 : 0;
        const interest = totalInterest1 + totalInterest2;
        out.appendChild(row('首月月供', '¥ ' + fmtMoney(firstM), true));
        out.appendChild(row('末月月供', '¥ ' + fmtMoney(lastM)));
        out.appendChild(row('每月递减', '¥ ' + fmtMoney(principal * r1 + principal * r2)));
        out.appendChild(row('还款总额', '¥ ' + fmtMoney(P + interest)));
        out.appendChild(row('支付利息总额', '¥ ' + fmtMoney(interest)));
      }
      out.appendChild(note('利息总额随政策利率浮动，此处按你输入的年利率静态计算。'));
    }

    function row(label, val, big) {
      return HC.el('div', { class: 'opt-row' }, [
        HC.el('div', { class: 'opt-info' }, [
          HC.el('div', { class: 'opt-name', text: label }),
        ]),
        HC.el('div', {
          class: big ? 'score-num' : 'opt-name',
          style: big ? 'font-size:22px;color:var(--accent);' : 'color:var(--text);',
          text: String(val),
        }),
      ]);
    }

    const card = HC.el('div', { class: 'row glass', style: 'display:block;padding:14px;' }, [
      grid('商贷金额（万）', amt, '公积金金额（万）', gAmt),
      grid('贷款年限（年）', years, '还款方式', way),
      grid('商贷年利率 %', rCom, '公积金年利率 %', rFund),
      HC.el('div', { class: 'section-title', style: 'margin-top:10px;', text: '结果' }),
      out,
    ]);
    [amt, gAmt, years, rCom, rFund, way].forEach((el) => el.addEventListener('input', calc));
    body.appendChild(card);
    calc();
  }

  /* ============================ ② 交易税费 ============================ */
  function renderTax(body) {
    const price = HC.el('input', { class: 'input', type: 'number', value: '300', min: '1' }); // 网签价（万）
    const area = HC.el('input', { class: 'input', type: 'number', value: '89', min: '1' });   // 面积 ㎡
    const buyer = HC.el('select', { class: 'input' });
    [['first', '首套'], ['second', '二套']].forEach(([v, l]) => buyer.appendChild(HC.el('option', { value: v, text: l })));
    const hold = HC.el('select', { class: 'input' });
    [['lt2', '未满 2 年'], ['ge2', '满 2 年'], ['ge5', '满 5 年']].forEach(([v, l]) => hold.appendChild(HC.el('option', { value: v, text: l })));
    const only = HC.el('input', { type: 'checkbox' }); // 满五唯一 / 卖方家庭唯一
    only.checked = false;

    const out = HC.el('div', { class: 'opt-list' });

    function calc() {
      const P = Math.max(0, num(price, 0)) * WAN;
      const A = Math.max(0, num(area, 0));
      out.innerHTML = '';
      if (P <= 0 || A <= 0) {
        out.appendChild(HC.el('div', { class: 'empty', text: '请输入网签价与面积' }));
        return;
      }
      const isSecond = buyer.value === 'second';
      const held = hold.value;

      // 契税（常见规则）：首套 ≤90㎡ 1% / >90㎡ 1.5%；二套 ≤90㎡ 1% / >90㎡ 2%
      const deedRate = A <= 90 ? 0.01 : (isSecond ? 0.02 : 0.015);
      const deed = P * deedRate;

      // 增值税及附加：满 2 年免征（普通住宅），未满 2 年按 5.3%
      const vatRate = held === 'lt2' ? 0.053 : 0;
      const vat = P * vatRate;

      // 个税：满五唯一免征；否则按核定 1%（差额 20% 因需原值凭证，此处给核定口径）
      const taxRate = (held === 'ge5' && only.checked) ? 0 : 0.01;
      const pit = P * taxRate;

      const total = deed + vat + pit;
      out.appendChild(row('契税 ' + (deedRate * 100).toFixed(1) + '%', '¥ ' + fmtMoney(deed)));
      out.appendChild(row(held === 'lt2' ? '增值税及附加 5.3%' : '增值税及附加（满 2 年免征）', '¥ ' + fmtMoney(vat)));
      out.appendChild(row(
        taxRate === 0 ? '个人所得税（满五唯一免征）' : '个人所得税（核定 1%）',
        '¥ ' + fmtMoney(pit)));
      out.appendChild(row('买方合计税费', '¥ ' + fmtMoney(total), true));
      out.appendChild(row('税费占房价', (total / P * 100).toFixed(2) + '%'));
      out.appendChild(note('按常见规则静态估算：契税首套 ≤90㎡ 1% / >90㎡ 1.5%，二套 >90㎡ 2%；增值税及附加未满 2 年 5.3%；个税核定 1%。各城市执行口径不同，以当地为准。'));
    }

    function row(label, val, big) {
      return HC.el('div', { class: 'opt-row' }, [
        HC.el('div', { class: 'opt-info' }, [
          HC.el('div', { class: 'opt-name', text: label }),
        ]),
        HC.el('div', {
          class: big ? 'score-num' : 'opt-name',
          style: big ? 'font-size:22px;color:var(--accent);' : 'color:var(--text);',
          text: String(val),
        }),
      ]);
    }

    const card = HC.el('div', { class: 'row glass', style: 'display:block;padding:14px;' }, [
      grid('网签价（万）', price, '建筑面积（㎡）', area),
      grid('买方套数', buyer, '房产证持有', hold),
      HC.el('label', { class: 'chk', style: 'display:flex;gap:6px;margin:8px 0;' }, [
        only, HC.el('span', { text: '卖方满五唯一（满 5 年 + 家庭唯一住房）' }),
      ]),
      HC.el('div', { class: 'section-title', style: 'margin-top:10px;', text: '结果' }),
      out,
    ]);
    [price, area, buyer, hold, only].forEach((el) => el.addEventListener('input', calc));
    card.querySelectorAll('select').forEach((el) => el.addEventListener('change', calc));
    only.addEventListener('change', calc);
    body.appendChild(card);
    calc();
  }

  /* ============================ ③ 租金回报 ============================ */
  function renderRent(body) {
    const price = HC.el('input', { class: 'input', type: 'number', value: '300', min: '1' }); // 总价（万）
    const rent = HC.el('input', { class: 'input', type: 'number', value: '6000', min: '0' }); // 月租金
    const vacant = HC.el('input', { class: 'input', type: 'number', value: '1', min: '0', max: '12', step: '0.5' }); // 年空置（月）
    const maintain = HC.el('input', { class: 'input', type: 'number', value: '8000', min: '0' }); // 年持有成本

    const out = HC.el('div', { class: 'opt-list' });

    function calc() {
      const P = Math.max(0, num(price, 0)) * WAN;
      const R = Math.max(0, num(rent, 0));
      const V = Math.min(12, Math.max(0, num(vacant, 0)));
      const M = Math.max(0, num(maintain, 0));
      out.innerHTML = '';
      if (P <= 0) {
        out.appendChild(HC.el('div', { class: 'empty', text: '请输入总价' }));
        return;
      }
      const yearRent = R * (12 - V);
      const net = yearRent - M;
      const gross = P > 0 ? yearRent / P : 0;
      const netRate = P > 0 ? net / P : 0;
      const yearsBack = net > 0 ? P / net : null;
      out.appendChild(row('年租金收入（扣空置 ' + V + ' 个月）', '¥ ' + fmtMoney(yearRent)));
      out.appendChild(row('年净收益（再扣持有成本）', '¥ ' + fmtMoney(net)));
      out.appendChild(row('毛租金回报率（年化）', (gross * 100).toFixed(2) + '%', true));
      out.appendChild(row('净回报率（年化）', (netRate * 100).toFixed(2) + '%'));
      out.appendChild(row(
        yearsBack == null ? '静态回本年限' : '静态回本年限',
        yearsBack == null ? '净收益 ≤ 0，租金无法覆盖持有成本' : Math.round(yearsBack * 10) / 10 + ' 年'));
      out.appendChild(note('国际常用参考：毛回报率 4% 以上算偏高；国内住宅普遍 1.5%~2.5%。持有成本可填物业费 + 维修 + 空置损失折现等。'));
    }

    function row(label, val, big) {
      return HC.el('div', { class: 'opt-row' }, [
        HC.el('div', { class: 'opt-info' }, [
          HC.el('div', { class: 'opt-name', text: label }),
        ]),
        HC.el('div', {
          class: big ? 'score-num' : 'opt-name',
          style: big ? 'font-size:22px;color:var(--accent);' : 'color:var(--text);',
          text: String(val),
        }),
      ]);
    }

    const card = HC.el('div', { class: 'row glass', style: 'display:block;padding:14px;' }, [
      grid('房产总价（万）', price, '月租金（元）', rent),
      grid('每年空置（月）', vacant, '年持有成本（元）', maintain),
      HC.el('div', { class: 'section-title', style: 'margin-top:10px;', text: '结果' }),
      out,
    ]);
    [price, rent, vacant, maintain].forEach((el) => el.addEventListener('input', calc));
    body.appendChild(card);
    calc();
  }

  /* ============================ 公共小件 ============================ */
  /** 两列输入网格 */
  function grid(l1, el1, l2, el2) {
    return HC.el('div', { class: 're-grid' }, [
      field(l1, el1), field(l2, el2),
    ]);
  }
  function field(label, el) {
    return HC.el('div', {}, [
      HC.el('div', { class: 'opt-name', style: 'font-size:12.5px;margin:8px 0 4px;', text: label }),
      el,
    ]);
  }
  function note(txt) {
    return HC.el('div', { class: 'opt-desc', style: 'margin-top:8px;font-size:11.5px;', text: txt });
  }
})();
