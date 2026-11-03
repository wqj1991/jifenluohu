// 维护台账：学校排名 / 小区学区 / 房价时点 / 政策参数
// 原则：只存"可回溯到来源"的记录；没有来源的字段一律不填，不猜。
import { attach, upsertSource, recalc, dropSource, sourceStats, sourceLabel } from "./prices.mjs";
import { routeStats } from "./route.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export function ensureMaintTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS school_rank (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id INTEGER,
      school_name TEXT NOT NULL,
      stage TEXT NOT NULL,
      region TEXT,
      year INTEGER NOT NULL,
      metric TEXT NOT NULL DEFAULT '综合',
      tier TEXT,
      rank INTEGER,
      score REAL,
      source TEXT,
      source_url TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rank_year ON school_rank(year, stage);

    CREATE TABLE IF NOT EXISTS community_zone (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      school_id INTEGER,
      school_name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '单校对口',
      group_name TEXT,
      authority TEXT,
      doc_ref TEXT,
      effective_from TEXT,
      verified INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_zone_comm ON community_zone(community_id);
    CREATE INDEX IF NOT EXISTS idx_zone_stage ON community_zone(stage);

    CREATE TABLE IF NOT EXISTS price_point (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      community_id INTEGER NOT NULL,
      ym TEXT NOT NULL,
      price INTEGER NOT NULL,
      source TEXT NOT NULL,
      n_samples INTEGER,
      fetched_at TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_price_comm ON price_point(community_id, ym);

    CREATE TABLE IF NOT EXISTS school_alias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id INTEGER NOT NULL,
      alias TEXT NOT NULL
    );
  `);

  // 老库补列：梯队（一梯队/二梯队/三梯队/民办·国际/其他梯队）
  const rankCols = db.prepare("PRAGMA table_info(school_rank)").all().map((c) => c.name);
  if (!rankCols.includes("tier")) db.exec("ALTER TABLE school_rank ADD COLUMN tier TEXT");
  // 老库补列：区域（通州/大兴/经开），有 school_id 的按 school.addr 反推
  if (!rankCols.includes("region")) {
    db.exec("ALTER TABLE school_rank ADD COLUMN region TEXT");
    backfillRegion(db);
  }
}

// 区域口径：经开区（亦庄）是独立招生单位，不与大兴混
export function regionOfAddr(addr) {
  const a = String(addr || "");
  if (a.includes("经济技术开发区")) return "经开";
  if (a.includes("通州")) return "通州";
  if (a.includes("大兴")) return "大兴";
  return null;
}

export function backfillRegion(db) {
  const pick = db.prepare("SELECT id, addr FROM school").all();
  const map = new Map(pick.map((s) => [s.id, regionOfAddr(s.addr)]));
  const upd = db.prepare("UPDATE school_rank SET region=? WHERE school_id=? AND (region IS NULL OR region='')");
  let n = 0;
  for (const [sid, region] of map) {
    if (!region) continue;
    n += Number(upd.run(region, sid).changes || 0);
  }
  return n;
}

const num = (v) => (v === "" || v == null ? null : Number(v));
const str = (v) => (v === "" || v == null ? null : String(v).trim());

export function registerMaint(app, db) {
  /* ---------------- 总览 ---------------- */
  app.get("/api/maint/summary", async () => {
    const comm = db
      .prepare(
        `SELECT COUNT(*) n,
                SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) withPrice,
                MAX(fetched_at) lastFetched
           FROM community`
      )
      .get();
    const sch = db.prepare("SELECT stage, COUNT(*) n FROM school GROUP BY stage").all();
    const rank = db
      .prepare(
        `SELECT COUNT(*) n, SUM(verified) v, MIN(year) y0, MAX(year) y1 FROM school_rank`
      )
      .get();
    const zone = db
      .prepare(
        `SELECT COUNT(*) n, SUM(verified) v, COUNT(DISTINCT community_id) comms FROM community_zone`
      )
      .get();
    const wp = db.prepare("SELECT COUNT(*) n FROM workplace").get();
    const tc = db.prepare("SELECT COUNT(*) n, MAX(fetched_at) last FROM transit_cache").get();
    const pol = db.prepare("SELECT COUNT(*) n, MAX(year) y FROM policy_year").get();
    const pricePoints = db.prepare("SELECT COUNT(*) n FROM price_point").get();
    const src = sourceStats(db);
    const multi = db
      .prepare("SELECT COUNT(*) c FROM community WHERE price_src_n > 1")
      .get().c;
    return {
      community: {
        n: comm.n || 0,
        withPrice: comm.withPrice || 0,
        coverage: comm.n ? Math.round(((comm.withPrice || 0) / comm.n) * 100) : 0,
        lastFetched: comm.lastFetched,
        missing: (comm.n || 0) - (comm.withPrice || 0),
        points: pricePoints.n || 0,
        sources: src.length,
        withMulti: multi || 0,
      },
      priceSources: src,
      school: {
        primary: sch.find((s) => s.stage === "小学")?.n || 0,
        middle: sch.find((s) => s.stage === "中学")?.n || 0,
        total: sch.reduce((a, s) => a + s.n, 0),
      },
      rank: { n: rank.n || 0, verified: rank.v || 0, years: rank.y0 ? [rank.y0, rank.y1] : null },
      zone: { n: zone.n || 0, verified: zone.v || 0, communities: zone.comms || 0 },
      workplace: { n: wp.n || 0 },
      transit: { cached: tc.n || 0, last: tc.last },
      route: routeStats(db),
      policy: { n: pol.n || 0, latest: pol.y },
    };
  });

  /* ---------------- 政策参数 ---------------- */
  app.get("/api/maint/policy", async () =>
    db.prepare("SELECT * FROM policy_year ORDER BY year").all()
  );

  app.post("/api/maint/policy", async (req) => {
    const b = req.body || {};
    const year = num(b.year);
    if (!year) return { ok: false, error: "缺少年度" };
    db.prepare(
      `INSERT INTO policy_year(year, cutoff, quota, apply_start, apply_end, deadline)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(year) DO UPDATE SET
         cutoff = excluded.cutoff, quota = excluded.quota,
         apply_start = excluded.apply_start, apply_end = excluded.apply_end,
         deadline = excluded.deadline`
    ).run(
      year,
      num(b.cutoff) ?? 0,
      num(b.quota),
      str(b.apply_start),
      str(b.apply_end),
      str(b.deadline)
    );
    return { ok: true };
  });

  app.delete("/api/maint/policy/:year", async (req) => {
    db.prepare("DELETE FROM policy_year WHERE year = ?").run(Number(req.params.year));
    return { ok: true };
  });

  /* ---------------- 房价台账 ---------------- */
  app.get("/api/maint/price", async (req) => {
    const { district, q, only = "", source = "", limit = 60, offset = 0 } = req.query;
    const where = ["1=1"];
    const args = [];
    if (district) { where.push("c.district = ?"); args.push(district); }
    if (q) { where.push("c.name LIKE ?"); args.push(`%${q}%`); }
    if (source) {
      where.push("EXISTS (SELECT 1 FROM community_price cp WHERE cp.community_id = c.id AND cp.source = ?)");
      args.push(source);
    }
    if (only === "missing") where.push("c.price IS NULL");
    if (only === "stale") where.push("c.fetched_at < date('now','-30 day')");
    if (only === "manual") where.push("EXISTS (SELECT 1 FROM community_price cp WHERE cp.community_id = c.id AND cp.source = 'manual')");
    if (only === "multi") where.push("c.price_src_n > 1");
    if (only === "single") where.push("c.price_src_n = 1");

    const sql = `
      SELECT c.id, c.name, c.district, c.bizcircle, c.price, c.price_low, c.price_high, c.price_src_n,
             c.source, c.fetched_at,
             (SELECT COUNT(*) FROM price_point p WHERE p.community_id = c.id) points,
             (SELECT MAX(ym) FROM price_point p WHERE p.community_id = c.id) last_ym
        FROM community c
       WHERE ${where.join(" AND ")}
       ORDER BY (c.price IS NULL), c.price DESC
       LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...args, Number(limit), Number(offset));
    attach(db, rows);
    const total = db.prepare(`SELECT COUNT(*) c FROM community c WHERE ${where.join(" AND ")}`).get(...args).c;
    const byDistrict = db
      .prepare(
        `SELECT district, COUNT(*) n,
                SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) withPrice
           FROM community GROUP BY district ORDER BY district`
      )
      .all();
    return { total, rows, byDistrict, sources: sourceStats(db) };
  });

  app.get("/api/maint/price-sources", async () => ({ rows: sourceStats(db) }));

  app.post("/api/maint/price", async (req) => {
    const b = req.body || {};
    const id = num(b.community_id);
    const price = num(b.price);
    if (!id || !price) return { ok: false, error: "缺少小区或单价" };
    const ym = str(b.ym) || today().slice(0, 7);
    const source = str(b.source) || "manual";
    // 一个源一行：同源再写就是覆盖（旧的同源历史留在 price_point 里）
    const r = upsertSource(db, {
      community_id: id,
      source,
      price,
      online: num(b.online),
      ym,
      url: str(b.url),
      source_id: str(b.source_id),
      note: str(b.note),
      fetched_at: today(),
    });
    if (!r.ok) return r;
    db.prepare(
      `INSERT INTO price_point(community_id, ym, price, source, n_samples, fetched_at, note)
       VALUES(?,?,?,?,?,?,?)`
    ).run(id, ym, price, source, num(b.n_samples), today(), str(b.note));
    return { ok: true, ym, source, ...r };
  });

  app.delete("/api/maint/price", async (req) => {
    const { community_id, source } = req.query;
    if (!community_id || !source) return { ok: false, error: "缺少小区或来源" };
    return dropSource(db, Number(community_id), String(source));
  });

  app.get("/api/maint/price/:id", async (req) => {
    const id = Number(req.params.id);
    const c = db.prepare("SELECT * FROM community WHERE id = ?").get(id);
    const points = db
      .prepare("SELECT * FROM price_point WHERE community_id = ? ORDER BY ym DESC")
      .all(id);
    const sources = db
      .prepare("SELECT * FROM community_price WHERE community_id = ? ORDER BY price DESC")
      .all(id)
      .map((s) => ({ ...s, label: sourceLabel(s.source) }));
    return { community: c || null, points, sources };
  });

  /* ---------------- 学校排名台账 ---------------- */
  app.get("/api/maint/rank", async (req) => {
    const { stage, year, q, verified = "", tier = "", region = "", limit = 300, offset = 0 } = req.query;
    const where = ["1=1"];
    const args = [];
    if (stage) { where.push("stage = ?"); args.push(stage); }
    if (year) { where.push("year = ?"); args.push(Number(year)); }
    if (tier) { where.push("tier = ?"); args.push(tier); }
    if (region) { where.push("region = ?"); args.push(region); }
    if (q) { where.push("school_name LIKE ?"); args.push(`%${q}%`); }
    if (verified === "1") where.push("verified = 1");
    if (verified === "0") where.push("verified = 0");
    const rows = db
      .prepare(
        `SELECT * FROM school_rank WHERE ${where.join(" AND ")}
          ORDER BY year DESC, stage,
            CASE tier WHEN '一梯队' THEN 1 WHEN '二梯队' THEN 2 WHEN '三梯队' THEN 3
                      WHEN '民办/国际' THEN 4 WHEN '其他梯队' THEN 5 ELSE 6 END,
            (rank IS NULL), rank, school_name LIMIT ? OFFSET ?`
      )
      .all(...args, Number(limit), Number(offset));
    const total = db.prepare(`SELECT COUNT(*) c FROM school_rank WHERE ${where.join(" AND ")}`).get(...args).c;
    const years = db
      .prepare("SELECT DISTINCT year FROM school_rank ORDER BY year DESC")
      .all()
      .map((r) => r.year);
    const byTier = db
      .prepare("SELECT COALESCE(tier,'未分档') t, COUNT(*) c FROM school_rank GROUP BY t ORDER BY c DESC")
      .all();
    const byRegion = db
      .prepare("SELECT COALESCE(region,'未分区') r, COUNT(*) c FROM school_rank GROUP BY r ORDER BY c DESC")
      .all();
    return { total, rows, years, byTier, byRegion };
  });

  app.post("/api/maint/rank", async (req) => {
    const b = req.body || {};
    const name = str(b.school_name);
    const year = num(b.year);
    if (!name || !year) return { ok: false, error: "缺少学校或年度" };
    const metric = str(b.metric) || "综合";
    const sid = num(b.school_id);
    const id = num(b.id);
    // 区域：有 school_id 时以学校地址为准，手填校名（无 school_id）时用手选值
    const schoolAddr = sid ? db.prepare("SELECT addr FROM school WHERE id=?").get(sid)?.addr : null;
    const region = regionOfAddr(schoolAddr) || str(b.region);
    const vals = [
      sid, name, str(b.stage) || "小学", region, year, metric, str(b.tier),
      num(b.rank), num(b.score), str(b.source), str(b.source_url),
      b.verified ? 1 : 0, str(b.note), now(),
    ];
    if (id) {
      db.prepare(
        `UPDATE school_rank SET school_id=?, school_name=?, stage=?, region=?, year=?, metric=?, tier=?,
           rank=?, score=?, source=?, source_url=?, verified=?, note=?, updated_at=? WHERE id=?`
      ).run(...vals, id);
      return { ok: true, id };
    }
    const dup = sid
      ? db.prepare("SELECT id FROM school_rank WHERE school_id=? AND year=? AND metric=?").get(sid, year, metric)
      : null;
    if (dup) {
      db.prepare(
        `UPDATE school_rank SET school_name=?, stage=?, region=?, tier=?, rank=?, score=?, source=?, source_url=?,
           verified=?, note=?, updated_at=? WHERE id=?`
      ).run(name, str(b.stage) || "小学", region, str(b.tier), num(b.rank), num(b.score), str(b.source), str(b.source_url), b.verified ? 1 : 0, str(b.note), now(), dup.id);
      return { ok: true, id: dup.id, merged: true };
    }
    const r = db.prepare(
      `INSERT INTO school_rank(school_id, school_name, stage, region, year, metric, tier, rank, score,
         source, source_url, verified, note, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(...vals);
    return { ok: true, id: Number(r.lastInsertRowid) };
  });

  app.delete("/api/maint/rank/:id", async (req) => {
    db.prepare("DELETE FROM school_rank WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });

  /* ---------------- 小区学区台账 ---------------- */
  app.get("/api/maint/zone", async (req) => {
    const { district, stage, q, verified = "", limit = 120, offset = 0 } = req.query;
    const where = ["1=1"];
    const args = [];
    if (district) { where.push("c.district = ?"); args.push(district); }
    if (stage) { where.push("z.stage = ?"); args.push(stage); }
    if (q) { where.push("(c.name LIKE ? OR z.school_name LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
    if (verified === "1") where.push("z.verified = 1");
    if (verified === "0") where.push("z.verified = 0");
    const rows = db
      .prepare(
        `SELECT z.*, c.name community_name, c.district, c.bizcircle
           FROM community_zone z JOIN community c ON c.id = z.community_id
          WHERE ${where.join(" AND ")}
          ORDER BY c.district, c.name, z.stage
          LIMIT ? OFFSET ?`
      )
      .all(...args, Number(limit), Number(offset));
    const total = db
      .prepare(
        `SELECT COUNT(*) c FROM community_zone z JOIN community c ON c.id = z.community_id
          WHERE ${where.join(" AND ")}`
      )
      .get(...args).c;
    const byDistrict = db
      .prepare(
        `SELECT c.district, COUNT(*) n FROM community_zone z JOIN community c ON c.id = z.community_id
          GROUP BY c.district`
      )
      .all();
    return { total, rows, byDistrict };
  });

  app.post("/api/maint/zone", async (req) => {
    const b = req.body || {};
    const cid = num(b.community_id);
    const school = str(b.school_name);
    if (!cid || !school) return { ok: false, error: "缺少小区或学校" };
    const vals = [
      cid, str(b.stage) || "小学", num(b.school_id), school,
      str(b.scope) || "单校对口", str(b.group_name), str(b.authority),
      str(b.doc_ref), str(b.effective_from), b.verified ? 1 : 0, str(b.note), now(),
    ];
    const id = num(b.id);
    if (id) {
      db.prepare(
        `UPDATE community_zone SET community_id=?, stage=?, school_id=?, school_name=?,
           scope=?, group_name=?, authority=?, doc_ref=?, effective_from=?, verified=?,
           note=?, updated_at=? WHERE id=?`
      ).run(...vals, id);
      return { ok: true, id };
    }
    const r = db.prepare(
      `INSERT INTO community_zone(community_id, stage, school_id, school_name, scope,
         group_name, authority, doc_ref, effective_from, verified, note, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(...vals);
    return { ok: true, id: Number(r.lastInsertRowid) };
  });

  app.delete("/api/maint/zone/:id", async (req) => {
    db.prepare("DELETE FROM community_zone WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });

  /* ---------------- 选择器 ---------------- */
  app.get("/api/maint/school", async (req) => {
    const { q, stage, limit = 20 } = req.query;
    const where = ["1=1"];
    const args = [];
    if (stage) { where.push("stage = ?"); args.push(stage); }
    if (q) { where.push("name LIKE ?"); args.push(`%${q}%`); }
    const rows = db
      .prepare(`SELECT id, name, stage, addr FROM school WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`)
      .all(...args, Number(limit));
    const total = db.prepare(`SELECT COUNT(*) c FROM school WHERE ${where.join(" AND ")}`).get(...args).c;
    return { total, rows };
  });

  app.get("/api/maint/community", async (req) => {
    const { q, district, limit = 20 } = req.query;
    const where = ["1=1"];
    const args = [];
    if (district) { where.push("district = ?"); args.push(district); }
    if (q) { where.push("name LIKE ?"); args.push(`%${q}%`); }
    const rows = db
      .prepare(
        `SELECT id, name, district, bizcircle, price FROM community
          WHERE ${where.join(" AND ")} ORDER BY (price IS NULL), price DESC LIMIT ?`
      )
      .all(...args, Number(limit));
    const total = db.prepare(`SELECT COUNT(*) c FROM community WHERE ${where.join(" AND ")}`).get(...args).c;
    return { total, rows };
  });

  /* ---------------- 公司地点 & 线路 ---------------- */
  app.get("/api/maint/workplace", async () => {
    const rows = db.prepare("SELECT * FROM workplace ORDER BY person_id, id").all();
    const biz = db.prepare("SELECT district, COUNT(*) n FROM bizcenter GROUP BY district").all();
    const tx = db
      .prepare("SELECT COUNT(*) n, MAX(fetched_at) last FROM transit_cache")
      .get();
    return { rows, biz, transit: { cached: tx.n || 0, last: tx.last } };
  });
}

export const _internal = { today, num, str };
