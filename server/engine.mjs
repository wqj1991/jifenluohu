// 积分计算引擎：严格按 京政办发〔2020〕9 号 + 京人社开发发〔2020〕8 号
export const CITY_SIX = ["东城", "西城", "朝阳", "海淀", "丰台", "石景山"];
export const isCitySix = (d) => CITY_SIX.includes(String(d || "").replace(/区$/, ""));

const ym = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{1,2})/);
  return m ? { y: +m[1], m: +m[2] } : null;
};

/** 两个年月之间的整月数（含起点，不含终点） */
export function monthsBetween(a, b) {
  const x = ym(a), y = ym(b);
  if (!x || !y) return 0;
  const n = (y.y - x.y) * 12 + (y.m - x.m);
  return Math.max(0, n);
}

const capEnd = (applyYear) => `${applyYear - 1}-12`; // 计分截至申报上一年 12 月

function overlapMonths(s1, e1, s2, e2) {
  const a = ym(s1), b = ym(e1), c = ym(s2), d = ym(e2);
  if (!a || !c) return 0;
  const A = a.y * 12 + a.m, B = b.y * 12 + b.m;
  const C = c.y * 12 + c.m, D = d.y * 12 + d.m;
  const lo = Math.max(A, C), hi = Math.min(B, D);
  return Math.max(0, hi - lo);
}

/** 教育期间（用于扣减就业/住所分） */
function studyRanges(edu) {
  const out = [];
  for (const e of edu) {
    if (!e.study_months || !e.obtain_ym) continue;
    const o = ym(e.obtain_ym);
    if (!o) continue;
    const endTotal = o.y * 12 + o.m;
    const startTotal = endTotal - e.study_months;
    const sy = Math.floor((startTotal - 1) / 12), sm = ((startTotal - 1) % 12) + 1;
    out.push([`${sy}-${String(sm).padStart(2, "0")}`, e.obtain_ym]);
  }
  return out;
}

const EDU_SCORE = { 专科: 10.5, 本科: 15, 硕士: 26, 博士: 37 };

/** 主计算：返回每个分项、总分、依据 */
export function compute(p, applyYear) {
  const end = capEnd(applyYear);
  // 计分截止月含当月，所以计算用的右开边界是次年 1 月；
  // end 只用于「计分截至 2026-12」这类展示。
  const endEx = `${applyYear}-01`;
  const items = [];
  const study = studyRanges(p.education || []);

  // ---- 1 合法稳定就业 ----
  let empMonths = 0;
  const empDetail = [];
  const empSteps = [];
  for (const e of p.employment || []) {
    const s = e.start_ym < "1998-07" ? "1998-07" : e.start_ym;
    const eEnd = e.end_ym || endEx;
    const raw = overlapMonths(s, eEnd, "1998-07", endEx);
    const bf = Math.min(e.backfill_months || 0, raw);
    let sc = 0;
    for (const [rs, re] of study) sc += overlapMonths(s, eEnd, rs, re);
    const m = Math.max(0, raw - bf - sc);
    empMonths += m;
    empDetail.push({ ...e, months: m, raw, bf, sc });
    empSteps.push({
      t: `${s} → ${eEnd}`,
      v: `${raw} 月`,
      n: [e.pay_district || "未填缴费区", e.is_municipal ? "市本级缴费" : null].filter(Boolean).join(" · "),
    });
    if (bf) empSteps.push({ t: "　扣：补缴月份", v: `−${bf} 月`, n: "补缴月不计入积分" });
    if (sc) empSteps.push({ t: "　扣：取得学历期间", v: `−${sc} 月`, n: "该期间不重复计就业分" });
    empSteps.push({ t: "　小计", v: `${m} 月` });
  }
  if (!(p.employment || []).length) empSteps.push({ t: "未录入就业记录", v: "0 月" });
  const empScore = (empMonths / 12) * 3;
  items.push({
    key: "employment", no: "一", title: "合法稳定就业",
    score: round(empScore), raw: empMonths,
    unit: `${empMonths} 个月 × 3 分/年`,
    note: "补缴月不计入；取得学历期间的月份已扣减",
    optimizable: "低", detail: empDetail,
    steps: empSteps,
    formula: `${empMonths} 月 ÷ 12 × 3 分/年 = ${round(empScore)} 分`,
  });

  // ---- 2 合法稳定住所 ----
  // 细则第十五条（二）：本细则发布之日（2020-07-16，不含）前在单位宿舍、租赁住所的连续居住年限，
  // 以申请人同期在京合法稳定就业年限计算（免备案）；发布之日（含）后的在京租赁住所，
  // 以北京市住房租赁监管平台备案的房屋租赁合同为准。同一时间各类住所不重复计分，并优先计算自有住所。
  const T = (v) => { const x = ym(v); return x ? x.y * 12 + (x.m - 1) : null; };
  const freezeT = T("2020-07");
  const loT = T("1998-07"), hiT = T(endEx);

  const usedAny = new Set();
  let ownM = 0, rentM = 0, unregM = 0;
  const resSteps = [];

  const KIND_CN = { own: "自有住所", rent: "租赁住所", dorm: "单位宿舍" };
  const sortedRes = [...(p.residence || [])].sort(
    (a, b) => (a.kind === "own" ? 0 : 1) - (b.kind === "own" ? 0 : 1)
  );
  for (const r of sortedRes) {
    const A = Math.max(T(r.start_ym), loT);
    const B = Math.min(T(r.end_ym || endEx), hiT);
    const isOwn = r.kind === "own";
    let o = 0, rt = 0, un = 0, dp = 0;
    for (let t = A; t < B; t++) {
      if (usedAny.has(t)) { dp++; continue; }          // 同一时间不重复计分
      if (!isOwn && t > freezeT && !r.registered) {     // 2020-08 起未备案的租赁不计分
        un++; continue;
      }
      usedAny.add(t);
      if (isOwn) o++; else rt++;
    }
    ownM += o; rentM += rt; unregM += un;
    resSteps.push({
      t: `${r.start_ym || "—"} → ${r.end_ym || "至今"}`,
      v: o ? `自有 ${o} 月` : rt ? `租赁 ${rt} 月` : "计 0 月",
      n: [
        `${KIND_CN[r.kind] || r.kind} · ${r.district || "未填区"}`,
        isOwn ? (r.registered ? "有不动产权证" : "无产权证") : (r.registered ? "已备案" : "未备案"),
        un ? `未备案 ${un} 月不计分` : null,
        dp ? `与高优先级住所重叠 ${dp} 月，不重复计` : null,
      ].filter(Boolean).join(" · "),
    });
  }
  if (!sortedRes.length) resSteps.push({ t: "未录入住所记录", v: "0 月" });
  resSteps.push({ t: "合计", v: `自有 ${ownM} 月 + 租赁/宿舍 ${rentM} 月` });

  // 连续居住年限多于就业年限时以就业年限为准，且优先计算自有住所（先削租赁）
  let cutRent = 0, cutOwn = 0;
  {
    let cut = Math.max(0, ownM + rentM - empMonths);
    const cr = Math.min(rentM, cut); rentM -= cr; cut -= cr; cutRent = cr;
    const co = Math.min(ownM, cut); ownM -= co; cutOwn = co;
    if (cr || co) {
      resSteps.push({
        t: "截断：居住年限 > 社保年限",
        v: `−${cr + co} 月`,
        n: `以就业年限 ${empMonths} 月为上限，优先削租赁${cr ? ` −${cr}` : ""}${co ? `，再削自有 −${co}` : ""}`,
      });
    }
  }
  const houseScore = (ownM / 12) * 1 + (rentM / 12) * 0.5;
  items.push({
    key: "residence", no: "二", title: "合法稳定住所",
    score: round(houseScore), raw: ownM + rentM,
    unit: `自有 ${ownM} 月 ×1 + 租赁/宿舍 ${rentM} 月 ×0.5`,
    note: [
      unregM > 0 ? `${unregM} 月租赁未备案（2020-08 起需备案），未计分` : null,
      "2020-07 及以前的租赁/宿舍按同期就业年限计分，无需备案",
    ].filter(Boolean).join("；"),
    optimizable: "中",
    detail: { ownM, rentM, unregM, freeze: "2020-07", capped: cutRent + cutOwn > 0 },
    steps: resSteps,
    formula: `自有 ${ownM} 月 ÷ 12 × 1 + 租赁/宿舍 ${rentM} 月 ÷ 12 × 0.5 = ${round(houseScore)} 分`,
  });

  // ---- 3 教育背景 ----
  let best = { score: 0, level: null };
  const eduSteps = [];
  for (const e of p.education || []) {
    const sc = EDU_SCORE[e.level] || 0;
    eduSteps.push({
      t: e.level || "未填学历",
      v: `+${sc}`,
      n: [e.obtain_ym ? `${e.obtain_ym} 取得` : null, e.study_months ? `在读 ${e.study_months} 月` : null].filter(Boolean).join(" · "),
    });
    if (sc > best.score) best = { score: sc, level: e.level };
  }
  if (!eduSteps.length) eduSteps.push({ t: "未录入学历", v: "+0" });
  eduSteps.push({ t: "取最高者，不累计", v: `+${best.score}` });
  for (const [rs, re] of study) {
    eduSteps.push({ t: `在读区间 ${rs} → ${re}`, v: "扣减", n: "该期间就业与住所积分不予计算" });
  }
  items.push({
    key: "education", no: "三", title: "教育背景",
    score: round(best.score), raw: best.level,
    unit: best.level ? `${best.level} ${best.score} 分（取最高，不累计）` : "未录入",
    note: study.length ? "已按学制扣减同期就业与住所积分" : "无在读扣减",
    optimizable: "中", detail: { level: best.level, study },
    steps: eduSteps,
    formula: `最高学历 ${best.level || "无"} = ${best.score} 分`,
  });

  // ---- 4 职住区域 ----
  let outHouseM = 0, outWorkM = 0;
  const zhSteps = [];
  {
    const zs = new Set();
    for (const r of p.residence || []) {
      if (r.kind !== "own") continue;
      const label = `${r.start_ym || "—"} → ${r.end_ym || "至今"} ${r.district || "未填区"} 自有住所`;
      if (!r.registered) { zhSteps.push({ t: label, v: "0 月", n: "无不动产权证，不计职住区域" }); continue; }
      if (isCitySix(r.district)) { zhSteps.push({ t: label, v: "0 月", n: "在城六区内，不满足" }); continue; }
      const A = Math.max(T(r.start_ym), T("2018-01"), loT);
      const B = Math.min(T(r.end_ym || endEx), hiT);
      let c = 0;
      for (let t = A; t < B; t++) if (!zs.has(t)) { zs.add(t); c++; }
      zhSteps.push({ t: label, v: `${c} 月`, n: "城六区外自有 · ×2 分/年" });
    }
    outHouseM = zs.size;
  }
  {
    const ws = new Set();
    for (const e of p.employment || []) {
      const label = `${e.start_ym || "—"} → ${e.end_ym || "至今"} ${e.pay_district || "未填区"} 就业`;
      if (e.is_municipal) { zhSteps.push({ t: label, v: "0 月", n: "市本级缴费，视为城六区" }); continue; }
      if (isCitySix(e.pay_district)) { zhSteps.push({ t: label, v: "0 月", n: "缴费区在城六区内" }); continue; }
      const A = Math.max(T(e.start_ym), T("2018-01"), loT);
      const B = Math.min(T(e.end_ym || endEx), hiT);
      let c = 0;
      for (let t = A; t < B; t++) if (!ws.has(t)) { ws.add(t); c++; }
      zhSteps.push({ t: label, v: `${c} 月`, n: "城六区外就业 · ×3 分/年" });
    }
    outWorkM = ws.size;
  }
  if (!zhSteps.length) zhSteps.push({ t: "无城六区外住所或就业记录", v: "0 月" });
  const zhRaw = (outHouseM / 12) * 2 + (outWorkM / 12) * 3;
  const zhScore = Math.min(12, zhRaw);
  zhSteps.push({
    t: "小计",
    v: `${outHouseM} 月 ×2/年 + ${outWorkM} 月 ×3/年`,
    n: zhRaw >= 12 ? `原始 ${round(zhRaw)} 分，触顶 12` : `原始 ${round(zhRaw)} 分，未触顶`,
  });
  items.push({
    key: "zhizhu", no: "四", title: "职住区域",
    score: round(zhScore), raw: outHouseM + outWorkM,
    unit: `城六区外自有住所 ${outHouseM} 月 ×2/年 + 城六区外就业 ${outWorkM} 月 ×3/年`,
    note: zhRaw >= 12 ? "已触顶 12 分" : `离上限还差 ${round(12 - zhRaw)} 分`,
    optimizable: "高", detail: { outHouseM, outWorkM, raw: round(zhRaw), capped: zhRaw >= 12 },
    steps: zhSteps,
    formula: `${outHouseM} 月 ÷ 12 × 2 + ${outWorkM} 月 ÷ 12 × 3 = ${round(zhRaw)} → min(12) = ${round(zhScore)} 分`,
  });

  // ---- 5 年龄 ----
  const b = ym(p.birth_ym);
  let ageScore = 0, age = null;
  if (b) {
    const refYear = applyYear - 1; // 年龄算至申报上一年 1 月 1 日
    age = refYear - b.y;           // 未满周岁按周岁计（1 月 1 日时点）
    ageScore = age <= 45 ? 20 : Math.max(0, 20 - (age - 45) * 4);
  }
  items.push({
    key: "age", no: "五", title: "年龄",
    score: round(ageScore), raw: age,
    unit: age === null ? "未录入出生年月" : `${applyYear - 1}-01-01 时 ${age} 岁`,
    note: age !== null && age > 45 ? `超过 45 岁，每年递减 4 分，${applyYear - 1 + (49 - age)} 年归零` : "未触及递减线",
    optimizable: "无", detail: { age },
    steps: [
      { t: "出生年月", v: p.birth_ym || "未录入" },
      { t: `算至 ${applyYear - 1}-01-01`, v: age === null ? "—" : `${age} 岁`, n: "年龄算至申报上一年 1 月 1 日" },
      age === null
        ? { t: "无出生年月", v: "+0" }
        : age <= 45
          ? { t: "未超过 45 岁", v: "+20", n: "满分，不递增" }
          : { t: `超过 45 岁 ${age - 45} 年`, v: `20 − ${age - 45} × 4 = +${round(ageScore)}`, n: age >= 49 ? "已归零" : "每年递减 4 分" },
    ],
    formula: age === null ? "未录入，0 分" : age <= 45 ? "≤45 岁 = 20 分" : `20 − (${age}−45)×4 = ${round(ageScore)} 分`,
  });

  // ---- 6 纳税 ----
  const taxYears = (p.tax || []).filter((t) => t.year >= applyYear - 3 && t.year <= applyYear - 1);
  let taxScore = 0;
  const taxHit = [];
  const taxSteps = [];
  for (let y = applyYear - 3; y <= applyYear - 1; y++) {
    const rec = (p.tax || []).find((t) => t.year === y);
    const amt = rec ? Number(rec.amount) || 0 : 0;
    const hit = amt >= 100000;
    if (hit) { taxScore += 2; taxHit.push(y); }
    taxSteps.push({
      t: `${y} 年个税`,
      v: hit ? "+2" : "+0",
      n: rec ? `${amt.toLocaleString()} 元 · 门槛 100,000 元` : "未录入 · 门槛 100,000 元",
    });
  }
  const taxBeforeCap = taxScore;
  taxScore = Math.min(6, taxScore);
  if (taxBeforeCap > 6) taxSteps.push({ t: "上限", v: "6", n: `原始 ${taxBeforeCap}，触顶` });
  items.push({
    key: "tax", no: "六", title: "纳税",
    score: round(taxScore), raw: taxScore,
    unit: taxHit.length ? `达标年份 ${taxHit.join("、")}（每年 ≥10 万 +2）` : "近 3 年无单年 ≥10 万个税",
    note: "上限 6 分；近 5 年涉税违法每条 −12",
    optimizable: "高", detail: { hit: taxHit },
    steps: taxSteps,
    formula: `${taxHit.length} 个达标年度 × 2 = ${round(taxScore)} 分（上限 6）`,
  });

  // ---- 7 创新创业 ----
  const inno = p.innovation || [];
  items.push({
    key: "innovation", no: "七", title: "创新创业",
    score: 0, raw: 0, unit: inno.length ? `已录入 ${inno.length} 项` : "未录入奖项",
    note: "按附件 3 分档，最高 12 分（未核实具体档位）",
    optimizable: "低", detail: {},
    steps: [
      { t: "已录入创新创业奖项", v: String(inno.length), n: inno.length ? "" : "档案里没有这一项" },
      { t: "分档规则", v: "未核实", n: "附件 3 的具体档位未在正文中列明，按 0 分计，不臆测" },
    ],
    formula: "未录入 → 0 分",
  });

  // ---- 8 荣誉表彰 ----
  const honors = p.honor || [];
  const honScore = honors.length ? 20 : 0;
  items.push({
    key: "honor", no: "八", title: "荣誉表彰",
    score: honScore, raw: honors.length,
    unit: honors.length ? honors.map((h) => h.level).join("、") : "无",
    note: "不累计，只计一次 20 分",
    optimizable: "无", detail: {},
    steps: honors.length
      ? [
          ...honors.map((h) => ({ t: `${h.year || ""} ${h.level || "未填级别"}`, v: "+20", n: "国家级或省部级表彰" })),
          { t: "不累计", v: `+${honScore}`, n: `${honors.length} 项只计一次` },
        ]
      : [{ t: "未录入荣誉表彰", v: "+0" }],
    formula: honors.length ? "有荣誉 → 20 分（不累计）" : "无荣誉 → 0 分",
  });

  // ---- 9 守法记录 ----
  items.push({
    key: "law", no: "九", title: "守法记录",
    score: 0, raw: 0, unit: "近 5 年无行政拘留记录", note: "每条 −30",
    optimizable: "无", detail: {},
    steps: [
      { t: `近 5 年（${applyYear - 5}–${applyYear - 1}）行政拘留记录`, v: "0 条", n: "档案里未录入" },
      { t: "扣分", v: "−0" },
    ],
    formula: "0 条 × (−30) = 0 分",
  });

  // ---- 结算 ----
  const total = items.reduce((s, i) => s + i.score, 0);
  const empAnnual = 3; // 每年自然增长

  return {
    applyYear,
    items,
    total: round(total),
    endDate: end,
    annualGain: empAnnual,
    employmentMonths: empMonths,
    age,
  };
}

export function project(cutoffs, computeFn, fromYear, toYear) {
  // 线性外推：用最近 4 年斜率
  const last = cutoffs.slice(-4);
  const n = last.length;
  const xs = last.map((c) => c.year), ys = last.map((c) => c.cutoff);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 3.65;
  const lastPoint = cutoffs[cutoffs.length - 1];
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    out.push({ year: y, cutoff: round(lastPoint.cutoff + slope * (y - lastPoint.year)), slope: round(slope) });
  }
  return { slope: round(slope), points: out };
}

export function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round((Number(n) || 0) * p) / p;
}
