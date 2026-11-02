// 小区挂牌价 · 多数据源台账
// 一张表存「某小区在某站点的一口价」，community 表只留聚合值（中位 / 低 / 高 / 源数）。
// 口径：同一小区多于一个源时，列表与排序都用中位数；区间用 min–max；不做跨源平均，
// 因为各站自己的均价口径（挂牌 / 参考价 / 30 天成交）本来就不同，平均会把误差抹平而不是消掉。

export const SOURCE_LABELS = {
  anjuke: "安居客",
  "anjuke-mobile": "安居客",
  lianjia: "链家",
  ke: "贝壳",
  "5i5j": "我爱我家",
  fang: "房天下",
  manual: "手动",
};

/** 允许的已知源；未知源照样入库，只是没有中文名 */
export const KNOWN_SOURCES = ["lianjia", "ke", "5i5j", "anjuke", "anjuke-mobile", "fang", "manual"];

export const sourceLabel = (s) => SOURCE_LABELS[s] || s || "—";

const today = () => new Date().toISOString().slice(0, 10);

/** 中位数：偶数个取中间两值均值后四舍五入到整元 */
export function median(nums) {
  const v = nums.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length % 2) return v[(v.length - 1) / 2];
  return Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
}

/** 写入/更新一个源的价格，随后重算该小区聚合值 */
export function upsertSource(db, b) {
  const id = Number(b.community_id);
  const price = Number(b.price);
  const source = String(b.source || "").trim();
  if (!id || !Number.isFinite(price) || price <= 0) return { ok: false, error: "缺少小区或单价" };
  if (!source) return { ok: false, error: "缺少来源" };
  const fetched = b.fetched_at || today();
  db.prepare(
    `INSERT INTO community_price(community_id, source, price, online, ym, url, source_id, note, fetched_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(community_id, source) DO UPDATE SET
       price=excluded.price,
       online=COALESCE(excluded.online, community_price.online),
       ym=COALESCE(excluded.ym, community_price.ym),
       url=COALESCE(excluded.url, community_price.url),
       source_id=COALESCE(excluded.source_id, community_price.source_id),
       note=COALESCE(excluded.note, community_price.note),
       fetched_at=excluded.fetched_at`
  ).run(
    id, source, Math.round(price),
    b.online == null || b.online === "" ? null : Number(b.online),
    b.ym || null, b.url || null, b.source_id || null, b.note || null, fetched
  );
  const agg = recalc(db, id);
  return { ok: true, community_id: id, source, ...agg };
}

/** 重算某小区的聚合价：中位 / 低 / 高 / 源数 / 最新时点 */
export function recalc(db, communityId) {
  const ps = db
    .prepare("SELECT source, price, fetched_at FROM community_price WHERE community_id = ?")
    .all(Number(communityId))
    .filter((r) => Number(r.price) > 0);
  if (!ps.length) {
    db.prepare(
      "UPDATE community SET price = NULL, price_low = NULL, price_high = NULL, price_src_n = NULL WHERE id = ?"
    ).run(Number(communityId));
    return { price: null, price_low: null, price_high: null, price_src_n: 0 };
  }
  const vals = ps.map((r) => Number(r.price));
  const mid = median(vals);
  const low = Math.min(...vals);
  const high = Math.max(...vals);
  const srcs = [...new Set(ps.map((r) => r.source))];
  const latest = ps.map((r) => r.fetched_at || "").sort().at(-1) || null;
  // 单一来源时 source 就记该源，多源记 multi —— 前端据此决定显示「区间」而不是单值
  const tag = srcs.length === 1 ? srcs[0] : "multi";
  db.prepare(
    "UPDATE community SET price = ?, price_low = ?, price_high = ?, price_src_n = ?, source = ?, fetched_at = ? WHERE id = ?"
  ).run(mid, low, high, srcs.length, tag, latest, Number(communityId));
  return { price: mid, price_low: low, price_high: high, price_src_n: srcs.length, sources: srcs };
}

export function dropSource(db, communityId, source) {
  const r = db
    .prepare("DELETE FROM community_price WHERE community_id = ? AND source = ?")
    .run(Number(communityId), String(source));
  recalc(db, communityId);
  return { ok: true, removed: Number(r.changes || 0) };
}

/* ---------------- 批量挂载 ---------------- */

const CHUNK = 400;

/**
 * 给小区行批量补 sources 数组与聚合字段。
 * 不覆盖已有 price（聚合列由 recalc 维护），只在缺列时兜底。
 */
export function attach(db, rows) {
  if (!rows?.length) return rows;
  const ids = [...new Set(rows.map((r) => Number(r.id)).filter(Boolean))];
  const byId = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rs = db
      .prepare(
        `SELECT community_id, source, price, online, ym, url, source_id, note, fetched_at
           FROM community_price
          WHERE community_id IN (${part.map(() => "?").join(",")})
          ORDER BY price DESC`
      )
      .all(...part);
    for (const r of rs) {
      if (!byId.has(r.community_id)) byId.set(r.community_id, []);
      byId.get(r.community_id).push({ ...r, label: sourceLabel(r.source) });
    }
  }
  for (const r of rows) {
    const list = byId.get(Number(r.id)) || [];
    r.sources = list;
    if (r.price_src_n == null) {
      r.price_src_n = list.length;
      if (list.length) {
        const vals = list.map((x) => Number(x.price)).filter((n) => n > 0);
        if (vals.length) {
          r.price_low = Math.min(...vals);
          r.price_high = Math.max(...vals);
        }
      }
    }
  }
  return rows;
}

/** 各源覆盖统计：多少小区有价、最近一次抓取 */
export function sourceStats(db) {
  const rows = db
    .prepare(
      `SELECT source, COUNT(*) communities, COUNT(DISTINCT community_id) comms,
              MIN(price) low, MAX(price) high, MAX(fetched_at) last
         FROM community_price GROUP BY source ORDER BY communities DESC`
    )
    .all();
  return rows.map((r) => ({ ...r, label: sourceLabel(r.source) }));
}
