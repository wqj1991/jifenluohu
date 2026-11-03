// 选房：工作地点、通勤计算、小区聚合查询
// 高德 key 走环境变量 AMAP_KEY，不落库不入仓
import { attach } from "./prices.mjs";

const AMAP = "https://restapi.amap.com/v3";
const KEY = () => process.env.AMAP_KEY || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, params) {
  const q = new URLSearchParams({ ...params, key: KEY() });
  const r = await fetch(`${AMAP}${path}?${q}`);
  if (!r.ok) throw new Error(`amap http ${r.status}`);
  return r.json();
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workplace(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      label TEXT,
      address TEXT,
      lng REAL, lat REAL,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bizcenter(
      key TEXT PRIMARY KEY,
      district TEXT, bizcircle TEXT,
      lng REAL, lat REAL, n INTEGER
    );
  `);
}

/* ---------- 地理编码 ---------- */
export async function geocode(address) {
  if (!KEY()) throw new Error("AMAP_KEY 未配置");
  const j = await api("/geocode/geo", { address, city: "北京" });
  if (j.status !== "1" || !j.geocodes?.length) throw new Error(j.info || "地址无法解析");
  const g = j.geocodes[0];
  const [lng, lat] = g.location.split(",").map(Number);
  return { lng, lat, formatted: g.formatted_address, level: g.level };
}

/* ---------- 单次通勤（公交+步行，早高峰口径） ---------- */
const stopName = (s) => (s && (s.name || s.location)) || "";

// 一个换乘段读成人话：地铁优先读铁路段，其次读公交段，步行只在超过 60 米时记一笔
// 注意高德 v3 的段里 railway / bus.buslines 不管有没有都占位（空对象或空数组），必须看 name 有没有值
function segText(s) {
  const rw = s.railway;
  if (rw && rw.name) {
    return `${rw.name} ${stopName(rw.departure_stop)} → ${stopName(rw.arrival_stop)}`;
  }
  const bl = s.bus?.buslines?.[0];
  if (bl && bl.name) {
    const via = Number(bl.via_num) || 0;
    const head = stopName(bl.departure_stop);
    const tail = stopName(bl.arrival_stop);
    return `${bl.name} ${head} → ${tail}${via ? `（${via} 站）` : ""}`;
  }
  const w = Number(s.walking?.distance) || 0;
  return w >= 60 ? `步行 ${Math.round(w)} 米` : "";
}

export async function transitOnce(from, to) {
  const j = await api("/direction/transit/integrated", {
    origin: `${from.lng},${from.lat}`,
    destination: `${to.lng},${to.lat}`,
    city: "北京",
    cityd: "北京",
    strategy: "0",
    nightflag: "0",
  });
  if (j.status !== "1") return null;
  const ts = j.route?.transits || [];
  if (!ts.length) return null;
  // 只取最短的三个方案做区间，避免把绕路方案算进上限
  const arr = ts
    .map((t) => ({ t, m: Math.round(Number(t.duration) / 60), d: Number(t.distance) || 0 }))
    .filter((x) => x.m > 0)
    .sort((a, b) => a.m - b.m);
  if (!arr.length) return null;
  const top = arr.slice(0, 3);
  // 线路摘要只取最快方案：区间上限那个方案可能是绕路方案，写出来会误导
  const segs = arr[0].t.segments || [];
  const legs = segs.filter((s) => s.bus?.buslines?.length || s.railway).length;
  const walk = segs.reduce((a, s) => a + (Number(s.walking?.distance) || 0), 0);
  return {
    min: top[0].m,
    max: top[top.length - 1].m,
    distance_m: top[0].d,
    options: arr.length,
    transfers: Math.max(0, legs - 1),
    walk_m: Math.round(walk),
    line_text: segs.map(segText).filter(Boolean).join(" → ") || null,
  };
}

export const cacheKey = (a, b) =>
  `${round3(a.lng)},${round3(a.lat)}>${round3(b.lng)},${round3(b.lat)}`;

/* ---------- 商圈质心 ---------- */
export function bizCenters(db, district) {
  const rows = db
    .prepare(
      `SELECT district, bizcircle, AVG(lng) lng, AVG(lat) lat, COUNT(*) n
       FROM community
       WHERE lng IS NOT NULL AND bizcircle IS NOT NULL ${district ? "AND district = ?" : ""}
       GROUP BY district, bizcircle`
    )
    .all(...(district ? [district] : []));
  const ins = db.prepare(
    `INSERT INTO bizcenter(key,district,bizcircle,lng,lat,n) VALUES(?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET lng=excluded.lng, lat=excluded.lat, n=excluded.n`
  );
  for (const r of rows) ins.run(`${r.district}|${r.bizcircle}`, r.district, r.bizcircle, r.lng, r.lat, r.n);
  return rows;
}

/* ---------- 为某个工作地点预计算所有商圈通勤（带缓存） ---------- */
export async function precompute(db, wpId, opts = {}) {
  const wp = db.prepare("SELECT * FROM workplace WHERE id = ?").get(wpId);
  if (!wp) throw new Error("工作地点不存在");
  const centers = bizCenters(db, opts.district);
  const getCache = db.prepare("SELECT * FROM transit_cache WHERE key = ?");
  const putCache = db.prepare(
    `INSERT INTO transit_cache(key,minutes_min,minutes_max,distance_m,fetched_at)
     VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
     minutes_min=excluded.minutes_min, minutes_max=excluded.minutes_max,
     distance_m=excluded.distance_m, fetched_at=excluded.fetched_at`
  );

  let hit = 0, miss = 0, fail = 0;
  const now = new Date().toISOString().slice(0, 10);
  for (const c of centers) {
    const k = cacheKey(c, wp);
    const prev = getCache.get(k);
    if (prev && prev.fetched_at === now) { hit++; continue; }
    let t = null;
    try { t = await transitOnce(c, wp); } catch { fail++; await sleep(350); continue; }
    if (t) { putCache.run(k, t.min, t.max, t.distance_m, now); miss++; }
    else fail++;
    await sleep(300);
  }
  return { centers: centers.length, hit, miss, fail };
}

/* ---------- 小区查询（带商圈通勤） ---------- */
export function rows(db, q) {
  const { district, maxPrice, minPrice, minYear, maxYear, bizcircle, kw,
    limit = 50, offset = 0, sort = "deal", wps = "", basis = "mid" } = q;
  // 多源时价格有区间：mid=中位（默认，主口径） low=最低报价 high=最高报价
  const pcol = basis === "low" ? "price_low" : basis === "high" ? "price_high" : "price";
  const where = ["lng IS NOT NULL"];
  if (q.withNoPrice !== "1") where.push(`${pcol} IS NOT NULL`);
  if (q.includeVillage !== "1") where.push("name NOT LIKE '%村住房%'");
  if (q.includeNonResi !== "1") where.push("property_type IN ('住宅','别墅')");
  where.push("name NOT LIKE '%(新房)%'", "name NOT LIKE '%(商业)%'", "name NOT LIKE '%(商住)%'", "name NOT LIKE '%(公寓)%'", "name NOT LIKE '%(别墅)%'");
  if (!minPrice && q.includeCheap !== "1") where.push(`${pcol} >= 10000`);
  const args = [];
  if (district) { where.push("district = ?"); args.push(district); }
  if (bizcircle) { where.push("bizcircle = ?"); args.push(bizcircle); }
  if (minPrice) { where.push(`${pcol} >= ?`); args.push(Number(minPrice)); }
  if (maxPrice) { where.push(`${pcol} <= ?`); args.push(Number(maxPrice)); }
  if (minYear) { where.push("build_year >= ?"); args.push(Number(minYear)); }
  if (maxYear) { where.push("build_year <= ?"); args.push(Number(maxYear)); }
  if (kw) { where.push("name LIKE ?"); args.push(`%${kw}%`); }
  const order =
    sort === "deal" || sort === "" ? "(price_tx IS NULL), price ASC" :
    sort === "price-desc" ? `${pcol} DESC` :
    sort === "year-desc" ? "build_year DESC" :
    sort === "bargain" ? "bargain DESC" :
    `${pcol} ASC`;

  const W = where.join(" AND ");
  const allMode = sort === "commute";
  const list = allMode
    ? db.prepare(`SELECT * FROM community WHERE ${W} ORDER BY ${pcol} ASC LIMIT 4000`).all(...args)
    : db.prepare(`SELECT * FROM community WHERE ${W} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, Number(limit), Number(offset));

  const total = db.prepare(`SELECT COUNT(*) c FROM community WHERE ${W}`).get(...args).c;

  // 通勤：小区实测路线（community_route）优先，没测到的才退回商圈质心估计（transit_cache）
  const wpIds = String(wps).split(",").filter(Boolean).map(Number);
  const workplaces = wpIds.length
    ? db.prepare(`SELECT * FROM workplace WHERE id IN (${wpIds.map(() => "?").join(",")})`).all(...wpIds)
    : [];
  const bc = db.prepare("SELECT * FROM bizcenter").all();
  const centerMap = new Map(bc.map((b) => [`${b.district}|${b.bizcircle}`, b]));
  const getCache = db.prepare("SELECT * FROM transit_cache WHERE key = ?");
  // 台账表由 route.mjs 建；万一还没建，退回纯估算，别让整页 500
  let getRoute = null;
  try {
    getRoute = db.prepare("SELECT * FROM community_route WHERE community_id = ? AND wp_id = ?");
  } catch { getRoute = null; }
  const today = new Date().toISOString().slice(0, 10);

  for (const r of list) {
    r.transit = workplaces.map((w) => {
      const rt = getRoute ? getRoute.get(r.id, w.id) : null;
      if (rt && rt.minutes_min != null) {
        return {
          wp: w.id, label: w.label,
          min: rt.minutes_min, max: rt.minutes_max ?? rt.minutes_min,
          distance_m: rt.distance_m, walk_m: rt.walk_m, transfers: rt.transfers,
          line_text: rt.line_text,
          source: rt.source === "manual" ? "实测" : "路线",
          stale: rt.fetched_at !== today,
          missing: false,
        };
      }
      const c = centerMap.get(`${r.district}|${r.bizcircle}`);
      if (!c) return { wp: w.id, label: w.label, min: null, max: null, stale: false, missing: true };
      const row = getCache.get(cacheKey(c, w));
      return {
        wp: w.id, label: w.label,
        min: row?.minutes_min ?? null,
        max: row?.minutes_max ?? null,
        distance_m: row?.distance_m ?? null,
        source: row ? "商圈估算" : null,
        stale: row ? row.fetched_at !== today : false,
        missing: !row,
      };
    });
  }

  if (allMode) {
    const wp0 = wpIds[0];
    list.sort((a, b) => {
      const ta = (a.transit || []).find((t) => t.wp === wp0)?.min ?? 9999;
      const tb = (b.transit || []).find((t) => t.wp === wp0)?.min ?? 9999;
      return ta - tb;
    });
  }
  const out = allMode ? list.slice(Number(offset), Number(offset) + Number(limit)) : list;
  attach(db, out);
  return {
    total,
    rows: out,
    workplaces,
    priceBasis: pcol === "price" ? "mid" : basis,
  };
}

/* ---------- 单点精确对比（覆盖商圈估计） ---------- */
export async function exactTransit(db, communityId, wpId) {
  const c = db.prepare("SELECT * FROM community WHERE id = ?").get(communityId);
  const w = db.prepare("SELECT * FROM workplace WHERE id = ?").get(wpId);
  if (!c || !w) throw new Error("参数无效");
  // 台账里已经有这条实测（community_route），直接用它，不再打一次高德
  let route = null;
  try {
    route = db.prepare("SELECT * FROM community_route WHERE community_id = ? AND wp_id = ?").get(communityId, wpId);
  } catch { route = null; }
  if (route && route.minutes_min != null) {
    return {
      min: route.minutes_min, max: route.minutes_max ?? route.minutes_min,
      distance_m: route.distance_m, walk_m: route.walk_m, line_text: route.line_text,
      source: route.source === "manual" ? "实测" : "路线", cached: true,
    };
  }
  const k = cacheKey(c, w);
  const prev = db.prepare("SELECT * FROM transit_cache WHERE key = ?").get(k);
  const today = new Date().toISOString().slice(0, 10);
  if (prev && prev.fetched_at === today) {
    return { min: prev.minutes_min, max: prev.minutes_max, distance_m: prev.distance_m, cached: true };
  }
  const t = await transitOnce(c, w);
  if (!t) throw new Error("无可用公交方案");
  db.prepare(
    `INSERT INTO transit_cache(key,minutes_min,minutes_max,distance_m,fetched_at)
     VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
     minutes_min=excluded.minutes_min, minutes_max=excluded.minutes_max,
     distance_m=excluded.distance_m, fetched_at=excluded.fetched_at`
  ).run(k, t.min, t.max, t.distance_m, today);
  // 同时写进台账，选房列表下次直接读实测值，不必再点「精确」
  try {
    db.prepare(
      `INSERT INTO community_route(community_id, wp_id, mode, minutes_min, minutes_max, distance_m,
          walk_m, transfers, line_text, depart_at, source, fetched_at, verified, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(community_id, wp_id) DO UPDATE SET
         minutes_min=excluded.minutes_min, minutes_max=excluded.minutes_max,
         distance_m=excluded.distance_m, walk_m=excluded.walk_m,
         transfers=excluded.transfers, line_text=excluded.line_text,
         source=excluded.source, fetched_at=excluded.fetched_at, updated_at=excluded.updated_at`
    ).run(
      communityId, wpId, "公交", t.min, t.max, t.distance_m ?? null,
      t.walk_m ?? null, t.transfers ?? null, t.line_text ?? null,
      "08:10", "amap", today, 0, new Date().toISOString().replace("T", " ").slice(0, 19)
    );
  } catch { /* 台账表不在时只落缓存，不影响这次返回 */ }
  return { ...t, cached: false };
}

/* ---------- 最近学校（距离代理，非对口） ---------- */
export function nearbySchools(db, lng, lat, limit = 4) {
  const rows = db.prepare("SELECT id,name,stage,addr,lng,lat FROM school WHERE lng IS NOT NULL").all();
  const d2 = (a, b, c, e) => {
    const x = (a - c) * 111 * Math.cos((b * Math.PI) / 180);
    const y = (b - e) * 111;
    return Math.sqrt(x * x + y * y);
  };
  const dist = rows
    .map((s) => ({ ...s, km: Math.round(d2(lng, lat, s.lng, s.lat) * 10) / 10 }))
    .sort((a, b) => a.km - b.km);
  // 小学与中学各取最近的 limit 所（只用小学会看不出对口初中的量级）
  return [
    ...dist.filter((s) => s.stage === "小学").slice(0, limit),
    ...dist.filter((s) => s.stage === "中学").slice(0, limit),
  ];
}
