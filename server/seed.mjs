import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open, setSetting } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

const CUTOFFS = [
  [2018, 90.75], [2019, 93.58], [2020, 97.13], [2021, 100.88], [2022, 105.42],
  [2023, 109.92], [2024, 114.46], [2025, 117.33], [2026, 119.92],
];

const db = open();
const now = new Date().toISOString().slice(0, 10);

// 补列
const cols = db.prepare("PRAGMA table_info(community)").all().map((c) => c.name);
for (const [col, type] of [
  ["address", "TEXT"], ["build_type", "TEXT"], ["property_type", "TEXT"], ["tags", "TEXT"],
]) {
  if (!cols.includes(col)) db.exec(`ALTER TABLE community ADD COLUMN ${col} ${type}`);
}

// ---------- 分数线 ----------
const insYear = db.prepare(
  "INSERT INTO policy_year(year, cutoff, quota) VALUES(?,?,?) ON CONFLICT(year) DO UPDATE SET cutoff=excluded.cutoff"
);
for (const [y, c] of CUTOFFS) insYear.run(y, c, 6000);

// ---------- 小区（安居客移动站，含 NUXT 坐标） ----------
const rows = [
  ...read("ajk_full_tongzhou.json"),
  ...read("ajk_full_daxing.json"),
];

db.exec("DELETE FROM community");
// 源台账跟 community 一起重灌：否则旧源行会指向已删掉的小区 id。
db.exec("DELETE FROM community_price");
const insCP = db.prepare(
  `INSERT OR REPLACE INTO community_price(community_id,source,price,online,ym,url,source_id,note,fetched_at)
   VALUES(?,?,?,?,?,?,?,?,?)`
);
const insC = db.prepare(
  `INSERT INTO community(id,name,district,bizcircle,price,build_year,lng,lat,online,source,fetched_at,address,build_type,property_type,tags)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
let withCoord = 0;
for (const r of rows) {
  if (r.lng) withCoord++;
  insC.run(r.id, r.name, r.district, r.bizcircle, r.price, r.build_year, r.lng, r.lat,
    r.online, "anjuke-mobile", now, r.address, r.build_type, r.property_type, r.tags);
  if (r.price) insCP.run(r.id, "anjuke-mobile", r.price, r.online ?? null, now.slice(0, 7), null, null, null, now);
}
db.exec(`UPDATE community SET price_low=price, price_high=price, price_src_n=1 WHERE price IS NOT NULL`);

// ---------- 学校 ----------
const schools = read("schools_bj.json");
db.exec("DELETE FROM school");
const insS = db.prepare(
  "INSERT OR IGNORE INTO school(place_id,name,stage,addr,lng,lat,region_id) VALUES(?,?,?,?,?,?,?)"
);
let sc = 0;
for (const s of schools) {
  let lng = null, lat = null;
  if (s.coord && typeof s.coord === "object") {
    lng = Number(s.coord.lng) || null;
    lat = Number(s.coord.lat) || null;
  } else {
    const m = String(s.coord || "").match(/([\d.]+)\s*,\s*([\d.]+)/);
    if (m) { lng = Number(m[1]); lat = Number(m[2]); }
  }
  insS.run(s.place_id, s.name, s.stage, s.addr, lng, lat, s.region_id);
  sc++;
}

// ---------- 默认家庭成员占位 ----------
const cnt = db.prepare("SELECT COUNT(*) c FROM person").get().c;
if (!cnt) {
  db.prepare("INSERT INTO person(id,name,birth_ym,is_primary) VALUES(1,'我','1988-06',1)").run();
  db.prepare("INSERT INTO person(id,name,birth_ym,is_primary) VALUES(2,'配偶','1990-03',0)").run();
  db.prepare(
    "INSERT INTO employment(person_id,start_ym,pay_district,is_municipal,backfill_months) VALUES(1,'2012-07','朝阳',0,0)"
  ).run();
  db.prepare("INSERT INTO residence(person_id,kind,district,start_ym) VALUES(1,'rent','朝阳','2012-07')").run();
  db.prepare("INSERT INTO education(person_id,level,has_degree,obtain_ym,study_months) VALUES(1,'本科',1,'2012-06',0)").run();
}

setSetting(db, "seeded_at", now);
db.close();

console.log(JSON.stringify({
  years: CUTOFFS.length,
  communities: rows.length,
  with_coord: withCoord,
  schools: sc,
}, null, 1));
