// AI 选房：把「用户条件 → 本地库硬筛 → 候选打分 → 服务器本地大模型解读」串成一条链。
//
// 两个边界必须守住：
//   1) 数字只来自 sqlite。模型只做排序解释与取舍归纳，不许生成价格、通勤、学区数字；
//      返回前用 id 白名单回填，模型编造的 id 一律丢弃。
//   2) 模型不可用时接口照常出结果（确定性打分排序），只是没有「AI 解读」这一段，
//      并在 aiError 里写清原因，不假装成功。
//
// 模型服务是服务器本机的 workbuddy2api（OpenAI 兼容），默认 127.0.0.1:7863，
// key 走 LUOHU_AI_KEY，绝不写进仓库。
import { bizCenters, cacheKey } from "./house.mjs";

const AI_BASE = () => (process.env.LUOHU_AI_BASE || "http://127.0.0.1:7863/v1").replace(/\/+$/, "");
const AI_KEY = () => String(process.env.LUOHU_AI_KEY || "").trim();
// 默认走 cn:deepseek-v4.1-flash（cn:fast-model 是同一个模型的路由别名，显式写全名便于排查）
const AI_MODEL = () => process.env.LUOHU_AI_MODEL || "cn:deepseek-v4.1-flash";
const AI_TIMEOUT = () => Number(process.env.LUOHU_AI_TIMEOUT_MS || 90000);

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const int = (v) => (v === "" || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/* 梯队档位：只有 school_rank 里真实录过的档才算数，没录就是 null（不猜） */
const TIER_SCORE = {
  一梯队: 30, 二梯队: 22, 三梯队: 14, "民办/国际": 16, "民办·国际": 16, 其他梯队: 6,
};
const TIER_ORDER = { 一梯队: 1, 二梯队: 2, 三梯队: 3, "民办/国际": 4, "民办·国际": 4, 其他梯队: 5 };

/* ---------- 模型侧 ---------- */
export function aiStatus() {
  return { enabled: Boolean(AI_KEY()), model: AI_MODEL(), base: AI_BASE(), timeoutMs: AI_TIMEOUT() };
}

async function chat(messages, opts = {}) {
  if (!AI_KEY()) throw new Error("LUOHU_AI_KEY 未配置，接口只出确定性结果");
  const body = {
    model: AI_MODEL(),
    messages,
    max_tokens: opts.maxTokens || 1800,
    temperature: opts.temperature ?? 0.3,
  };
  const t0 = Date.now();
  const r = await fetch(`${AI_BASE()}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AI_KEY()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_TIMEOUT()),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`模型服务 ${r.status}: ${text.slice(0, 240)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("模型服务返回非 JSON"); }
  const msg = j.choices?.[0]?.message || {};
  // 推理型模型截断时 content 可能为空、正文落在 reasoning_content 里，别当成空回答
  const content = String(msg.content || msg.reasoning_content || "").trim();
  if (!content) throw new Error("模型没有返回内容");
  return {
    content,
    // content 是否来自 reasoning_content：是的话说明正文没写完，JSON 通常缺尾巴
    fromReasoning: !msg.content,
    finishReason: j.choices?.[0]?.finish_reason || null,
    usage: j.usage || null,
    model: j.model || AI_MODEL(),
    ms: Date.now() - t0,
  };
}

/** 从模型输出里捞出 JSON：容忍 ```json 围栏、前后客套话 */
export function extractJson(text) {
  const s = String(text || "").replace(/^\uFEFF/, "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const i = body.indexOf("{");
  const j = body.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(body.slice(i, j + 1)); } catch { return null; }
}

/** 要 JSON 的调用：第一次不够长被截断，就加预算低温重试一次；两次都不成才报错 */
async function chatJson(messages, { maxTokens = 3000, temperature = 0.3 } = {}) {
  const budget = [maxTokens, Math.min(maxTokens * 2, 8000)];
  let last = null;
  for (let i = 0; i < budget.length; i++) {
    const r = await chat(messages, { maxTokens: budget[i], temperature: i ? 0.1 : temperature });
    const parsed = extractJson(r.content);
    if (parsed) return { parsed, ...r };
    last = r;
    // 没被截断还解析不出，说明是格式问题，重试也白搭
    if (r.finishReason === "stop" && i === 0 && r.content.length > 0 && !/[{\[]/.test(r.content)) break;
  }
  throw new Error(`模型输出不是 JSON（finish=${last?.finishReason} 实际模型=${last?.model} 字符数=${last?.content.length}）`);
}

/* ---------- 条件归一 ---------- */
const STAGES = ["小学", "中学"];
const TIERS = ["一梯队", "二梯队", "三梯队"];

/**
 * 通勤要求：可以同时盯两个公司（到环球贸易 ≤75 分 + 到施耐德 ≤90 分）。
 * 兼容旧参数：wpId/maxMin 与 commute:{wpId,maxMin} 都当成第一条。
 */
function normCommutes(raw = {}) {
  const list = Array.isArray(raw.commutes) ? raw.commutes
    : Array.isArray(raw.commute) ? raw.commute
    : [{ wpId: raw?.commute?.wpId ?? raw.wpId, maxMin: raw?.commute?.maxMin ?? raw.maxMin }];
  const out = [];
  for (const x of list) {
    const wpId = int(x?.wpId);
    const maxMin = int(x?.maxMin);
    if (wpId == null && maxMin == null) continue;
    if (wpId != null && out.some((o) => o.wpId === wpId)) continue; // 同一个公司只留一条
    out.push({ wpId, maxMin: maxMin != null ? clamp(maxMin, 5, 240) : null });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 学区要求：小学、初中各要一条（小学二梯队 + 初中一梯队）。
 * 兼容旧参数：schoolStage/schoolTier/maxKm 与 school:{stage,tier,maxKm}。
 */
function normSchools(raw = {}) {
  const list = Array.isArray(raw.schools) ? raw.schools
    : Array.isArray(raw.school) ? raw.school
    : [{ stage: raw?.school?.stage ?? raw.schoolStage, tier: raw?.school?.tier ?? raw.schoolTier, maxKm: raw?.school?.maxKm ?? raw.maxKm }];
  const out = [];
  for (const x of list) {
    const stage = STAGES.includes(String(x?.stage || "")) ? String(x.stage) : "";
    const tier = TIERS.includes(String(x?.tier || "")) ? String(x.tier) : "";
    const km = Number(x?.maxKm) || null;
    if (!stage && !tier && km == null) continue;
    const entry = { stage: stage || "中学", tier, maxKm: km != null ? clamp(km, 0.3, 20) : null };
    // 同一阶段只留一条，后写的覆盖先写的
    const i = out.findIndex((o) => o.stage === entry.stage);
    if (i >= 0) out[i] = entry; else out.push(entry);
    if (out.length >= 2) break;
  }
  return out;
}

export function normalizeCond(raw = {}) {
  const commutes = normCommutes(raw);
  const schools = normSchools(raw);
  const c = {
    district: ["通州", "大兴", "经开"].includes(String(raw?.district || "").trim()) ? String(raw.district).trim() : "",
    bizcircles: Array.isArray(raw?.bizcircles) ? raw.bizcircles.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [],
    priceMin: int(raw?.priceMin),
    priceMax: int(raw?.priceMax),
    buildYearMin: int(raw?.buildYearMin),
    commutes,
    schools,
    // 旧字段镜像第一条，老调用方与文案照旧能用
    wpId: commutes[0]?.wpId ?? null,
    maxMin: commutes[0]?.maxMin ?? null,
    schoolStage: schools[0]?.stage ?? "",
    schoolTier: schools[0]?.tier ?? "",
    maxKm: schools[0]?.maxKm ?? null,
    brief: String(raw?.brief || "").replace(/\s+/g, " ").trim().slice(0, 300),
    topN: clamp(int(raw?.topN) || 12, 3, 20),
  };
  if (c.priceMin != null && c.priceMax != null && c.priceMin > c.priceMax) [c.priceMin, c.priceMax] = [c.priceMax, c.priceMin];
  return c;
}

/* ---------- 候选筛选（确定性，可复算） ---------- */
function baseWhere(c) {
  // 与 /api/house/rows 同一套口径：只要住宅/别墅、去掉村住房与新房壳，
  // 选房结果固定要求有坐标（没有坐标的小区不参与通勤与学区推断）。
  const where = [
    "lng IS NOT NULL",
    "price IS NOT NULL",
    "property_type IN ('住宅','别墅')",
    "name NOT LIKE '%村住房%'",
    "name NOT LIKE '%(新房)%'",
    "name NOT LIKE '%(商业)%'",
    "name NOT LIKE '%(商住)%'",
    "name NOT LIKE '%(公寓)%'",
    "name NOT LIKE '%(别墅)%'",
  ];
  const args = [];
  if (c.district) { where.push("district = ?"); args.push(c.district); }
  if (c.bizcircles.length) {
    where.push(`bizcircle IN (${c.bizcircles.map(() => "?").join(",")})`);
    args.push(...c.bizcircles);
  }
  if (c.priceMin != null) { where.push("price >= ?"); args.push(c.priceMin); }
  if (c.priceMax != null) { where.push("price <= ?"); args.push(c.priceMax); }
  if (c.buildYearMin != null) { where.push("build_year >= ?"); args.push(c.buildYearMin); }
  return { sql: where.join(" AND "), args };
}

function tierMap(db) {
  const rows = db
    .prepare("SELECT school_name, stage, tier FROM school_rank WHERE tier IS NOT NULL AND TRIM(tier) <> '' ORDER BY year DESC")
    .all();
  const m = new Map();
  for (const r of rows) if (!m.has(r.school_name)) m.set(r.school_name, r.tier);
  return m;
}

/** 某小区到某工作地点的通勤：实测路线优先，其次商圈质心缓存，都没有就 null */
function commuteOf(db, c, wp, centers, cacheStmt, routeStmt) {
  const exact = routeStmt.get(c.id, wp.id);
  if (exact && exact.minutes_min != null) {
    return { min: exact.minutes_min, max: exact.minutes_max ?? exact.minutes_min, source: exact.source === "manual" ? "实测" : "路线", line: exact.line_text || null };
  }
  const center = centers.get(`${c.district}|${c.bizcircle}`);
  if (!center) return null;
  const row = cacheStmt.get(cacheKey(center, wp));
  if (!row || row.minutes_min == null) return null;
  return { min: row.minutes_min, max: row.minutes_max ?? row.minutes_min, source: "商圈估算", line: null };
}

/* 学校表一次读进内存：候选池上千个小区，逐条走 nearbySchools 会把全表读上千遍 */
function schoolCtx(db) {
  return {
    schools: db.prepare("SELECT name, stage, lng, lat FROM school WHERE lng IS NOT NULL").all(),
    ranks: tierMap(db),
  };
}

const kmBetween = (lng, lat, s) => {
  const x = (lng - s.lng) * 111 * Math.cos((lat * Math.PI) / 180);
  const y = (lat - s.lat) * 111;
  return Math.round(Math.sqrt(x * x + y * y) * 10) / 10;
};

/* 一次遍历 school 表，按阶段各留最近的 3 所（两个阶段也只用遍历一遍） */
function nearestByStage(c, ctx, stages) {
  const out = new Map(stages.map((st) => [st, []]));
  for (const s of ctx.schools) {
    const bucket = out.get(s.stage);
    if (!bucket) continue;
    bucket.push({ name: s.name, stage: s.stage, km: kmBetween(c.lng, c.lat, s) });
  }
  for (const st of stages) {
    const list = out.get(st).sort((a, b) => a.km - b.km).slice(0, 3);
    out.set(st, list.map((s) => ({ ...s, tier: ctx.ranks.get(s.name) || null })));
  }
  return out;
}

/** 该阶段「最近 3 所」里最好的一所：先比梯队档，再比距离 */
function fitOne(list) {
  if (!list || !list.length) return null;
  return [...list].sort((a, b) =>
    ((TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9)) || a.km - b.km)[0];
}

/** 所有学区要求一起算：小学、初中各给一所，都带回去给前端展示 */
function schoolFitAll(c, cond, ctx) {
  const reqs = cond.schools.length ? cond.schools : [{ stage: "中学", tier: "", maxKm: null }];
  const stages = [...new Set(reqs.map((r) => r.stage))];
  const near = nearestByStage(c, ctx, stages);
  return reqs.map((req) => {
    const list = near.get(req.stage) || [];
    return { req, best: fitOne(list), candidates: list };
  });
}

/* 打分是本地启发式（0–100），只用来排初序与提示模型，不是任何官方口径 */
function scoreOf(c, ctx) {
  const { commutes, schools } = ctx;
  const parts = [];
  const push = (label, v) => { if (v > 0) parts.push(`${label} ${v}`); return v; };

  let s = 0;
  // 通勤：盯两个公司就取最差的那条，两头都得通才算数
  const mins = commutes.map((x) => x.t?.min).filter((v) => v != null);
  const worst = mins.length ? Math.max(...mins) : null;
  const cs = worst == null ? 14 : clamp(40 - Math.max(0, worst - 20) * 0.4, 0, 40);
  s += push("通勤", Math.round(cs));

  // 学区：每条要求各算一档（0–30），再取平均；没有要求的学校按 10 分档
  const perStage = schools.map(({ best }) => {
    if (!best) return 6;
    const base = best.tier ? TIER_SCORE[best.tier] ?? 6 : 10;
    return clamp(base - Math.max(0, best.km - 1) * 3, 0, 30);
  });
  const dist = perStage.length ? perStage.reduce((x, y) => x + y, 0) / perStage.length : 6;
  s += push("学区", Math.round(dist));

  const y = c.build_year;
  const ys = y == null ? 3 : y >= 2020 ? 10 : y >= 2015 ? 8 : y >= 2010 ? 6 : y >= 2005 ? 4 : 2;
  s += push("房龄", ys);
  const ps = (c.price_src_n >= 2 ? 6 : 3) + (c.bargain != null ? 4 * clamp(c.bargain / 0.1, 0, 1) : 0);
  s += push("价格可信", Math.round(ps));
  const ds = (c.price_tx ? 4 : 0) + (c.online != null ? 3 : 0) + (c.address ? 3 : 0);
  s += push("数据完整", ds);
  return { score: Math.round(clamp(s, 0, 100) * 10) / 10, parts };
}

/** 公司对外显示名：地址去掉「北京市」和门牌括号，比两个都叫「公司」好认 */
export function placeName(w) {
  const a = String(w?.address || "").replace(/^北京市?/, "").replace(/[（(].*$/, "").trim();
  return a || w?.label || "公司";
}

export function shortlist(db, cond) {
  const { sql, args } = baseWhere(cond);
  const scanned = db.prepare(`SELECT COUNT(*) c FROM community WHERE ${sql}`).get(...args).c;

  // 只对「条件过滤后」的池子算通勤与学区；池子太大就按价格从低到高截断，
  // 避免一次请求对两千多个小区做全表距离计算。
  const pool = db.prepare(`SELECT * FROM community WHERE ${sql} ORDER BY price ASC LIMIT 1200`).all(...args);

  const allWps = db.prepare("SELECT * FROM workplace ORDER BY id").all();
  const wpById = new Map(allWps.map((w) => [w.id, w]));

  // 通勤要求落成公司对象；给了 id 却查不到就记一条警告，不静默当成「不限」
  const warnings = [];
  const commuteReqs = [];
  for (const x of cond.commutes) {
    if (x.wpId == null) continue;
    const wp = wpById.get(x.wpId);
    if (!wp) { warnings.push(`工作地点 #${x.wpId} 不在库里，这条通勤要求没生效`); continue; }
    commuteReqs.push({ wp, maxMin: x.maxMin });
  }

  const centers = new Map(bizCenters(db, cond.district || undefined).map((b) => [`${b.district}|${b.bizcircle}`, b]));
  const cacheStmt = db.prepare("SELECT * FROM transit_cache WHERE key = ?");
  const routeStmt = db.prepare("SELECT * FROM community_route WHERE community_id = ? AND wp_id = ?");
  const ranks = tierMap(db);
  const sctx = { schools: db.prepare("SELECT name, stage, lng, lat FROM school WHERE lng IS NOT NULL").all(), ranks };

  const kept = [];
  let droppedByCommute = 0, droppedBySchool = 0;

  for (const c of pool) {
    // 每条通勤要求都要满足（两个公司 = 两个都要卡住）
    const commutes = commuteReqs.map((r) => ({ ...r, t: commuteOf(db, c, r.wp, centers, cacheStmt, routeStmt) }));
    if (commutes.some((x) => x.maxMin != null && (!x.t || x.t.min > x.maxMin))) { droppedByCommute++; continue; }

    const schools = schoolFitAll(c, cond, sctx);
    const overSchool = schools.some(({ req, best }) => {
      if (req.tier) {
        const need = TIER_ORDER[req.tier];
        const got = best?.tier ? TIER_ORDER[best.tier] ?? 9 : 9;
        if (!best || got > need) return true;
      }
      if (req.maxKm != null && (!best || best.km > req.maxKm)) return true;
      return false;
    });
    if (overSchool) { droppedBySchool++; continue; }

    const { score, parts } = scoreOf(c, { cond, commutes, schools });
    kept.push({ c, commutes, schools, score, parts });
  }

  kept.sort((a, b) => b.score - a.score);
  const top = kept.slice(0, cond.topN);

  const candidates = top.map(({ c, commutes, schools, score, parts }) => {
    const brief = (s) => (s ? { stage: s.stage, name: s.name, tier: s.tier, km: s.km } : null);
    return {
      id: c.id,
      name: c.name,
      district: c.district,
      bizcircle: c.bizcircle,
      price: c.price,
      price_low: c.price_low,
      price_high: c.price_high,
      price_src_n: c.price_src_n,
      price_tx: c.price_tx,
      tx_n: c.tx_n,
      bargain: c.bargain,
      build_year: c.build_year,
      build_type: c.build_type,
      property_type: c.property_type,
      address: c.address,
      online: c.online,
      tags: c.tags,
      lng: c.lng,
      lat: c.lat,
      transit: allWps.map((w) => {
        const t = commuteOf(db, c, w, centers, cacheStmt, routeStmt);
        return { wp: w.id, label: placeName(w), min: t?.min ?? null, max: t?.max ?? null, source: t?.source ?? null, missing: !t, stale: false };
      }),
      // 学区：按每条要求各给一所（小学/初中可以都有）
      schools: schools.map(({ best }) => brief(best)).filter(Boolean),
      school: brief(schools[0]?.best),
      commute: commutes.map((x) => ({
        wp: x.wp.id, label: placeName(x.wp), maxMin: x.maxMin,
        min: x.t?.min ?? null, max: x.t?.max ?? null, source: x.t?.source ?? null,
      })),
      score,
      scoreParts: parts,
    };
  });

  const filters = [
    cond.district && { k: "区域", v: cond.district },
    cond.bizcircles.length && { k: "商圈", v: cond.bizcircles.join("、") },
    (cond.priceMin != null || cond.priceMax != null) && { k: "单价", v: `${cond.priceMin != null ? (cond.priceMin / 10000).toFixed(1) : "—"}–${cond.priceMax != null ? (cond.priceMax / 10000).toFixed(1) : "—"} 万/㎡` },
    cond.buildYearMin != null && { k: "建成年", v: `≥ ${cond.buildYearMin}` },
    ...commuteReqs.map((r) => r.maxMin != null && { k: "通勤", v: `到 ${placeName(r.wp)} ≤ ${r.maxMin} 分` }),
    cond.commutes.some((x) => x.wpId == null && x.maxMin != null) && { k: "通勤", v: `上限 ${cond.commutes.find((x) => x.wpId == null)?.maxMin} 分（未指定公司，未生效）` },
    ...cond.schools.map((sc) => ({ k: "学区", v: `${sc.stage === "中学" ? "初中" : "小学"}${sc.tier ? ` ${sc.tier}以内` : ""}${sc.maxKm ? ` · ${sc.maxKm}km 内` : ""}` })),
  ].filter(Boolean);

  const firstWp = commuteReqs[0]?.wp || null;
  return {
    conditions: cond,
    pool: { scanned, matched: kept.length, shortlist: candidates.length, droppedByCommute, droppedBySchool },
    filters,
    warnings,
    candidates,
    workplaces: commuteReqs.map((r) => ({ id: r.wp.id, label: r.wp.label, place: placeName(r.wp), address: r.wp.address, maxMin: r.maxMin })),
    workplace: firstWp ? { id: firstWp.id, label: firstWp.label, place: placeName(firstWp) } : null,
  };
}

/* ---------- 给模型的候选表（紧凑、无隐私、字段全部来自库） ---------- */
function candidateTable(cands) {
  return cands
    .map((c) => {
      const price = `${(c.price / 10000).toFixed(2)}万/㎡${c.price_src_n > 1 ? `(${c.price_src_n}源 ${(c.price_low / 10000).toFixed(2)}–${(c.price_high / 10000).toFixed(2)})` : ""}`;
      // 用户卡了哪个公司就报哪个；没卡时退回第一条有数的通勤
      const picked = (c.commute || []).filter((x) => x.min != null);
      const shown = picked.length ? picked : c.transit.filter((x) => x.min != null).slice(0, 1);
      const commute = shown.length
        ? shown.map((x) => `到${x.label} ${x.min}${x.max !== x.min ? `–${x.max}` : ""}分(${x.source})`).join(" / ")
        : "通勤未测";
      const sch = (c.schools?.length ? c.schools : c.school ? [c.school] : [])
        .map((x) => `${x.stage === "中学" ? "初中" : "小学"} ${x.name}${x.tier ? ` ${x.tier}` : " 未定档"} ${x.km}km`)
        .join(" + ") || "周边学校未收录";
      const extra = [
        c.build_year ? `${c.build_year}年建` : "建成年未知",
        c.bargain != null ? `议价${(c.bargain * 100).toFixed(0)}%` : null,
        c.price_tx ? `成交${(c.price_tx / 10000).toFixed(2)}万` : null,
        c.build_type || null,
        `本地分 ${c.score}`,
      ].filter(Boolean).join(" | ");
      return `id=${c.id} ${c.name}｜${c.district}·${c.bizcircle || "商圈未知"}｜${price}｜${commute}｜${sch}｜${extra}`;
    })
    .join("\n");
}

function conditionText(cond, wps) {
  const L = [];
  L.push(`区域：${cond.district || "通州 + 大兴（不限）"}`);
  if (cond.bizcircles.length) L.push(`限定商圈：${cond.bizcircles.join("、")}`);
  if (cond.priceMin != null || cond.priceMax != null) L.push(`单价区间：${cond.priceMin ?? "不限"}–${cond.priceMax ?? "不限"} 元/㎡`);
  if (cond.buildYearMin != null) L.push(`建成年 ≥ ${cond.buildYearMin}`);
  for (const w of wps || []) {
    if (w.maxMin != null) L.push(`到「${w.place || w.label}」通勤 ≤ ${w.maxMin} 分钟（公交+步行早高峰口径，两条以上要同时满足）`);
  }
  for (const sc of cond.schools) {
    L.push(`学区：${sc.stage === "中学" ? "初中" : "小学"}${sc.tier ? ` ${sc.tier}以内（含更好档）` : ""}${sc.maxKm ? `，${sc.maxKm} 公里内` : ""}`);
  }
  if (cond.brief) L.push(`用户补充：${cond.brief}`);
  return L.join("\n");
}

const SYSTEM = `你是北京「积分落户 · 选房决策台」的选房助手。用户为单人自用，目标是在通州/大兴（含经开区）选一套兼顾通勤与学区的住宅。

硬性规则：
1. 只能使用用户消息里给出的候选数据。禁止编造小区、价格、通勤分钟、学校名或梯队；数据没给的，就说没给。
2. 价格是小区挂牌均价（多源取中位、另给区间），不是成交价；通勤是公交+步行的早高峰口径；学区是「最近的学校 + 该校梯队」，不是官方对口。用户在意的正是这些代价，可以在风险里点出来，但不要夸张成结论。
3. 你的价值是取舍判断：哪套在通勤/学区/房龄/价格上更划算，让步在哪，需要现场核实什么。
4. 只输出一个 JSON 对象，不要 markdown 围栏、不要前后解释。所有文字用简体中文，理由里必须引用具体数字。`;

function userPrompt(cond, wps, cands, total) {
  return `用户条件：
${conditionText(cond, wps)}

候选（已按本地启发式初排，共 ${total} 个；这里给出前 ${cands.length} 个，字段全部来自本地库）：
${candidateTable(cands)}

请输出 JSON：
{
  "summary": "2–3 句。先说这轮筛选的取舍主线（例如通勤压得住但学区弱，或学区强但房龄老），再点名 2–3 个候选及其代价。",
  "picks": [
    { "id": <候选 id 数字>, "verdict": "≤12 字定位（如「通勤最优解」）", "reason": "≤55 字，引用具体数字说明为什么适合这位用户", "risk": "≤30 字，最需要核实或让步的点" }
  ]
}
picks 必须覆盖上面每一个候选，顺序即你的推荐顺序。`;
}

/* ---------- 路由 ---------- */
export function registerAi(app, db) {
  app.get("/api/ai/config", async () => {
    const s = aiStatus();
    return {
      enabled: s.enabled,
      model: s.model,
      // 只报「有没有配 key」，不回显 key 本身
      note: s.enabled ? "服务器本地模型（OpenAI 兼容）" : "未配置 LUOHU_AI_KEY，只出确定性结果",
    };
  });

  /* 自然语言 → 结构化条件：前端「按描述补全条件」用 */
  app.post("/api/ai/parse", async (req) => {
    const b = req.body || {};
    const brief = String(b.brief || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!brief) return { ok: false, error: "先写一句你的要求" };
    try {
      // bizcircle 表的列名是 name（对外接口才别名成 bizcircle）
      const biz = db.prepare("SELECT district, name FROM bizcircle WHERE active = 1 ORDER BY district, name").all();
      const bizText = biz.map((x) => `${x.name}(${x.district})`).join("、");
      // 公司清单：库里 label 常常都叫「公司」，只能靠地址区分，所以把地址给模型看
      const wps = db.prepare("SELECT id, label, address FROM workplace ORDER BY id").all();
      const wpText = wps.map((w) => `#${w.id} ${placeName(w)}｜${w.address || ""}`).join("；") || "（未录入工作地点）";
      const r = await chatJson([
        { role: "system", content: "你只做条件抽取，输出 JSON，不要解释。不确定的字段留 null。" },
        {
          role: "user",
          content: `把用户这句话抽取成选房筛选条件。只允许用下面列出的商圈名与公司，抽不到就留 null。

可用商圈：${bizText}

已录入的公司（用 address 里的地名辨认，例如「环球贸易」指 #4）：
${wpText}

字段定义：
- district: "通州" | "大兴" | "经开" | null（经开=亦庄/经济技术开发区）
- bizcircles: 字符串数组，最多 4 个，必须是上面列出的商圈名
- priceMax / priceMin: 单价，单位 元/㎡，整数。用户说「300 万」这类总价时不要换算成单价，留 null 并在 note 说明
- buildYearMin: 建成年下限，整数
- commutes: 数组，最多 2 条，每条 {"wpId": 上面公司里对应的数字, "maxMin": 通勤分钟上限}。用户点名了几个公司就写几条；只说「通勤 75 分钟」没点名公司时，用第一条并只填 maxMin
- schools: 数组，最多 2 条，每条 {"stage":"小学"|"中学", "tier":"一梯队"|"二梯队"|"三梯队"|null, "maxKm":数字|null}。用户同时提小学和初中就写两条
- note: ≤30 字，说明哪些要求没法落到字段上

用户的话：${brief}

输出：{"district":null,"bizcircles":[],"priceMax":null,"priceMin":null,"buildYearMin":null,"commutes":[],"schools":[],"note":""}`,
        },
      ], { maxTokens: 700, temperature: 0.1 });
      const parsed = r.parsed;
      // 商圈名做一次解析：库里叫「通州北苑」，用户/模型常说「北苑」；对不上就退回按原文匹配
      const norm = (t) => String(t).replace(/[（()）\s]/g, "");
      const resolveBiz = (x) => {
        const s = String(x || "").trim();
        if (s.length < 2) return null;
        const hit = biz.find((b) => b.name === s)
          || biz.find((b) => norm(b.name) === norm(s))
          || biz.find((b) => b.name.includes(s) || s.includes(b.name));
        return hit ? hit.name : null;
      };
      const fromModel = (Array.isArray(parsed.bizcircles) ? parsed.bizcircles : []).map(resolveBiz).filter(Boolean);
      const fromBrief = biz.filter((b) => b.name.length >= 2 && brief.includes(b.name)).map((b) => b.name);
      const bizcircles = [...new Set([...fromModel, ...fromBrief])].slice(0, 4);

      // 公司解析：模型给 id 就用 id，否则按地名在地址里做包含匹配（「环球贸易」→ 环球贸易中心）
      const rawCommutes = Array.isArray(parsed.commutes) ? parsed.commutes : [];
      const byId = new Map(wps.map((w) => [w.id, w]));
      const resolveWp = (x) => {
        const id = int(x?.wpId);
        if (id != null && byId.has(id)) return byId.get(id);
        const s = norm(x?.wpName || x?.company || "");
        if (s.length < 2) return null;
        return wps.find((w) => norm(w.address || "").includes(s)) || wps.find((w) => norm(w.label || "").includes(s)) || null;
      };
      const commutes = [];
      for (const x of rawCommutes) {
        const w = resolveWp(x);
        const maxMin = int(x?.maxMin);
        if (!w && maxMin == null) continue;
        if (w && commutes.some((o) => o.wpId === w.id)) {
          const i = commutes.findIndex((o) => o.wpId === w.id);
          if (maxMin != null) commutes[i].maxMin = maxMin;
          continue;
        }
        commutes.push({ wpId: w ? w.id : null, maxMin: maxMin != null ? clamp(maxMin, 5, 240) : null });
        if (commutes.length >= 2) break;
      }

      const rawSchools = Array.isArray(parsed.schools) ? parsed.schools : [];
      const schools = [];
      for (const x of rawSchools) {
        const stage = STAGES.includes(String(x?.stage || "")) ? String(x.stage) : "";
        const tier = TIERS.includes(String(x?.tier || "")) ? String(x.tier) : "";
        const km = Number(x?.maxKm) || null;
        if (!stage && !tier && km == null) continue;
        const entry = { stage: stage || "中学", tier, maxKm: km != null ? clamp(km, 0.3, 20) : null };
        const i = schools.findIndex((o) => o.stage === entry.stage);
        if (i >= 0) schools[i] = entry; else schools.push(entry);
        if (schools.length >= 2) break;
      }

      return {
        ok: true,
        parsed: {
          district: ["通州", "大兴", "经开"].includes(parsed.district) ? parsed.district : "",
          bizcircles,
          priceMax: int(parsed.priceMax),
          priceMin: int(parsed.priceMin),
          buildYearMin: int(parsed.buildYearMin),
          commutes,
          schools,
          // 旧字段镜像第一条
          maxMin: commutes[0]?.maxMin ?? null,
          wpId: commutes[0]?.wpId ?? null,
          schoolStage: schools[0]?.stage ?? "",
          schoolTier: schools[0]?.tier ?? "",
          maxKm: schools[0]?.maxKm ?? null,
          note: String(parsed.note || "").slice(0, 60),
        },
        model: r.model,
        ms: r.ms,
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  /* 主流程：筛库 + 模型解读 */
  app.post("/api/ai/pick", async (req) => {
    const cond = normalizeCond(req.body || {});
    const t0 = Date.now();
    let base;
    try {
      base = shortlist(db, cond);
    } catch (e) {
      // 筛库自己炸了就把原因原样返回，别变成 500 的白页
      return { ok: false, error: `筛库失败：${String(e.message || e)}`, elapsed: Date.now() - t0 };
    }

    let ai = null, aiError = null;
    if (base.candidates.length) {
      // 模型只解读前 6 个：候选表越长推理越啰嗦，一次调用能压到十几秒；
      // 第 7 名往后仍按本地分展示，不给 AI 文案。
      const focus = base.candidates.slice(0, 6);
      try {
        const r = await chatJson([
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt(cond, base.workplaces, focus, base.candidates.length) },
        ], { maxTokens: 3000, temperature: 0.35 });
        const parsed = r.parsed;

        // id 白名单：模型编出来的 id 直接丢掉，防止前端渲染出不存在的房子
        const byId = new Map(base.candidates.map((c) => [c.id, c]));
        const picks = (Array.isArray(parsed.picks) ? parsed.picks : [])
          .map((p, i) => {
            const c = byId.get(Number(p?.id));
            if (!c) return null;
            return {
              id: c.id,
              rank: i + 1,
              verdict: String(p.verdict || "").slice(0, 24),
              reason: String(p.reason || "").slice(0, 120),
              risk: String(p.risk || "").slice(0, 80),
            };
          })
          .filter(Boolean);

        ai = {
          summary: String(parsed.summary || "").slice(0, 600),
          picks,
          model: r.model,
          ms: r.ms,
          usage: r.usage,
        };
        if (!picks.length) aiError = "模型没有给出可用的候选解读（id 全部不匹配），下面是本地排序";
      } catch (e) {
        aiError = String(e.message || e);
      }
    }

    return { ok: true, ...base, ai, aiError, elapsed: Date.now() - t0 };
  });
}
