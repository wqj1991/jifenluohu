// 导入 GitHub 成交库（muziyongshixin/beijing-housing-dashboard）到本项目库
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { open } from "./db.mjs";

const SRC = "D:/dsh/cache/tmp/house_src/tx.sqlite3";
const LOC = "D:/dsh/cache/tmp/house_src/comm_loc.json";

const db = open();
// 补列
const cols = db.prepare("PRAGMA table_info(community)").all().map((c) => c.name);
for (const [col, type] of [
  ["price_tx", "INTEGER"], ["tx_n", "INTEGER"], ["tx_last", "INTEGER"],
  ["bargain", "REAL"], ["cycle_days", "REAL"], ["price_tx_12m", "INTEGER"], ["tx_n_12m", "INTEGER"],
]) {
  if (!cols.includes(col)) db.exec(`ALTER TABLE community ADD COLUMN ${col} ${type}`);
}

const src = new DatabaseSync(SRC, { readOnly: true });

const agg = src.prepare(`
  SELECT c.id cid, c.name cname, d.name dist, COUNT(*) n,
         CAST(AVG(t.unit_price) AS INTEGER) avg_up,
         MIN(t.sale_date) first_d, MAX(t.sale_date) last_d,
         AVG(CASE WHEN t.listing_price > 0 THEN (t.listing_price - t.sale_price) * 1.0 / t.listing_price END) barg,
         AVG(t.cycle_days) cyc
  FROM transactions t
  JOIN communities c ON c.id = t.community_id
  JOIN business_areas b ON b.id = c.business_area_id
  JOIN districts d ON d.id = b.district_id
  WHERE d.name IN ('通州','大兴')
  GROUP BY c.id
`).all();

const agg12 = src.prepare(`
  SELECT c.id cid, COUNT(*) n, CAST(AVG(t.unit_price) AS INTEGER) avg_up
  FROM transactions t
  JOIN communities c ON c.id = t.community_id
  WHERE t.sale_date >= 20240901
  GROUP BY c.id
`).all();
const m12 = new Map(agg12.map((r) => [r.cid, r]));

// 归一化
const norm = (s) => String(s || "")
  .replace(/[（(][^）)]*[）)]/g, "")
  .replace(/[·・•.\-_—、,，/\\|'"\s]/g, "")
  .replace(/(小区|公寓|别墅|住宅|家园|花园|一期|二期|三期|四期|东区|西区|南区|北区)$/g, "")
  .toLowerCase();

const ours = db.prepare("SELECT id, name, district FROM community").all();
const idx = new Map();
for (const r of ours) {
  const k = r.district + "|" + norm(r.name);
  if (!idx.has(k)) idx.set(k, []);
  idx.get(k).push(r);
}

const upd = db.prepare(`UPDATE community SET price_tx=?, tx_n=?, tx_last=?, bargain=?, cycle_days=?, price_tx_12m=?, tx_n_12m=? WHERE id=?`);
let hit = 0, miss = [];
db.exec("BEGIN");
for (const a of agg) {
  const k = a.dist + "|" + norm(a.cname);
  const cands = idx.get(k);
  if (!cands || !cands.length) { miss.push(a.cname); continue; }
  const r12 = m12.get(a.cid);
  for (const c of cands) {
    upd.run(a.avg_up, a.n, a.last_d, a.barg, a.cyc, r12?.avg_up ?? null, r12?.n ?? null, c.id);
    hit++;
  }
  idx.delete(k);
}
db.exec("COMMIT");

// 坐标补充：community-locations.json
let coordFixed = 0;
if (fs.existsSync(LOC)) {
  const raw = JSON.parse(fs.readFileSync(LOC, "utf8"));
  const loc = raw.locations || raw;
  const byKey = new Map();
  for (const [k, v] of Object.entries(loc)) {
    const [dist, biz, name] = k.split("|");
    if (!name) continue;
    byKey.set(dist + "|" + norm(name), v);
  }
  const setCoord = db.prepare("UPDATE community SET lng=?, lat=? WHERE id=? AND lng IS NULL");
  for (const r of ours) {
    if (!r.district) continue;
    const v = byKey.get(r.district + "|" + norm(r.name));
    if (v && (v.lng || v.longitude)) {
      const res = setCoord.run(v.lng ?? v.longitude, v.lat ?? v.latitude, r.id);
      coordFixed += res.changes;
    }
  }
}

// 成交价优先用于展示
db.exec(`UPDATE community SET price = price_tx WHERE price_tx IS NOT NULL`);

const stat = db.prepare(`SELECT COUNT(*) total,
  SUM(CASE WHEN price_tx IS NOT NULL THEN 1 ELSE 0 END) with_tx,
  SUM(CASE WHEN lng IS NOT NULL THEN 1 ELSE 0 END) with_coord
  FROM community`).get();

console.log(JSON.stringify({
  src_communities: agg.length,
  matched_rows: hit,
  unmatched_src: miss.length,
  coord_filled: coordFixed,
  ...stat,
  sample_unmatched: miss.slice(0, 8),
}, null, 1));
