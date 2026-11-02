import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.join(__dirname, "..", "data", "luohu.db");

const DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS policy_year (
  year INTEGER PRIMARY KEY,
  cutoff REAL NOT NULL,
  quota INTEGER,
  apply_start TEXT, apply_end TEXT, deadline TEXT
);

CREATE TABLE IF NOT EXISTS person (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  birth_ym TEXT NOT NULL,          -- YYYY-MM
  is_primary INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES person(id),
  start_ym TEXT NOT NULL,
  end_ym TEXT,
  pay_district TEXT NOT NULL,      -- 缴费区；'市本级' 视为城六区
  is_municipal INTEGER NOT NULL DEFAULT 0,
  backfill_months INTEGER NOT NULL DEFAULT 0,
  employer TEXT
);

CREATE TABLE IF NOT EXISTS residence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES person(id),
  kind TEXT NOT NULL,              -- own | rent | dorm
  district TEXT NOT NULL,          -- 通州 | 大兴 | 朝阳 ...
  start_ym TEXT NOT NULL,
  end_ym TEXT,
  registered INTEGER NOT NULL DEFAULT 0  -- 租赁已办备案 / 自有有产权证，未登记不计分
);

CREATE TABLE IF NOT EXISTS education (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES person(id),
  level TEXT NOT NULL,             -- 专科 | 本科 | 硕士 | 博士
  has_degree INTEGER NOT NULL DEFAULT 1,
  obtain_ym TEXT,
  study_months INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tax_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES person(id),
  year INTEGER NOT NULL,
  amount REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS honor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES person(id),
  level TEXT NOT NULL,
  year INTEGER
);

CREATE TABLE IF NOT EXISTS community (
  id INTEGER PRIMARY KEY,          -- 安居客 community id，无则用 hash
  name TEXT NOT NULL,
  district TEXT NOT NULL,
  bizcircle TEXT,
  price INTEGER,                   -- 元/㎡ 挂牌均价
  build_year INTEGER,
  lng REAL, lat REAL,
  online INTEGER,                  -- 在售套数
  source TEXT,
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comm_district ON community(district);
CREATE INDEX IF NOT EXISTS idx_comm_name ON community(name);

-- 多源挂牌价：每 (小区, 来源) 一行；community 表只留聚合值
CREATE TABLE IF NOT EXISTS community_price (
  community_id INTEGER NOT NULL,
  source TEXT NOT NULL,            -- lianjia | ke | 5i5j | anjuke | anjuke-mobile | fang | manual
  price INTEGER NOT NULL,          -- 元/㎡，该源自己的口径（挂牌均价 / 参考均价…）
  online INTEGER,                  -- 该源的在售套数
  ym TEXT,                         -- 该源数据对应的月份 YYYY-MM，未知留空
  url TEXT,
  source_id TEXT,                  -- 站点自身的小区 id，便于下次同源刷新
  note TEXT,
  fetched_at TEXT,
  PRIMARY KEY (community_id, source)
);
CREATE INDEX IF NOT EXISTS idx_cprice_source ON community_price(source);

CREATE TABLE IF NOT EXISTS school (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT UNIQUE,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,             -- 小学 | 中学
  addr TEXT,
  lng REAL, lat REAL,
  region_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_school_stage ON school(stage);

CREATE TABLE IF NOT EXISTS transit_cache (
  key TEXT PRIMARY KEY,            -- "{flng},{flat}->{tlng},{flat}"
  minutes_min INTEGER,
  minutes_max INTEGER,
  distance_m INTEGER,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS setting (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function open() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(DDL);
  // 轻量迁移：老库补列
  const cols = db.prepare("PRAGMA table_info(residence)").all().map((c) => c.name);
  if (!cols.includes("registered")) {
    db.exec("ALTER TABLE residence ADD COLUMN registered INTEGER NOT NULL DEFAULT 0");
  }
  // 多源价格聚合列
  const ccols = db.prepare("PRAGMA table_info(community)").all().map((c) => c.name);
  for (const [col, type] of [["price_low", "INTEGER"], ["price_high", "INTEGER"], ["price_src_n", "INTEGER"]]) {
    if (!ccols.includes(col)) db.exec(`ALTER TABLE community ADD COLUMN ${col} ${type}`);
  }
  // 首次迁移：把老的单值价回填成一条 anjuke-mobile 源记录（幂等）
  const seeded = db.prepare("SELECT COUNT(*) c FROM community_price").get().c;
  if (!seeded) {
    const old = db
      .prepare("SELECT id, price, source, fetched_at FROM community WHERE price IS NOT NULL")
      .all();
    if (old.length) {
      const ins = db.prepare(
        "INSERT OR REPLACE INTO community_price(community_id, source, price, fetched_at) VALUES(?,?,?,?)"
      );
      db.exec("BEGIN");
      try {
        for (const r of old) ins.run(r.id, r.source || "anjuke-mobile", r.price, r.fetched_at);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      db.exec(
        `UPDATE community SET price_low = price, price_high = price, price_src_n = 1
          WHERE price IS NOT NULL`
      );
    }
  }
  return db;
}

export function getSetting(db, key, fallback = null) {
  const r = db.prepare("SELECT value FROM setting WHERE key = ?").get(key);
  return r ? r.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO setting(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}
