// 地图模式：商圈聚合 + Voronoi 商圈面 + 小区点 + 高德栅格瓦片代理
//
// 两个必须知道的前提（实测，见 docs/map-mode.md）：
//   1. community 表里的 lng/lat 是百度 BD-09，高德底图是 GCJ-02，出图前必须 bd2gcj()，
//      不转会整体偏约 630 米。
//   2. 公司网用 Zscaler，浏览器直接加载 webapi.amap.com 的 JS / 瓦片会被 307 到 SAML 认证页，
//      所以瓦片只能由后端抓、前端只请求本机的 /api/tiles/*。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Delaunay } from "d3-delaunay";
import { cacheKey, transitOnce } from "./house.mjs";
import { bizMeta } from "./bizcircle.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const TILE_DIR = path.join(__dir, "..", "data", "tiles");
const GEO_FILE = path.join(__dir, "..", "data", "geo", "districts.json");

/* ---------------- 坐标 ---------------- */
const PI = Math.PI;
const X_PI = (PI * 3000) / 180;

/** 百度 BD-09 → 高德/腾讯 GCJ-02 */
export function bd2gcj(lng, lat) {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const th = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return [z * Math.cos(th), z * Math.sin(th)];
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;

/* ---------------- 统计小工具 ---------------- */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(quantile(s, 0.5));
};

/** 兜底桶与别名的出厂默认值；以「商圈维护」里的名录（bizcircle 表）为准，
 *  这里只是名录还没建起来时的兜底口径。 */
const BUCKET = new Set(["大兴周边", "通州周边", "通州其它", "大兴其它", "约2020年建成"]);
const ALIAS = { 瀛海: "瀛海镇", "九棵树(家乐福)": "九棵树" };

/** 只有落在这个框里的点才上地图：库里有十几个环京盘与个别明显错标（37°N / 121°E），
 *  放进来会把 Voronoi 的张量撑到几十公里，整张图就糊了。框外的点由区界遮罩挡住。 */
const inBox = (lng, lat) => lng > 115.9 && lng < 117.3 && lat > 39.2 && lat < 40.4;

/* ---------------- 构建（进程内缓存） ---------------- */
let cache = { at: 0, key: "", data: null };
const TTL = 5 * 60 * 1000;

function fingerprint(db) {
  const r = db
    .prepare("SELECT COUNT(*) n, MAX(id) mx, MAX(fetched_at) ft FROM community WHERE lng IS NOT NULL")
    .get();
  // 商圈名录的改动（改名、并入、兜底、停用）也要让 5 分钟缓存立刻失效
  let b = { n: 0, u: "" };
  try {
    b = db.prepare("SELECT COUNT(*) n, MAX(updated_at) u FROM bizcircle").get() || b;
  } catch { /* 老库还没建名录表 */ }
  return `${r.n}|${r.mx}|${r.ft}|${b.n}|${b.u}`;
}

export function buildMap(db, { fresh = false } = {}) {
  const key = fingerprint(db);
  if (!fresh && cache.data && cache.key === key && Date.now() - cache.at < TTL) {
    return cache.data;
  }

  const rows = db
    .prepare(
      `SELECT id, name, district, bizcircle, lng, lat, price, build_year
       FROM community WHERE lng IS NOT NULL`
    )
    .all();

  // 名录（bizcircle 表）里的别名/兜底/停用优先，常量只兜底
  let meta = { aliasMap: new Map(), bucketSet: new Set(), offSet: new Set() };
  try {
    meta = bizMeta(db);
  } catch { /* 名录表还没建 */ }
  const aliasOf = (b) => meta.aliasMap.get(b) || ALIAS[b] || b;

  // 小区点：先转坐标，再按商圈归组
  const comms = [];
  const groups = new Map();
  for (const r of rows) {
    const [lng, lat] = bd2gcj(r.lng, r.lat);
    if (!inBox(lng, lat)) continue;
    const b = aliasOf(r.bizcircle);
    if (meta.offSet.has(`${r.district}|${b}`)) continue; // 维护里停用的商圈整块不上面
    const c = {
      id: r.id,
      name: r.name,
      d: r.district,
      b,
      lng: r6(lng),
      lat: r6(lat),
      p: r.price ?? null,
      y: r.build_year ?? null,
    };
    comms.push(c);
    const k = `${r.district}|${b}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { district: r.district, bizcircle: b, pts: [], prices: [] }));
    g.pts.push([lng, lat]);
    if (r.price) g.prices.push(r.price);
  }

  // 商圈中心（有坐标小区的质心），用于 Voronoi
  const centers = [];
  for (const [key2, g] of groups) {
    const n = g.pts.length;
    const lng = g.pts.reduce((s, p) => s + p[0], 0) / n;
    const lat = g.pts.reduce((s, p) => s + p[1], 0) / n;
    g.key = key2;
    g.lng = lng;
    g.lat = lat;
    g.n = n;
    g.median = median(g.prices);
    const sorted = [...g.prices].sort((a, b) => a - b);
    g.p25 = Math.round(quantile(sorted, 0.25) ?? 0) || null;
    g.p75 = Math.round(quantile(sorted, 0.75) ?? 0) || null;
    g.priced = g.prices.length;
    // 兜底桶：名录里勾了「兜底」的优先，否则按出厂名单判
    g.bucket = meta.bucketSet.has(`${g.district}|${g.bizcircle}`) || BUCKET.has(g.bizcircle);
    centers.push(g);
  }

  // Voronoi：在等距投影的公里坐标里划，再转回经纬度，vision 上不会因经度收缩变形
  const LAT0 = 39.9;
  const KX = 111 * Math.cos((LAT0 * PI) / 180);
  const KY = 111;
  const proj = ([lng, lat]) => [(lng - 116.6) * KX, (lat - LAT0) * KY];
  const unproj = ([x, y]) => [r6(116.6 + x / KX), r6(LAT0 + y / KY)];

  const pts = centers.map((c) => proj([c.lng, c.lat]));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const PAD = 6; // 公里，够盖住两区外扩
  const bounds = [
    Math.min(...xs) - PAD,
    Math.min(...ys) - PAD,
    Math.max(...xs) + PAD,
    Math.max(...ys) + PAD,
  ];

  const delaunay = Delaunay.from(pts);
  const voronoi = delaunay.voronoi(bounds);

  const biz = centers.map((c, i) => {
    const cell = voronoi.cellPolygon(i);
    const poly = cell ? cell.map(unproj) : [];
    return {
      key: c.key,
      district: c.district,
      bizcircle: c.bizcircle,
      n: c.n,
      priced: c.priced,
      median: c.median,
      p25: c.p25,
      p75: c.p75,
      lng: r6(c.lng),
      lat: r6(c.lat),
      bucket: c.bucket,
      poly,
    };
  });

  // 分档：按有样本商圈的单价四分位切 5 档，前端直接用 tier 上色
  const priced = biz.filter((b) => !b.bucket && b.median).map((b) => b.median).sort((a, b) => a - b);
  const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => Math.round(quantile(priced, q) ?? 0));
  for (const b of biz) {
    if (!b.median || b.bucket) { b.tier = 0; continue; }
    b.tier = 1 + cuts.filter((c) => b.median >= c).length;
  }

  // 区界（GCJ-02，已简化，见 scripts/gen_districts_geo.mjs）
  let districts = {};
  try {
    districts = JSON.parse(fs.readFileSync(GEO_FILE, "utf8")).districts || {};
  } catch { /* 没生成过区界就只画面 */ }

  const lngs = comms.map((c) => c.lng);
  const lats = comms.map((c) => c.lat);
  // 视野取区界的外框（比小区点稳定，不会被个别错标点拽偏）
  const ringPts = Object.values(districts).flat();
  const bbox = ringPts.length
    ? [
        Math.min(...ringPts.map((p) => p[0])),
        Math.min(...ringPts.map((p) => p[1])),
        Math.max(...ringPts.map((p) => p[0])),
        Math.max(...ringPts.map((p) => p[1])),
      ]
    : [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  const data = {
    generatedAt: new Date().toISOString(),
    bbox,
    cuts,
    districts,
    biz,
    comms,
  };

  cache = { at: Date.now(), key, data };
  return data;
}

/* ---------------- 瓦片代理 ---------------- */
const TILE_MIN_Z = 10;
const TILE_MAX_Z = 17;
// 1×1 透明 PNG：上游挂掉时给浏览器一个合法图片，避免 leaflet 无限重试刷日志
const BLANK = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const tilePath = (z, x, y) => path.join(TILE_DIR, String(z), String(x), `${y}.png`);

async function fetchTile(z, x, y) {
  const sub = (x + y) % 4 + 1;
  const url =
    `https://webrd0${sub}.is.autonavi.com/appmaptile` +
    `?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": "Mozilla/5.0", referer: "https://www.amap.com/" },
  });
  if (!r.ok) throw new Error(`tile http ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error("tile too small");
  return buf;
}

/* ---------------- 小区→工作地通勤（悬浮用，按天缓存） ---------------- */
// 与列表里的通勤口径一致：公交+步行早高峰，取最快三个方案做区间；
// 但这里用 bd2gcj 后的坐标（列表那条链路直接用 BD-09 原始坐标，会偏 500 米左右）。
async function communityTransit(db, c, w) {
  const [lng, lat] = bd2gcj(c.lng, c.lat);
  const from = { lng, lat };
  const k = cacheKey(from, w);
  const today = new Date().toISOString().slice(0, 10);
  const prev = db.prepare("SELECT * FROM transit_cache WHERE key = ?").get(k);
  if (prev && prev.fetched_at === today) {
    return { min: prev.minutes_min, max: prev.minutes_max, distance_m: prev.distance_m, cached: true };
  }
  // 高德偶尔返回空（并发限流时 status=0 或 transits 为空），停一下再试一次再放弃
  let t = await transitOnce(from, w);
  if (!t) {
    await new Promise((r) => setTimeout(r, 700));
    t = await transitOnce(from, w);
  }
  if (!t) return null;
  db.prepare(
    `INSERT INTO transit_cache(key,minutes_min,minutes_max,distance_m,fetched_at)
     VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
     minutes_min=excluded.minutes_min, minutes_max=excluded.minutes_max,
     distance_m=excluded.distance_m, fetched_at=excluded.fetched_at`
  ).run(k, t.min, t.max, t.distance_m, today);
  return { ...t, cached: false };
}

// 同一个小区连着被悬浮多次时只打一次高德
const inflight = new Map();

/* ---------------- 路由 ---------------- */
export function registerMap(app, db) {
  app.get("/api/map/data", async (req) => {
    const { district, fresh } = req.query;
    let data = buildMap(db, { fresh: fresh === "1" });
    if (district) {
      data = {
        ...data,
        biz: data.biz.filter((b) => b.district === district),
        comms: data.comms.filter((c) => c.d === district),
      };
    }
    return data;
  });

  /* 小区悬浮卡片：价格 + 到各工作地的通勤（首次算，之后走 transit_cache） */
  app.get("/api/map/commute/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "bad id" });
    const c = db
      .prepare(
        `SELECT id,name,district,bizcircle,lng,lat,price,price_tx,build_year,online
         FROM community WHERE id = ?`
      )
      .get(id);
    if (!c) return reply.code(404).send({ error: "小区不存在" });
    const base = {
      id: c.id, name: c.name, district: c.district, bizcircle: c.bizcircle,
      price: c.price ?? null, price_tx: c.price_tx ?? null,
      build_year: c.build_year ?? null, online: c.online ?? null,
      commutes: [],
    };
    if (c.lng == null || c.lat == null) return { ...base, note: "没有坐标，算不了通勤" };

    // 两个人各有一个「公司」，标签重了就在后面挂人名，否则悬浮卡里两行长得一模一样
    const wps = db
      .prepare(
        `SELECT w.id, w.label, w.address, w.lng, w.lat, p.name AS who
         FROM workplace w LEFT JOIN person p ON p.id = w.person_id
         WHERE w.lng IS NOT NULL AND w.lng <> 0`
      )
      .all();
    const labelCount = new Map();
    for (const w of wps) labelCount.set(w.label, (labelCount.get(w.label) || 0) + 1);
    const wpLabel = (w) =>
      `${w.label || w.address || `工作地${w.id}`}${labelCount.get(w.label) > 1 && w.who ? `·${w.who}` : ""}`;

    let task = inflight.get(id);
    if (!task) {
      // 两个工作地并发算：串行时首次悬浮要等 7 秒，并发后 3 秒左右
      task = Promise.all(
        wps.map(async (w) => {
          try {
            const t = await communityTransit(db, c, w);
            return {
              wp: w.id,
              label: wpLabel(w),
              min: t?.min ?? null,
              max: t?.max ?? null,
              distance_m: t?.distance_m ?? null,
              line_text: t?.line_text ?? null,
              transfers: t?.transfers ?? null,
              walk_m: t?.walk_m ?? null,
              cached: !!t?.cached,
            };
          } catch (e) {
            return { wp: w.id, label: wpLabel(w), min: null, max: null, error: e.message };
          }
        })
      ).finally(() => inflight.delete(id));
      inflight.set(id, task);
    }
    return { ...base, commutes: await task };
  });

  app.get("/api/tiles/:z/:x/:y", async (req, reply) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (
      !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
      z < TILE_MIN_Z || z > TILE_MAX_Z || x < 0 || y < 0 ||
      x >= 2 ** z || y >= 2 ** z
    ) {
      return reply.code(400).type("image/png").send(BLANK);
    }

    const file = tilePath(z, x, y);
    let buf = null;
    try {
      buf = fs.readFileSync(file);
    } catch { /* 未缓存 */ }

    if (!buf) {
      try {
        buf = await fetchTile(z, x, y);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
      } catch {
        buf = null;
      }
    }

    return reply
      .type("image/png")
      .header("cache-control", buf ? "public, max-age=86400" : "no-store")
      .send(buf || BLANK);
  });
}
