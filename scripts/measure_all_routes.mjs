// 服务器侧：把「所有有坐标的小区 × 全部工作地点」的早高峰公交路线与时间写进权威库
// 口径与 server/house.mjs transitOnce 一致；额外记录高德 infocode，配额/限流能一眼看出
// 用法：node scripts/measure_all_routes.mjs [--wp 4,6] [--force] [--workers 2] [--gap 350]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const FORCE = argv.includes("--force");
const WORKERS = Math.max(1, Number(arg("workers", 2)));
const GAP = Math.max(120, Number(arg("gap", 350)));
const ONLY_WP = arg("wp", "").split(",").map(Number).filter(Boolean);
const LIMIT = Number(arg("limit", 0)) || 0; // 冒烟测试用

const envFile = "/opt/luohu/.env";
const KEY =
  process.env.AMAP_KEY ||
  (fs.existsSync(envFile)
    ? (fs.readFileSync(envFile, "utf8").match(/^AMAP_KEY=(.*)$/m)?.[1] || "").trim()
    : "");
if (!KEY) {
  console.error("AMAP_KEY 缺失");
  process.exit(2);
}

const DB = "/opt/luohu/data/luohu.db";
const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout=15000");

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
    source TEXT NOT NULL DEFAULT 'manual',
    fetched_at TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    updated_at TEXT,
    UNIQUE(community_id, wp_id)
  );
  CREATE INDEX IF NOT EXISTS idx_route_wp ON community_route(wp_id);
  CREATE INDEX IF NOT EXISTS idx_route_comm ON community_route(community_id);
`);

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stopName = (s) => (s && (s.name || s.location)) || "";

function segText(s) {
  const rw = s.railway;
  if (rw && rw.name) return `${rw.name} ${stopName(rw.departure_stop)} → ${stopName(rw.arrival_stop)}`;
  const bl = s.bus?.buslines?.[0];
  if (bl && bl.name) {
    const via = Number(bl.via_num) || 0;
    return `${bl.name} ${stopName(bl.departure_stop)} → ${stopName(bl.arrival_stop)}${via ? `（${via} 站）` : ""}`;
  }
  const w = Number(s.walking?.distance) || 0;
  return w >= 60 ? `步行 ${Math.round(w)} 米` : "";
}

class Fatal extends Error {}

async function transit(from, to) {
  const q = new URLSearchParams({
    origin: `${from.lng},${from.lat}`,
    destination: `${to.lng},${to.lat}`,
    city: "北京",
    cityd: "北京",
    strategy: "0",
    nightflag: "0",
    key: KEY,
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    let j;
    try {
      const r = await fetch(`https://restapi.amap.com/v3/direction/transit/integrated?${q}`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`http ${r.status}`);
      j = await r.json();
    } catch (e) {
      if (attempt === 4) return { err: `网络：${e.message}` };
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (j.status === "1") return { data: j };
    const code = String(j.infocode || "");
    // 10021 QPS 超限 / 10019 并发超限 / 10004 单位时间超限 → 退避重试
    if (["10021", "10019", "10004", "10020"].includes(code)) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    // 10044 日配额耗尽 / 10003 日访问量超限：今天没戏了，直接停
    if (["10044", "10003", "10001", "10002", "10005"].includes(code)) {
      throw new Fatal(`高德配额中止 ${code} ${j.info || ""}`);
    }
    return { err: `${code} ${j.info || ""}` };
  }
  return { err: "重试耗尽" };
}

function parse(j) {
  const ts = j.route?.transits || [];
  const arr = ts
    .map((t) => ({ t, m: Math.round(Number(t.duration) / 60), d: Number(t.distance) || 0 }))
    .filter((x) => x.m > 0)
    .sort((a, b) => a.m - b.m);
  if (!arr.length) return null;
  const top = arr.slice(0, 3);
  const segs = arr[0].t.segments || [];
  const legs = segs.filter((s) => s.bus?.buslines?.length || s.railway).length;
  const walk = segs.reduce((a, s) => a + (Number(s.walking?.distance) || 0), 0);
  return {
    min: top[0].m,
    max: top[top.length - 1].m,
    distance_m: top[0].d,
    transfers: Math.max(0, legs - 1),
    walk_m: Math.round(walk),
    line_text: segs.map(segText).filter(Boolean).join(" → ") || null,
  };
}

const getRoute = db.prepare("SELECT * FROM community_route WHERE community_id = ? AND wp_id = ?");
const putRoute = db.prepare(
  `INSERT INTO community_route(
      community_id, wp_id, mode, minutes_min, minutes_max, distance_m, walk_m,
      transfers, line_text, depart_at, source, fetched_at, verified, note, updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(community_id, wp_id) DO UPDATE SET
      mode = excluded.mode, minutes_min = excluded.minutes_min, minutes_max = excluded.minutes_max,
      distance_m = excluded.distance_m, walk_m = excluded.walk_m, transfers = excluded.transfers,
      line_text = excluded.line_text, depart_at = excluded.depart_at, source = excluded.source,
      fetched_at = excluded.fetched_at, verified = excluded.verified, note = excluded.note,
      updated_at = excluded.updated_at`,
);

const wps = db
  .prepare("SELECT * FROM workplace ORDER BY id")
  .all()
  .filter((w) => w.lng != null && w.lat != null && (!ONLY_WP.length || ONLY_WP.includes(w.id)));
const comms = db
  .prepare("SELECT id, name, district, bizcircle, lng, lat FROM community WHERE lng IS NOT NULL AND lat IS NOT NULL ORDER BY id")
  .all();

const T = today();
// 已核实的「手填」记录不动：那是亲自跑出来的数字
const locked = new Set(
  db
    .prepare("SELECT community_id, wp_id FROM community_route WHERE source = 'manual' AND verified = 1")
    .all()
    .map((r) => `${r.community_id}:${r.wp_id}`),
);
const fresh = new Set(
  FORCE
    ? []
    : db
        .prepare("SELECT community_id, wp_id FROM community_route WHERE fetched_at = ? AND source = 'amap'")
        .all(T)
        .map((r) => `${r.community_id}:${r.wp_id}`),
);

const tasks = [];
for (const c of comms) for (const w of wps) {
  const k = `${c.id}:${w.id}`;
  if (locked.has(k) || fresh.has(k)) continue;
  tasks.push({ c, w });
}
if (LIMIT) tasks.length = Math.min(tasks.length, LIMIT);

console.log(
  `start ${now()} | 小区 ${comms.length} × 工作地点 ${wps.map((w) => w.id).join("/")} = ${tasks.length} 条待测` +
    ` | workers=${WORKERS} gap=${GAP}ms force=${FORCE}`,
);

let done = 0, ok = 0, fail = 0;
const fails = [];
const t0 = Date.now();
let cursor = 0;

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= tasks.length) return;
    const { c, w } = tasks[i];
    const prev = getRoute.get(c.id, w.id);
    let res;
    try {
      const r = await transit(c, w);
      res = r.err ? { err: r.err } : { t: parse(r.data) };
      if (res.t === null) res = { err: "无公交方案" };
    } catch (e) {
      if (e instanceof Fatal) throw e;
      res = { err: String(e.message || e) };
    }
    if (res.t) {
      putRoute.run(
        c.id, w.id, "公交", res.t.min, res.t.max, res.t.distance_m, res.t.walk_m,
        res.t.transfers, res.t.line_text, prev?.depart_at || "08:10", "amap", T,
        prev?.verified ? 1 : 0, prev?.note ?? null, now(),
      );
      ok++;
    } else {
      fail++;
      if (fails.length < 40) fails.push(`${c.name}/${w.id}：${res.err}`);
    }
    done++;
    if (done % 50 === 0) {
      const el = Math.round((Date.now() - t0) / 1000);
      const rate = done / Math.max(el, 1);
      const eta = rate > 0 ? Math.round((tasks.length - done) / rate) : -1;
      console.log(
        `[${now()}] ${done}/${tasks.length} ok=${ok} fail=${fail} | ${rate.toFixed(2)}/s ETA ${Math.round(eta / 60)}min`,
      );
    }
    await sleep(GAP);
  }
}

let fatal = null;
try {
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));
} catch (e) {
  fatal = e;
}

const secs = Math.round((Date.now() - t0) / 1000);
console.log(
  `done ${now()} | 处理 ${done}/${tasks.length} ok=${ok} fail=${fail} 用时 ${Math.round(secs / 60)}min` +
    (fatal ? ` | 中止：${fatal.message}` : ""),
);
if (fails.length) console.log("失败样本：\n" + fails.join("\n"));
const stat = db
  .prepare("SELECT wp_id, COUNT(*) n, ROUND(AVG(minutes_min)) avg_min, MAX(fetched_at) last FROM community_route GROUP BY wp_id")
  .all();
console.log("库内现状：" + JSON.stringify(stat));
db.close();
