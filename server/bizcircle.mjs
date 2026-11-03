// 商圈名录：地图上的商圈面是 community.bizcircle 的聚合派生，
// 但「别名合并」「兜底桶（站点没归类）」「停用」这些口径是判断，不是数据，
// 所以把原来写死在 map.mjs 里的 ALIAS / BUCKET 抬成一张可维护的台账。
//
// 约定：
//   name   = community.bizcircle 的原始写法；改名/改区会级联更新小区行
//   alias  = 同一商圈在站点里的其它写法（逗号或空格分隔），只影响聚合，不改库
//   bucket = 1 表示「大兴周边」这类站点兜底桶：不出色、只描边
//   active = 0 表示整块商圈连同它的小区都不上地图
//
// 名录不要求手工录：每次读之前把 community 里出现过的 (district, bizcircle)
// 自动登记进来（INSERT OR IGNORE，不覆盖已有设置），新抓的商圈会自己冒出来。

const BUCKET_DEFAULT = new Set(["大兴周边", "通州周边", "通州其它", "大兴其它", "约2020年建成"]);
/** 站点的另一种写法 → 名录里的正名（默认值，改过之后以库里为准） */
const ALIAS_DEFAULT = { 瀛海镇: "瀛海", 九棵树: "九棵树(家乐福)" };

const nowIso = () => new Date().toISOString();
const splitAlias = (v) =>
  String(v || "")
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

export function ensureBizcircle(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS bizcircle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  district TEXT NOT NULL,
  name TEXT NOT NULL,
  alias TEXT,
  bucket INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  updated_at TEXT,
  UNIQUE(district, name)
);
CREATE INDEX IF NOT EXISTS bizcircle_district ON bizcircle(district);
`);
  seed(db);
}

/** 把 community 里出现过的商圈补登记进名录（已有的行一个字段都不动） */
function seed(db) {
  const rows = db
    .prepare(
      `SELECT district, bizcircle AS name
       FROM community
       WHERE bizcircle IS NOT NULL AND TRIM(bizcircle) <> ''
       GROUP BY district, bizcircle`
    )
    .all();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO bizcircle(district, name, alias, bucket, active, updated_at)
     VALUES(?, ?, ?, ?, 1, ?)`
  );
  const ts = nowIso();
  for (const r of rows) {
    ins.run(r.district, r.name, ALIAS_DEFAULT[r.name] || null, BUCKET_DEFAULT.has(r.name) ? 1 : 0, ts);
  }
}

/** 名录 + 每个商圈的小区数 / 有价数 / 中位与分位（地图着色就是按这个口径） */
export function bizRows(db) {
  seed(db);
  const agg = db
    .prepare(
      `SELECT district, bizcircle,
              COUNT(*) n,
              SUM(CASE WHEN lng IS NOT NULL AND lat IS NOT NULL THEN 1 ELSE 0 END) located,
              SUM(CASE WHEN price IS NOT NULL THEN 1 ELSE 0 END) priced
       FROM community
       WHERE bizcircle IS NOT NULL AND TRIM(bizcircle) <> ''
       GROUP BY district, bizcircle`
    )
    .all();
  const stat = new Map();
  for (const a of agg) stat.set(`${a.district}|${a.bizcircle}`, a);

  const prices = new Map();
  for (const p of db
    .prepare(
      `SELECT district, bizcircle, price FROM community
       WHERE price IS NOT NULL AND bizcircle IS NOT NULL AND TRIM(bizcircle) <> ''`
    )
    .all()) {
    const k = `${p.district}|${p.bizcircle}`;
    let arr = prices.get(k);
    if (!arr) prices.set(k, (arr = []));
    arr.push(p.price);
  }

  return db
    .prepare("SELECT * FROM bizcircle ORDER BY district, name")
    .all()
    .map((r) => {
      const k = `${r.district}|${r.name}`;
      const a = stat.get(k) || { n: 0, located: 0, priced: 0 };
      const arr = (prices.get(k) || []).slice().sort((x, y) => x - y);
      return {
        ...r,
        alias: r.alias || null,
        communities: a.n || 0,
        located: a.located || 0,
        priced: a.priced || 0,
        median: round2(quantile(arr, 0.5)),
        p25: round2(quantile(arr, 0.25)),
        p75: round2(quantile(arr, 0.75)),
      };
    });
}

/** 给 map.mjs 用：别名映射、兜底桶集合、停用集合，key 都是 `${district}|${name}` */
export function bizMeta(db) {
  const aliasMap = new Map();
  const bucketSet = new Set();
  const offSet = new Set();
  let rows = [];
  try {
    rows = db.prepare("SELECT district, name, alias, bucket, active FROM bizcircle").all();
  } catch {
    return { aliasMap, bucketSet, offSet };
  }
  for (const r of rows) {
    const key = `${r.district}|${r.name}`;
    for (const a of splitAlias(r.alias)) if (a !== r.name) aliasMap.set(a, r.name);
    if (r.bucket) bucketSet.add(key);
    if (!r.active) offSet.add(key);
  }
  return { aliasMap, bucketSet, offSet };
}

const numOr = (v) => (v === "" || v == null ? 0 : Number(v) || 0);

export function registerBizcircle(app, db) {
  /* 名录 + 过滤。rows 已经带上小区数/有价数/中位价，前端不用再算 */
  app.get("/api/maint/biz", async (req) => {
    const district = String(req.query.district || "");
    const q = String(req.query.q || "").trim();
    const flag = String(req.query.flag || "");

    const all = bizRows(db);
    let rows = all;
    if (district) rows = rows.filter((r) => r.district === district);
    if (q) rows = rows.filter((r) => `${r.name}${r.alias || ""}${r.note || ""}`.includes(q));
    if (flag === "bucket") rows = rows.filter((r) => r.bucket);
    else if (flag === "off") rows = rows.filter((r) => !r.active);
    else if (flag === "unpriced") rows = rows.filter((r) => r.communities > 0 && !r.priced);
    else if (flag === "noloc") rows = rows.filter((r) => !r.located);
    else if (flag === "empty") rows = rows.filter((r) => !r.communities);

    rows = rows.slice().sort(
      (a, b) => a.district.localeCompare(b.district) || b.communities - a.communities || a.name.localeCompare(b.name)
    );

    const byDistrict = Object.values(
      all.reduce((m, r) => {
        const it = m[r.district] || (m[r.district] = { district: r.district, n: 0, communities: 0, priced: 0 });
        it.n += 1;
        it.communities += r.communities;
        it.priced += r.priced;
        return m;
      }, {})
    ).sort((a, b) => a.district.localeCompare(b.district));

    const sum = (k) => all.reduce((s, r) => s + (r[k] || 0), 0);
    return {
      rows,
      byDistrict,
      stats: {
        n: all.length,
        comms: sum("communities"),
        located: sum("located"),
        priced: sum("priced"),
        buckets: all.filter((r) => r.bucket).length,
        disabled: all.filter((r) => !r.active).length,
        mapped: all.filter((r) => r.located > 0).length,
        districts: byDistrict.length,
      },
    };
  });

  /* 新建 / 编辑。改名或改区会把该商圈下的小区一起搬过去（级联），
     所以地图上的面不会因为改个字就对不上小区。 */
  app.post("/api/maint/biz", async (req, reply) => {
    const b = req.body || {};
    const district = String(b.district || "").trim();
    const name = String(b.name || "").trim();
    if (!district || !name) return reply.code(400).send({ ok: false, error: "区和商圈名都不能空" });
    if (name.length > 24) return reply.code(400).send({ ok: false, error: "商圈名太长了（≤24 字）" });

    const alias = splitAlias(b.alias).join(",") || null;
    const bucket = numOr(b.bucket) ? 1 : 0;
    const active = b.active === 0 || b.active === false ? 0 : 1;
    const note = String(b.note || "").trim() || null;
    const id = Number(b.id) || 0;
    const ts = nowIso();

    if (id) {
      const old = db.prepare("SELECT * FROM bizcircle WHERE id = ?").get(id);
      if (!old) return reply.code(404).send({ ok: false, error: "这条商圈已经不在名录里了，刷新一下" });
      if (old.district !== district || old.name !== name) {
        const dup = db
          .prepare("SELECT id FROM bizcircle WHERE district = ? AND name = ? AND id <> ?")
          .get(district, name, id);
        if (dup) {
          return reply.code(409).send({ ok: false, error: `「${district} · ${name}」已在名录里，要合在一起请用「并入」` });
        }
      }
      db.exec("BEGIN");
      try {
        db.prepare(
          `UPDATE bizcircle SET district=?, name=?, alias=?, bucket=?, active=?, note=?, updated_at=? WHERE id=?`
        ).run(district, name, alias, bucket, active, note, ts, id);
        let moved = 0;
        if (old.district !== district || old.name !== name) {
          const r = db
            .prepare("UPDATE community SET district=?, bizcircle=? WHERE district=? AND bizcircle=?")
            .run(district, name, old.district, old.name);
          moved = r.changes || 0;
          // bizcenter 是按旧 key 缓存的聚合，改名后要作废
          db.prepare("DELETE FROM bizcenter WHERE key IN (?, ?)").run(`${old.district}|${old.name}`, `${district}|${name}`);
        }
        db.exec("COMMIT");
        return { ok: true, id, moved };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }

    const dup = db.prepare("SELECT id FROM bizcircle WHERE district = ? AND name = ?").get(district, name);
    if (dup) {
      db.prepare("UPDATE bizcircle SET alias=?, bucket=?, active=?, note=?, updated_at=? WHERE id=?")
        .run(alias, bucket, active, note, ts, dup.id);
      return { ok: true, id: dup.id, existed: true };
    }
    const info = db
      .prepare(
        `INSERT INTO bizcircle(district, name, alias, bucket, active, note, updated_at) VALUES(?,?,?,?,?,?,?)`
      )
      .run(district, name, alias, bucket, active, note, ts);
    return { ok: true, id: Number(info.lastInsertRowid) };
  });

  /* 并入：把小区的归属改到目标商圈，并删掉源名目行。
     站点把同一个地方写成两种名字（如「瀛海」/「瀛海镇」）时用这个收口。 */
  app.post("/api/maint/biz/merge", async (req, reply) => {
    const b = req.body || {};
    const to = String(b.to || "").trim();
    const from = Array.isArray(b.from) ? b.from.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!to) return reply.code(400).send({ ok: false, error: "要指定并入的目标商圈" });
    if (!from.length) return reply.code(400).send({ ok: false, error: "先选要并掉的商圈" });

    const [td, ...tnRest] = to.split("|");
    const tn = tnRest.join("|");
    const target = db.prepare("SELECT * FROM bizcircle WHERE district = ? AND name = ?").get(td, tn);
    if (!target) return reply.code(404).send({ ok: false, error: "目标商圈不在名录里" });

    let moved = 0;
    let removed = 0;
    db.exec("BEGIN");
    try {
      for (const key of from) {
        if (key === to) continue;
        const [fd, ...fnRest] = key.split("|");
        const fn = fnRest.join("|");
        const r = db.prepare("UPDATE community SET district=?, bizcircle=? WHERE district=? AND bizcircle=?").run(td, tn, fd, fn);
        moved += r.changes || 0;
        removed += db.prepare("DELETE FROM bizcircle WHERE district=? AND name=?").run(fd, fn).changes || 0;
        db.prepare("DELETE FROM bizcenter WHERE key IN (?, ?)").run(key, to);
      }
      db.prepare("UPDATE bizcircle SET updated_at=? WHERE id=?").run(nowIso(), target.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true, moved, removed };
  });

  /* 删：只有名下没有小区时才允许。有小区就先把它们并到别处，
     否则这些小区会从地图与筛选里整体消失，看着像丢数据。 */
  app.delete("/api/maint/biz/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM bizcircle WHERE id = ?").get(id);
    if (!row) return reply.code(404).send({ ok: false, error: "这条商圈已经不在名录里了" });
    const n = db
      .prepare("SELECT COUNT(*) n FROM community WHERE district = ? AND bizcircle = ?")
      .get(row.district, row.name).n;
    if (n) {
      return reply
        .code(409)
        .send({ ok: false, error: `还有 ${n} 个小区挂在这个商圈上，先用「并入」把它们挪到别的商圈` });
    }
    db.prepare("DELETE FROM bizcircle WHERE id = ?").run(id);
    db.prepare("DELETE FROM bizcenter WHERE key = ?").run(`${row.district}|${row.name}`);
    return { ok: true };
  });
}

export const _internal = { splitAlias, seed, quantile };
