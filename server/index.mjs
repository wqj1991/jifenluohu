import Fastify from "fastify";
import cors from "@fastify/cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "./db.mjs";
import { compute, project, round } from "./engine.mjs";
import { ensureTables, geocode, precompute, rows as houseRows, exactTransit, nearbySchools, bizCenters } from "./house.mjs";
import { ensureMaintTables, registerMaint } from "./maint.mjs";
import { ensureRouteTable, registerRoute } from "./route.mjs";
import { attach } from "./prices.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dir, "..", ".env")); } catch { /* 无 .env 时靠系统环境变量 */ }

const db = open();
ensureTables(db);
ensureMaintTables(db);
ensureRouteTable(db);
const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
registerMaint(app, db);
registerRoute(app, db);

function loadPerson(id) {
  id = Number(id) || 1;
  const person = db.prepare("SELECT * FROM person WHERE id = ?").get(id);
  if (!person) return null;
  return {
    ...person,
    employment: db.prepare("SELECT * FROM employment WHERE person_id = ? ORDER BY start_ym").all(id),
    residence: db.prepare("SELECT * FROM residence WHERE person_id = ? ORDER BY start_ym").all(id),
    education: db.prepare("SELECT * FROM education WHERE person_id = ?").all(id),
    tax: db.prepare("SELECT * FROM tax_record WHERE person_id = ? ORDER BY year").all(id),
    honor: db.prepare("SELECT * FROM honor WHERE person_id = ?").all(id),
  };
}

const cutoffs = () =>
  db.prepare("SELECT year, cutoff, quota FROM policy_year ORDER BY year").all();

app.get("/api/state", async (req) => {
  const personId = Number(req.query.person || 1);
  const p = loadPerson(personId);
  if (!p) return { error: "no person" };
  const years = cutoffs();
  const latest = years[years.length - 1];
  const applyYear = Number(req.query.year) || latest.year + 1;

  const r = compute(p, applyYear);
  const proj = project(years, compute, latest.year + 1, applyYear + 2);
  const target = proj.points.find((x) => x.year === applyYear) || { cutoff: latest.cutoff + 3.65 * (applyYear - latest.year) };

  // 到申报年的自然增长（只算就业 +3/年，其余不动）
  const futureMine = round(r.total + r.annualGain * (applyYear - (latest.year + 1) + 1) * 0);
  const gap = round(target.cutoff - r.total);

  return {
    person: { id: p.id, name: p.name, birth_ym: p.birth_ym, is_primary: p.is_primary },
    applyYear,
    endDate: r.endDate,
    items: r.items,
    total: r.total,
    cutoff: round(target.cutoff),
    gap,
    slope: proj.slope,
    history: years,
    projection: proj.points,
    annualGain: r.annualGain,
    driftPerYear: round(proj.slope - r.annualGain),
  };
});

app.get("/api/persons", async () =>
  db.prepare("SELECT * FROM person ORDER BY id").all()
);

app.get("/api/communities", async (req) => {
  const { district, maxPrice, minPrice, limit = 60, offset = 0, q, basis = "mid", source } = req.query;
  const pcol = basis === "low" ? "price_low" : basis === "high" ? "price_high" : "price";
  const where = ["lng IS NOT NULL"];
  const args = [];
  if (district) { where.push("district = ?"); args.push(district); }
  if (minPrice) { where.push(`${pcol} >= ?`); args.push(Number(minPrice)); }
  if (maxPrice) { where.push(`${pcol} <= ?`); args.push(Number(maxPrice)); }
  if (q) { where.push("name LIKE ?"); args.push(`%${q}%`); }
  if (source) {
    where.push("EXISTS (SELECT 1 FROM community_price cp WHERE cp.community_id = community.id AND cp.source = ?)");
    args.push(source);
  }
  const sql = `SELECT * FROM community WHERE ${where.join(" AND ")} ORDER BY ${pcol} DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, Number(limit), Number(offset));
  attach(db, rows);
  const total = db.prepare(`SELECT COUNT(*) c FROM community WHERE ${where.join(" AND ")}`).get(...args).c;
  return { total, rows };
});

app.get("/api/schools", async (req) => {
  const { district, stage, q, limit = 100 } = req.query;
  const where = ["1=1"];
  const args = [];
  if (stage) { where.push("stage = ?"); args.push(stage); }
  if (q) { where.push("name LIKE ?"); args.push(`%${q}%`); }
  const rows = db.prepare(`SELECT * FROM school WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`).all(...args, Number(limit));
  const total = db.prepare(`SELECT COUNT(*) c FROM school WHERE ${where.join(" AND ")}`).get(...args).c;
  return { total, rows };
});

app.post("/api/person/:id", async (req) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (b.birth_ym) db.prepare("UPDATE person SET birth_ym = ? WHERE id = ?").run(b.birth_ym, id);
  if (b.name) db.prepare("UPDATE person SET name = ? WHERE id = ?").run(b.name, id);
  return { ok: true };
});

app.post("/api/residence", async (req) => {
  const b = req.body || {};
  const r = db.prepare(
    "INSERT INTO residence(person_id,kind,district,start_ym,end_ym) VALUES(?,?,?,?,?)"
  ).run(b.person_id || 1, b.kind, b.district, b.start_ym, b.end_ym || null);
  return { ok: true, id: Number(r.lastInsertRowid) };
});

app.post("/api/employment", async (req) => {
  const b = req.body || {};
  const r = db.prepare(
    "INSERT INTO employment(person_id,start_ym,end_ym,pay_district,is_municipal,backfill_months,employer) VALUES(?,?,?,?,?,?,?)"
  ).run(b.person_id || 1, b.start_ym, b.end_ym || null, b.pay_district, b.is_municipal ? 1 : 0, b.backfill_months || 0, b.employer || null);
  return { ok: true, id: Number(r.lastInsertRowid) };
});

/* ==================== 选房 ==================== */

app.get("/api/workplace", async () =>
  db.prepare("SELECT * FROM workplace ORDER BY id").all()
);

app.post("/api/workplace", async (req) => {
  const b = req.body || {};
  try {
    const g = await geocode(b.address);
    const r = db.prepare(
      "INSERT INTO workplace(person_id,label,address,lng,lat,created_at) VALUES(?,?,?,?,?,?)"
    ).run(Number(b.person_id) || 1, b.label || "公司", g.formatted || b.address, g.lng, g.lat, new Date().toISOString().slice(0, 10));
    return { ok: true, id: Number(r.lastInsertRowid), lng: g.lng, lat: g.lat, formatted: g.formatted };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

app.delete("/api/workplace/:id", async (req) => {
  db.prepare("DELETE FROM workplace WHERE id = ?").run(Number(req.params.id));
  return { ok: true };
});

app.get("/api/bizcenters", async (req) => {
  bizCenters(db, req.query.district);
  return db.prepare("SELECT * FROM bizcenter ORDER BY district, bizcircle").all();
});

app.post("/api/transit/precompute", async (req) => {
  const b = req.body || {};
  try {
    return { ok: true, ...(await precompute(db, Number(b.wpId), { district: b.district })) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

app.get("/api/house/rows", async (req) => houseRows(db, req.query));

app.post("/api/house/exact", async (req) => {
  const b = req.body || {};
  try {
    return { ok: true, ...(await exactTransit(db, Number(b.community_id), Number(b.wpId))) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

app.get("/api/house/schools/:id", async (req) => {
  const c = db.prepare("SELECT lng,lat FROM community WHERE id = ?").get(Number(req.params.id));
  if (!c) return { rows: [] };
  return { rows: nearbySchools(db, c.lng, c.lat, 3) };
});

// 买房对职住区域分的拉动
app.get("/api/house/impact", async (req) => {
  const communityId = Number(req.query.community_id);
  const personId = Number(req.query.person || 1);
  const c = db.prepare("SELECT id,name,district,bizcircle,price FROM community WHERE id = ?").get(communityId);
  if (!c) return { error: "no community" };
  const p = loadPerson(personId);
  if (!p) return { error: "no person" };

  const years = cutoffs();
  const latest = years[years.length - 1];
  const applyYear = Number(req.query.year) || latest.year + 1;
  const now = new Date();
  const buyYm = req.query.buyYm || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const pick = (r, k) => r.items.find((i) => i.key === k);
  const base = compute(p, applyYear);
  const after = compute(
    { ...p, residence: [...p.residence, { kind: "own", district: c.district, start_ym: buyYm, end_ym: null }] },
    applyYear
  );

  const zzBase = pick(base, "zhizhu");
  const zzAfter = pick(after, "zhizhu");
  const liveBase = pick(base, "residence");
  const liveAfter = pick(after, "residence");

  return {
    community: c,
    buyYm,
    applyYear,
    baseTotal: base.total,
    afterTotal: after.total,
    delta: round(after.total - base.total),
    zhizhu: { before: zzBase.score, after: zzAfter.score, cap: 12, rawBefore: zzBase.raw, rawAfter: zzAfter.raw },
    residence: { before: liveBase.score, after: liveAfter.score },
    baseEnd: base.endDate,
  };
});

app.get("/api/meta", async () => {
  const c = db.prepare("SELECT district, COUNT(*) n, SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) withPrice FROM community GROUP BY district").all();
  const s = db.prepare("SELECT stage, COUNT(*) n FROM school GROUP BY stage").all();
  return { communities: c, schools: s, cutoffYears: cutoffs() };
});

app.get("/api/profile", async (req) => {
  const id = Number(req.query.person || 1);
  return loadPerson(id);
});

app.post("/api/profile", async (req) => {
  const b = req.body || {};
  const id = Number(b.person?.id || 1);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE person SET name = ?, birth_ym = ? WHERE id = ?")
      .run(b.person?.name || "我", b.person?.birth_ym || "1988-06", id);
    db.prepare("DELETE FROM employment WHERE person_id = ?").run(id);
    db.prepare("DELETE FROM residence WHERE person_id = ?").run(id);
    db.prepare("DELETE FROM education WHERE person_id = ?").run(id);
    db.prepare("DELETE FROM tax_record WHERE person_id = ?").run(id);
    for (const e of b.employment || []) {
      db.prepare("INSERT INTO employment(person_id,start_ym,end_ym,pay_district,is_municipal,backfill_months,employer) VALUES(?,?,?,?,?,?,?)")
        .run(id, e.start_ym, e.end_ym || null, e.pay_district, e.is_municipal ? 1 : 0, Number(e.backfill_months) || 0, e.employer || null);
    }
    for (const r of b.residence || []) {
      db.prepare("INSERT INTO residence(person_id,kind,district,start_ym,end_ym,registered) VALUES(?,?,?,?,?,?)")
        .run(id, r.kind, r.district, r.start_ym, r.end_ym || null, r.registered ? 1 : 0);
    }
    for (const e of b.education || []) {
      db.prepare("INSERT INTO education(person_id,level,has_degree,obtain_ym,study_months) VALUES(?,?,?,?,?)")
        .run(id, e.level, e.has_degree ? 1 : 0, e.obtain_ym || null, Number(e.study_months) || 0);
    }
    for (const t of b.tax || []) {
      db.prepare("INSERT INTO tax_record(person_id,year,amount) VALUES(?,?,?)")
        .run(id, Number(t.year), Number(t.amount) || 0);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return { ok: false, error: String(e) };
  }
  return { ok: true };
});

/* ==================== 静态资源（生产：同端口托管 dist） ==================== */
const DIST = path.join(__dir, "..", "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

app.setNotFoundHandler((req, reply) => {
  if (req.raw.method !== "GET" && req.raw.method !== "HEAD") return reply.code(404).send({ error: "not found" });
  const urlPath = decodeURIComponent(req.url.split("?")[0] || "/");
  if (urlPath.startsWith("/api/")) return reply.code(404).send({ error: "not found" });

  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.resolve(DIST, "." + rel);
  if (!file.startsWith(DIST)) return reply.code(403).send({ error: "forbidden" });

  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    reply.header("content-type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
    reply.header("cache-control", rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.send(fs.createReadStream(file));
  }

  reply.header("content-type", MIME[".html"]);
  reply.header("cache-control", "no-cache");
  return reply.send(fs.createReadStream(path.join(DIST, "index.html")));
});

const PORT = Number(process.env.PORT || 8787);
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log("api on http://127.0.0.1:" + PORT);
