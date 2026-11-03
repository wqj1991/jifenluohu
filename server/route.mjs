// 小区 → 公司 的「路线与时间」台账
// 口径：高德早高峰公交 + 步行。一个 (小区, 工作地点) 一行，实测（amap）与手填（manual）都落这里，
// 手填优先展示——你实际走过的路，比接口算出来的更算数。
// 没有记录的行退回商圈质心估计值（transit_cache），标 estimate，不冒充实测。
import { transitOnce, cacheKey, bizCenters } from "./house.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === "" || v == null ? null : Number(v));
const str = (v) => (v === "" || v == null ? null : String(v).trim());

const DEPART = "08:10"; // 早高峰出发时刻，用来反推到达
const STALE_DAYS = 30;

export function ensureRouteTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_route (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER NOT NULL,
      wp_id INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT '公交',
      minutes_min INTEGER,
      minutes_max INTEGER,
      distance_m INTEGER,
      walk_m INTEGER,
      transfers INTEGER,
      line_text TEXT,
      depart_at TEXT,
      source TEXT NOT NULL DEFAULT 'manual',   -- amap | manual
      fetched_at TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TEXT,
      UNIQUE(community_id, wp_id)
    );
    CREATE INDEX IF NOT EXISTS idx_route_wp ON community_route(wp_id);
    CREATE INDEX IF NOT EXISTS idx_route_comm ON community_route(community_id);
  `);
}

export function routeStats(db) {
  const r = db
    .prepare(
      `SELECT COUNT(*) n,
              SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) manual,
              SUM(CASE WHEN source <> 'manual' THEN 1 ELSE 0 END) amap,
              SUM(verified) verified,
              COUNT(DISTINCT community_id) comms,
              COUNT(DISTINCT wp_id) wps,
              AVG(minutes_min) avg_min,
              MAX(fetched_at) last,
              SUM(CASE WHEN fetched_at < date('now','-${STALE_DAYS} day') THEN 1 ELSE 0 END) stale
         FROM community_route`
    )
    .get();
  return {
    n: r.n || 0,
    manual: r.manual || 0,
    amap: r.amap || 0,
    verified: r.verified || 0,
    communities: r.comms || 0,
    wps: r.wps || 0,
    avgMin: r.avg_min == null ? null : Math.round(r.avg_min),
    last: r.last || null,
    stale: r.stale || 0,
  };
}

/* ---------- 写一行（实测与手填共用） ---------- */
function upsert(db, b) {
  db.prepare(
    `INSERT INTO community_route(
        community_id, wp_id, mode, minutes_min, minutes_max, distance_m, walk_m,
        transfers, line_text, depart_at, source, fetched_at, verified, note, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(community_id, wp_id) DO UPDATE SET
        mode = excluded.mode,
        minutes_min = excluded.minutes_min,
        minutes_max = excluded.minutes_max,
        distance_m = excluded.distance_m,
        walk_m = excluded.walk_m,
        transfers = excluded.transfers,
        line_text = excluded.line_text,
        depart_at = excluded.depart_at,
        source = excluded.source,
        fetched_at = excluded.fetched_at,
        verified = excluded.verified,
        note = excluded.note,
        updated_at = excluded.updated_at`
  ).run(
    b.community_id, b.wp_id, b.mode || "公交",
    b.minutes_min ?? null, b.minutes_max ?? null,
    b.distance_m ?? null, b.walk_m ?? null, b.transfers ?? null,
    b.line_text ?? null, b.depart_at || DEPART,
    b.source || "manual", b.fetched_at || today(),
    b.verified ? 1 : 0, b.note ?? null, now()
  );
  return db
    .prepare("SELECT * FROM community_route WHERE community_id = ? AND wp_id = ?")
    .get(b.community_id, b.wp_id);
}

/* ---------- 测一条 ---------- */
export async function measureOne(db, communityId, wpId) {
  if (!process.env.AMAP_KEY) throw new Error("AMAP_KEY 未配置，先补 .env");
  const c = db.prepare("SELECT * FROM community WHERE id = ?").get(communityId);
  const w = db.prepare("SELECT * FROM workplace WHERE id = ?").get(wpId);
  if (!c || !w) throw new Error("小区或工作地点不存在");
  if (c.lng == null || c.lat == null) throw new Error("小区没有坐标");
  if (w.lng == null || w.lat == null) throw new Error("工作地点没有坐标");
  const prev = db
    .prepare("SELECT * FROM community_route WHERE community_id = ? AND wp_id = ?")
    .get(communityId, wpId);
  // 你亲自跑过并核实的那条，不能被接口结果悄悄顶掉
  if (prev && prev.source === "manual" && prev.verified) {
    throw new Error("这条是手填且已核实，重测会覆盖它；要重测先在「改」里取消核实");
  }
  const t = await transitOnce(c, w);
  if (!t) throw new Error("高德没有返回公交方案");
  return upsert(db, {
    community_id: communityId,
    wp_id: wpId,
    mode: "公交",
    minutes_min: t.min,
    minutes_max: t.max,
    distance_m: t.distance_m,
    walk_m: t.walk_m,
    transfers: t.transfers,
    line_text: t.line_text,
    depart_at: prev?.depart_at || DEPART,
    source: "amap",
    fetched_at: today(),
    // 手填时勾的「已核实」不因为重测就被清掉：重测只换时间和线路
    verified: prev?.verified ? 1 : 0,
    note: prev?.note ?? null,
  });
}

/* ---------- 批量补测 ---------- */
export async function measureBatch(db, b) {
  if (!process.env.AMAP_KEY) throw new Error("AMAP_KEY 未配置，先补 .env");
  const wpId = num(b.wp_id ?? b.wpId);
  const wp = db.prepare("SELECT * FROM workplace WHERE id = ?").get(wpId);
  if (!wp) throw new Error("工作地点不存在");
  const limit = Math.min(Math.max(Number(b.limit) || 20, 1), 200);
  const district = str(b.district);
  const only = str(b.only) || "missing";

  const where = ["c.lng IS NOT NULL", "c.lat IS NOT NULL"];
  const args = [wpId];
  if (district) { where.push("c.district = ?"); args.push(district); }
  if (only === "missing") where.push("r.id IS NULL");
  if (only === "stale") where.push(`r.fetched_at < date('now','-${STALE_DAYS} day')`);
  // 手填并核实过的不进批量队列：那是你亲自跑的数字
  // 注意 LEFT JOIN 下没有记录时 r.source 是 NULL，`NOT (r.source = 'manual')` 会算成 NULL 把整行滤掉
  if (only !== "all") where.push("(r.id IS NULL OR r.source <> 'manual' OR r.verified = 0)");
  const list = db
    .prepare(
      `SELECT c.id, c.name FROM community c
         LEFT JOIN community_route r ON r.community_id = c.id AND r.wp_id = ?
        WHERE ${where.join(" AND ")}
        ORDER BY (c.price IS NULL), c.price DESC
        LIMIT ?`
    )
    .all(...args, limit);

  const t0 = Date.now();
  let hit = 0;
  const fail = [];
  for (const c of list) {
    try {
      await measureOne(db, c.id, wpId);
      hit++;
    } catch (e) {
      fail.push(`${c.name}：${String(e.message || e)}`);
    }
    await sleep(320); // 高德余额有限的 key，别把并发和频率拉满
  }
  const remaining = db
    .prepare(
      `SELECT COUNT(*) n FROM community c
         LEFT JOIN community_route r ON r.community_id = c.id AND r.wp_id = ?
        WHERE c.lng IS NOT NULL ${district ? "AND c.district = ?" : ""} AND r.id IS NULL`
    )
    .get(...(district ? [wpId, district] : [wpId])).n;
  return {
    requested: list.length,
    hit,
    fail: fail.length,
    sample: fail.slice(0, 3),
    remaining,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

/* ---------- 列表：小区 × 选定工作地点 ---------- */
export function routeRows(db, q) {
  const district = str(q.district) || "";
  const kw = str(q.q) || "";
  const only = str(q.only) || "";
  const sort = str(q.sort) || "min";
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const wps = db.prepare("SELECT * FROM workplace ORDER BY person_id, id").all();
  const wpId = num(q.wpId);
  const wp = wpId ? wps.find((w) => w.id === wpId) || null : wps[0] || null;

  const out = {
    wps,
    wp,
    departDefault: DEPART,
    staleDays: STALE_DAYS,
    total: 0,
    rows: [],
    stats: routeStats(db),
    byDistrict: [],
    coverage: { communities: 0, recorded: 0 },
  };
  if (!wp) return out;

  if (!db.prepare("SELECT COUNT(*) c FROM bizcenter").get().c) bizCenters(db);

  const where = ["c.lng IS NOT NULL"];
  const args = [];
  if (district) { where.push("c.district = ?"); args.push(district); }
  if (kw) { where.push("c.name LIKE ?"); args.push(`%${kw}%`); }
  const comms = db
    .prepare(
      `SELECT c.id, c.name, c.district, c.bizcircle, c.price, c.lng, c.lat
         FROM community c WHERE ${where.join(" AND ")}`
    )
    .all(...args);

  const recs = new Map(
    db.prepare("SELECT * FROM community_route WHERE wp_id = ?").all(wp.id).map((r) => [r.community_id, r])
  );
  const centers = new Map(
    db.prepare("SELECT * FROM bizcenter").all().map((b) => [`${b.district}|${b.bizcircle}`, b])
  );
  const getCache = db.prepare("SELECT * FROM transit_cache WHERE key = ?");
  const staleBefore = new Date(Date.now() - STALE_DAYS * 86400000).toISOString().slice(0, 10);

  const all = comms.map((c) => {
    const rec = recs.get(c.id) || null;
    const cen = centers.get(`${c.district}|${c.bizcircle}`);
    const cr = cen ? getCache.get(cacheKey(cen, wp)) : null;
    const est = cr
      ? { min: cr.minutes_min, max: cr.minutes_max, distance_m: cr.distance_m, fetched_at: cr.fetched_at }
      : null;
    const eff = rec
      ? { min: rec.minutes_min, max: rec.minutes_max, distance_m: rec.distance_m, fetched_at: rec.fetched_at }
      : est;
    return {
      id: c.id,
      name: c.name,
      district: c.district,
      bizcircle: c.bizcircle,
      price: c.price,
      rec,
      est,
      source: rec ? (rec.source === "manual" ? "manual" : "amap") : est ? "estimate" : null,
      min: eff ? eff.min : null,
      max: eff ? eff.max : null,
      distance_m: eff ? eff.distance_m : null,
      fetched_at: eff ? eff.fetched_at : null,
      stale: !!(eff && eff.fetched_at && eff.fetched_at < staleBefore),
    };
  });

  const kept = all.filter((r) =>
    only === "measured" ? r.source === "amap" :
    only === "manual" ? r.source === "manual" :
    only === "estimate" ? r.source === "estimate" :
    only === "missing" ? !r.source :
    only === "stale" ? r.stale :
    true
  );

  const cmpName = (a, b) => a.name.localeCompare(b.name, "zh");
  const by =
    sort === "name" ? cmpName :
    sort === "min-desc" ? (a, b) => (b.min ?? 9999) - (a.min ?? 9999) || cmpName(a, b) :
    sort === "price" ? (a, b) => (b.price ?? 0) - (a.price ?? 0) || cmpName(a, b) :
    sort === "distance" ? (a, b) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9) || cmpName(a, b) :
    (a, b) => (a.min ?? 9999) - (b.min ?? 9999) || cmpName(a, b);
  kept.sort(by);

  const byDistrict = db
    .prepare(
      `SELECT c.district, COUNT(*) n,
              SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END) recorded
         FROM community c
         LEFT JOIN community_route r ON r.community_id = c.id AND r.wp_id = ?
        WHERE c.lng IS NOT NULL
        GROUP BY c.district ORDER BY c.district`
    )
    .all(wp.id);

  return {
    ...out,
    total: kept.length,
    rows: kept.slice(offset, offset + limit),
    byDistrict,
    coverage: {
      communities: comms.length,
      recorded: all.filter((r) => r.rec).length,
    },
  };
}

/* ---------- 接口 ---------- */
export function registerRoute(app, db) {
  app.get("/api/maint/route", async (req) => routeRows(db, req.query));

  app.post("/api/maint/route", async (req) => {
    const b = req.body || {};
    const cid = num(b.community_id);
    const wid = num(b.wp_id);
    if (!cid) return { ok: false, error: "缺少小区" };
    if (!wid) return { ok: false, error: "缺少工作地点" };
    if (!db.prepare("SELECT 1 FROM community WHERE id = ?").get(cid)) return { ok: false, error: "小区不在册" };
    if (!db.prepare("SELECT 1 FROM workplace WHERE id = ?").get(wid)) return { ok: false, error: "工作地点不在册" };
    let min = num(b.minutes_min);
    let max = num(b.minutes_max);
    if (min == null) return { ok: false, error: "缺少最快耗时" };
    if (min <= 0) return { ok: false, error: "耗时得是正的分钟数" };
    if (max == null) max = min;
    if (max < min) [min, max] = [max, min];
    const row = upsert(db, {
      community_id: cid,
      wp_id: wid,
      mode: str(b.mode) || "公交",
      minutes_min: min,
      minutes_max: max,
      distance_m: num(b.distance_m),
      walk_m: num(b.walk_m),
      transfers: num(b.transfers),
      line_text: str(b.line_text),
      depart_at: str(b.depart_at) || DEPART,
      source: str(b.source) || "manual",
      fetched_at: today(),
      verified: b.verified,
      note: str(b.note),
    });
    return { ok: true, row };
  });

  app.delete("/api/maint/route/:id", async (req) => {
    const id = Number(req.params.id);
    const before = db.prepare("SELECT * FROM community_route WHERE id = ?").get(id);
    if (!before) return { ok: false, error: "记录不存在" };
    db.prepare("DELETE FROM community_route WHERE id = ?").run(id);
    return { ok: true, removed: before };
  });

  // 单条：传 community_id + wp_id；批量：只传 wp_id
  app.post("/api/maint/route/measure", async (req) => {
    const b = req.body || {};
    try {
      const cid = num(b.community_id);
      if (cid) {
        const row = await measureOne(db, cid, num(b.wp_id));
        return { ok: true, row };
      }
      return { ok: true, ...(await measureBatch(db, b)) };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
}

export const _internal = { upsert, DEPART, STALE_DAYS };
