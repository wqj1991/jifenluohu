import { useState } from "react";
import { fetchPrices, savePrice, dropPriceSource, fetchSummary, useApi, type PriceRow } from "../../lib/maint";
import { PageHead, Facts, Band, Field, Seg, Skeleton, Notice, Empty, dash } from "./Ui";

const PAGE = 120;
const districts = [
  { v: "", l: "全部区" },
  { v: "通州", l: "通州" },
  { v: "大兴", l: "大兴" },
];
const onlyOpts = [
  { v: "", l: "全部" },
  { v: "multi", l: "多源" },
  { v: "single", l: "单源" },
  { v: "missing", l: "缺价" },
  { v: "stale", l: "超 30 天" },
  { v: "manual", l: "手动改过" },
];

const wan = (p: number | null) => (p == null ? "—" : (p / 10000).toFixed(2));
const age = (d: string | null) => {
  if (!d) return null;
  const days = Math.round((Date.now() - new Date(d + "T00:00:00").getTime()) / 86400000);
  return days;
};
const spread = (r: PriceRow) =>
  r.price_low != null && r.price_high != null && r.price_low !== r.price_high
    ? `${wan(r.price_low)}–${wan(r.price_high)}`
    : "—";

export default function PriceMaint({ bare }: { bare?: boolean } = {}) {
  const [district, setDistrict] = useState("");
  const [only, setOnly] = useState("");
  const [src, setSrc] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [edit, setEdit] = useState<PriceRow | null>(null);
  const [form, setForm] = useState({ price: "", ym: "", note: "", source: "manual" });
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const sum = useApi(fetchSummary, []);
  const { data, busy, error, reload } = useApi(
    () => fetchPrices({ district, q, only, source: src, limit: PAGE, offset: page * PAGE }),
    [district, q, only, src, page]
  );

  const s = sum.data?.community;
  const rows = data?.rows || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const srcOpts = [
    { v: "", l: "全部来源" },
    ...(data?.sources || sum.data?.priceSources || []).map((x) => ({ v: x.source, l: `${x.label} ${x.communities}` })),
    { v: "manual", l: "手动" },
  ].filter((o, i, arr) => arr.findIndex((y) => y.v === o.v) === i);

  const pick = (r: PriceRow) => {
    setEdit(r);
    const own = r.sources?.[0];
    setForm({
      price: r.price ? String(r.price) : "",
      ym: new Date().toISOString().slice(0, 7),
      note: "",
      source: own?.source || r.source || "manual",
    });
    setMsg("");
  };

  const submit = async () => {
    if (!edit) return;
    setSaving(true);
    const r = await savePrice({
      community_id: edit.id,
      price: Number(form.price),
      ym: form.ym || undefined,
      note: form.note || undefined,
      source: form.source || "manual",
    });
    setSaving(false);
    if (r.ok) {
      setMsg(`已写入 ${r.source || form.source} · ${r.ym}，现 ${r.price_src_n ?? "?"} 个源`);
      setEdit(null);
      reload();
      sum.reload();
    } else setMsg(r.error || "写入失败");
  };

  const removeSrc = async (source: string) => {
    if (!edit) return;
    const r = await dropPriceSource(edit.id, source);
    if (r.ok) {
      setMsg(`已删除 ${source} 源${r.removed ? `（${r.removed} 行）` : ""}，聚合值已重算`);
      setEdit(null);
      reload();
      sum.reload();
    } else setMsg("删除失败");
  };

  const reset = (fn: () => void) => { fn(); setPage(0); };

  return (
    <>
      {bare ? null : (
        <PageHead
          title="小区房价"
          note={
            <>
              单价来自多个站点的<b>挂牌均价</b>，不是成交价：安居客移动站是主力，链家/贝壳/我爱我家在有登录态时补抓。
              同一小区多源时不取平均，主口径用<b>中位数</b>，另给最低—最高区间；各站口径本来就不同，平均会把差价抹平而不是消掉。
              每一行都带抓取时点，超过 30 天标为待刷新。
            </>
          }
        >
          <button className="m-btn m-btn-quiet" onClick={() => { reload(); sum.reload(); }}>重读台账</button>
        </PageHead>
      )}

      <Facts items={[
        { k: "在册小区", v: s ? s.n.toLocaleString() : dash(null) },
        { k: "有价", v: s ? s.withPrice.toLocaleString() : dash(null) },
        { k: "覆盖率", v: s ? `${s.coverage}%` : dash(null), tone: "seal" },
        { k: "缺价", v: s ? s.missing.toLocaleString() : dash(null), tone: s?.missing ? "seal" : undefined },
        { k: "数据源", v: s ? String(s.sources ?? 0) : dash(null) },
        { k: "多源小区", v: s ? String(s.withMulti ?? 0) : dash(null), tone: s?.withMulti ? "green" : undefined },
        { k: "价格点", v: s ? s.points : dash(null) },
        { k: "最近抓取", v: s?.lastFetched || dash(null), tone: "mute" },
      ]} />

      {edit ? (
        <Band onReset={() => setEdit(null)}>
          <div style={{ width: "15rem" }}>
            <span className="m-label">小区</span>
            <div className="text-[13px] truncate" style={{ color: "var(--color-ink)" }}>
              {edit.name}
              <span className="sans text-[10.5px] ml-2" style={{ color: "var(--color-mute)" }}>
                {edit.district}{edit.bizcircle ? ` · ${edit.bizcircle}` : ""}
              </span>
            </div>
          </div>
          <Field label="来源" w="9.5rem" hint="lianjia / ke / 5i5j / anjuke-mobile / manual">
            <input className="m-input" value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })} />
          </Field>
          <Field label="单价 元/㎡" w="8rem">
            <input className="m-input num" inputMode="numeric" placeholder="35000"
              value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label="价格月份" w="7rem" hint="YYYY-MM">
            <input className="m-input num" placeholder="2026-11"
              value={form.ym} onChange={(e) => setForm({ ...form, ym: e.target.value })} />
          </Field>
          <Field label="备注 · 来源口径" w="16rem">
            <input className="m-input" placeholder="例：中介带看报价，非平台均价"
              value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <button className="m-btn" onClick={submit} disabled={saving || !form.price}>
            {saving ? "写入中" : "写入这个源"}
          </button>
          {msg ? <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{msg}</span> : null}
          {edit.sources?.length ? (
            <span className="flex items-center gap-2 sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>
              已有源：
              {edit.sources.map((x) => (
                <span key={x.source} className="flex items-center gap-1 px-1.5 py-0.5"
                  style={{ border: "1px solid var(--color-rule-2)", color: "var(--color-ink-2)" }}>
                  {x.label || x.source} <span className="num">{wan(x.price)}</span>
                  <button onClick={() => removeSrc(x.source)} style={{ color: "var(--color-seal)" }} title="删除该源">✕</button>
                </span>
              ))}
            </span>
          ) : null}
        </Band>
      ) : null}

      <div className="px-8 md:px-16">
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3"
          style={{ borderTop: "1px solid var(--color-rule-2)", borderBottom: "1px solid var(--color-rule)" }}
        >
          <Seg value={district} options={districts} onChange={(v) => reset(() => setDistrict(v))} />
          <Seg value={only} options={onlyOpts} onChange={(v) => reset(() => setOnly(v))} />
          <Seg value={src} options={srcOpts} onChange={(v) => reset(() => setSrc(v))} />
          <label className="ml-auto flex items-center gap-2 sans text-[11.5px]" style={{ color: "var(--color-mute)" }}>
            小区名
            <input
              className="bg-transparent outline-none text-[11.5px] w-32"
              style={{ color: "var(--color-ink)", borderBottom: "1px solid var(--color-rule-2)", padding: "2px 2px" }}
              value={q}
              onChange={(e) => reset(() => setQ(e.target.value))}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 py-2.5 sans text-[11px]" style={{ color: "var(--color-mute)" }}>
          {(data?.byDistrict || []).map((b) => (
            <span key={b.district}>
              {b.district} <span className="num" style={{ color: "var(--color-ink-2)" }}>{b.withPrice}</span>
              <span className="num"> / {b.n}</span>
            </span>
          ))}
          <span className="ml-auto num">
            命中 {total.toLocaleString()} 个
          </span>
        </div>

        {error ? (
          <Notice>接口未响应：{error}</Notice>
        ) : busy && !rows.length ? (
          <Skeleton />
        ) : !rows.length ? (
          <Empty
            lead="这个筛选下没有小区。"
            why="缺价筛选用的条件是没有挂牌均价；如果刚抓过数据，先在上面选「全部」看看覆盖率。"
          />
        ) : (
          <table className="m-table">
            <thead>
              <tr>
                <th>小区</th>
                <th>商圈</th>
                <th className="text-right">中位 万/㎡</th>
                <th className="text-right">区间 万</th>
                <th>各源 万/㎡</th>
                <th className="text-right">时点</th>
                <th className="text-right">价格点</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = age(r.fetched_at);
                const stale = d != null && d > 30;
                return (
                  <tr key={r.id} className="m-row">
                    <td style={{ color: "var(--color-ink)" }}>{r.name}</td>
                    <td className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{dash(r.bizcircle)}</td>
                    <td className="num text-right" style={{ color: r.price ? "var(--color-ink)" : "var(--color-mute)" }}>
                      {wan(r.price)}
                    </td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>
                      {spread(r)}
                    </td>
                    <td className="sans text-[10px]" style={{ color: "var(--color-mute)" }}>
                      <span className="flex flex-wrap gap-1">
                        {(r.sources || []).map((x) => (
                          <span
                            key={x.source}
                            title={`${x.label || x.source} · ${x.price} 元/㎡${x.ym ? ` · ${x.ym}` : ""}${x.url ? `\n${x.url}` : ""}`}
                            className="px-1 py-[1px] whitespace-nowrap"
                            style={{
                              border: "1px solid var(--color-rule-2)",
                              color: x.source === "manual" ? "var(--color-seal)" : "var(--color-ink-2)",
                            }}
                          >
                            {x.label || x.source} <span className="num">{wan(x.price)}</span>
                          </span>
                        ))}
                        {!r.sources?.length ? "—" : null}
                      </span>
                    </td>
                    <td className="num text-right" style={{ color: stale ? "var(--color-seal)" : "var(--color-mute)" }}>
                      {r.fetched_at || "—"}
                      {stale ? <span className="sans text-[9.5px] ml-1">待刷新</span> : null}
                    </td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>
                      {r.points || "—"}
                      {r.last_ym ? <span className="sans text-[9.5px] ml-1">{r.last_ym}</span> : null}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button className="m-row-act" onClick={() => pick(r)}>改价</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="flex items-center gap-5 py-4 sans text-[11px]" style={{ color: "var(--color-mute)" }}>
          <button className="m-row-act" data-quiet="true" disabled={page === 0} style={{ opacity: page === 0 ? .4 : 1 }}
            onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</button>
          <span className="num">第 {page + 1} / {pages} 页</span>
          <button className="m-row-act" data-quiet="true" disabled={page + 1 >= pages} style={{ opacity: page + 1 >= pages ? .4 : 1 }}
            onClick={() => setPage((p) => p + 1)}>下一页</button>
          <span className="ml-auto max-w-[56ch] leading-[1.8]">
            抓取覆盖通州、大兴两区。安居客免登录可翻 50 页（通州 1320 条实测只取到 510 条）；
            链家/贝壳匿名只给第一页、第二页上 geetest；我爱我家强制登录。抓不全时宁可少一行，不估算。
          </span>
        </div>
      </div>
    </>
  );
}
