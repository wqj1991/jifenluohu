// 把抓取产物（data/fc_<site>_<district>.json、data/ajk_full_*.json）导入多源价格台账
// 用法：
//   node scripts/import_prices.mjs --file data/fc_lianjia_tongzhou.json
//   node scripts/import_prices.mjs --site lianjia --district tongzhou
//   node scripts/import_prices.mjs --all --dry
// 匹配顺序：同源 source_id → 区 + 归一化名 → 区 + 商圈 + 归一化名包含。
// 只补价格，不新建小区（新小区缺坐标，进了 community 表也排不进选房结果）。
import fs from "node:fs";
import path from "node:path";
import { open } from "../server/db.mjs";
import { upsertSource, sourceLabel } from "../server/prices.mjs";

const argv = process.argv.slice(2);
const flag = (name, dft = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dft;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const has = (name) => argv.includes(`--${name}`);

const DISTRICT_NAME = { tongzhou: "通州", daxing: "大兴" };
const SITE_ALIAS = { "anjuke-mobile": "anjuke-mobile", anjuke: "anjuke", lianjia: "lianjia", ke: "ke", "5i5j": "5i5j", fang: "fang" };

const norm = (s) =>
  String(s || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[·・•.\-_—、,，/\\|'"\s]/g, "")
    .replace(/(小区|公寓|别墅|住宅|家园|花园|一期|二期|三期|四期|东区|西区|南区|北区)$/g, "")
    .toLowerCase();

const db = open();

const byId = new Map(); // `${source}|${sourceId}` -> community_id
for (const r of db.prepare("SELECT community_id, source, source_id FROM community_price WHERE source_id IS NOT NULL").all()) {
  byId.set(`${r.source}|${r.source_id}`, r.community_id);
}

const ours = db.prepare("SELECT id, name, district, bizcircle FROM community").all();
const exact = new Map(); // district|normName -> [rows]
const loose = new Map(); // district|bizcircle -> [rows]
for (const r of ours) {
  const k = `${r.district}|${norm(r.name)}`;
  if (!exact.has(k)) exact.set(k, []);
  exact.get(k).push(r);
  const k2 = `${r.district}|${r.bizcircle || ""}`;
  if (!loose.has(k2)) loose.set(k2, []);
  loose.get(k2).push(r);
}

function match(row, districtName) {
  const source = SITE_ALIAS[row.source] || row.source || "unknown";
  const hit = byId.get(`${source}|${row.id}`);
  if (hit) return { id: hit, how: "source_id" };
  const n = norm(row.name);
  const ex = exact.get(`${districtName}|${n}`);
  if (ex?.length === 1) return { id: ex[0].id, how: "name" };
  if (ex?.length > 1) {
    // 同名多小区：用商圈收敛
    const same = ex.filter((x) => !row.bizcircle || x.bizcircle === row.bizcircle);
    if (same.length === 1) return { id: same[0].id, how: "name+biz" };
  }
  const pool = loose.get(`${districtName}|${row.bizcircle || ""}`) || [];
  const part = pool.filter((x) => {
    const xn = norm(x.name);
    return xn && (xn.includes(n) || n.includes(xn)) && Math.abs(xn.length - n.length) <= 4;
  });
  if (part.length === 1) return { id: part[0].id, how: "fuzzy" };
  return null;
}

function loadFile(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = Array.isArray(j) ? j : j.rows || [];
  const site = Array.isArray(j) ? null : j.site || null;
  const districtKey = Array.isArray(j) ? null : j.district || null;
  return { rows, site, districtKey, at: Array.isArray(j) ? null : j.at || null };
}

function targetFiles() {
  const one = flag("file");
  if (one) return String(one).split(",").map((s) => s.trim()).filter(Boolean);
  const site = flag("site");
  const district = flag("district");
  const dir = path.join(process.cwd(), "data");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => (f.startsWith("fc_") || f.startsWith("ajk_full_")) && !f.includes("probe"))
    .filter((f) => (site ? f.includes(`_${site}_`) || f === `ajk_full_${district || ""}.json` : true))
    .filter((f) => (district ? f.includes(`_${district}`) : true))
    .map((f) => path.join(dir, f));
}

const dry = has("dry");
const files = targetFiles();
if (!files.length) {
  console.error("没有可导入的文件：先跑 pnpm fc:fetch，或用 --file 指定");
  process.exit(2);
}

const stat = { files: 0, rows: 0, matched: 0, inserted: 0, updated: 0, miss: 0, noPrice: 0 };
const missSamples = [];

for (const file of files) {
  let pack;
  try {
    pack = loadFile(file);
  } catch (e) {
    console.error(`跳过 ${file}: ${e.message}`);
    continue;
  }
  stat.files++;
  const base = path.basename(file);
  // 文件名兜底：fc_<site>_<district>.json / ajk_full_<district>.json / communities_ajk_<district>.json
  const parts = base.replace(/\.json$/i, "").split("_");
  const nameDistrict = parts.at(-1);
  const nameSite = base.startsWith("fc_") ? parts[1] : base.startsWith("ajk_full_") ? "anjuke-mobile" : null;
  const districtName = DISTRICT_NAME[pack.districtKey || nameDistrict] || null;
  const fileSite = pack.site || nameSite || "anjuke-mobile";
  if (!districtName) {
    console.error(`跳过 ${base}: 无法判断区`);
    continue;
  }
  let used = 0;
  for (const raw of pack.rows) {
    stat.rows++;
    const price = Number(raw.price);
    if (!Number.isFinite(price) || price <= 0) { stat.noPrice++; continue; }
    const row = { ...raw, source: raw.source || fileSite };
    const hit = match(row, districtName);
    if (!hit) {
      stat.miss++;
      if (missSamples.length < 12) missSamples.push(`${row.name} (${districtName}${row.bizcircle ? "·" + row.bizcircle : ""}) ${price}`);
      continue;
    }
    stat.matched++;
    used++;
    const source = SITE_ALIAS[row.source] || row.source || fileSite;
    const existed = db
      .prepare("SELECT price FROM community_price WHERE community_id = ? AND source = ?")
      .get(hit.id, source);
    if (!dry) {
      const r = upsertSource(db, {
        community_id: hit.id,
        source,
        price,
        online: raw.online ?? null,
        ym: pack.at ? String(pack.at).slice(0, 7) : null,
        url: raw.url || null,
        source_id: raw.id ? String(raw.id) : null,
        note: `import ${base}`,
        fetched_at: pack.at ? String(pack.at).slice(0, 10) : new Date().toISOString().slice(0, 10),
      });
      if (!r.ok) { console.error(`写入失败 ${row.name}: ${r.error}`); continue; }
      byId.set(`${source}|${raw.id}`, hit.id);
    }
    if (existed) stat.updated++; else stat.inserted++;
  }
  console.log(`${base} → ${used} 条匹配（源 ${sourceLabel(fileSite)}）`);
}

console.log(
  `\n${dry ? "[dry] " : ""}文件 ${stat.files} · 读入 ${stat.rows} · 匹配 ${stat.matched}` +
    ` · 新源 ${stat.inserted} · 覆盖 ${stat.updated} · 无价 ${stat.noPrice} · 未匹配 ${stat.miss}`
);
if (missSamples.length) {
  console.log("\n未匹配样例（这些小区不在 community 表里，或名字差异太大）：");
  for (const s of missSamples) console.log("  - " + s);
}
const agg = db
  .prepare("SELECT COUNT(*) n, SUM(price_src_n > 1) multi FROM community WHERE price IS NOT NULL")
  .get();
console.log(`\n当前有价小区 ${agg.n}，其中多源 ${agg.multi || 0}。`);
