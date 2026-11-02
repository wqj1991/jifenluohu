import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchHouseRows, fetchWorkplaces, precomputeTransit,
  fetchImpact, fetchNearbySchools, exactTransit,
  type HouseRow, type Workplace, type Impact, type NearSchool,
} from "../lib/api";

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const wan = (n: number | null) => (n == null ? "—" : (n / 10000).toFixed(2));

/* 通勤分档：≤60 绿 / 60–90 墨 / >90 朱红 */
function tone(m: number | null) {
  if (m == null) return "var(--color-mute)";
  if (m <= 60) return "var(--color-green)";
  if (m <= 90) return "var(--color-ink-2)";
  return "var(--color-seal)";
}

function TransitCell({ t, onExact, busy }: { t?: any; onExact?: () => void; busy?: boolean }) {
  if (!t) return <td className="py-2.5 dotted text-right" />;
  return (
    <td className="py-2.5 dotted text-right num whitespace-nowrap" style={{ color: tone(t.min) }}>
      {t.missing ? (
        <span className="sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>未测</span>
      ) : (
        <span>
          {t.min}
          <span className="sans text-[10px] ml-0.5" style={{ color: "var(--color-mute)" }}>–{t.max}′</span>
        </span>
      )}
      {onExact ? (
        <button
          onClick={onExact}
          disabled={busy}
          title="精确到该小区"
          className="sans text-[9.5px] ml-1 align-[1px]"
          style={{ color: "var(--color-seal-soft)" }}
        >{busy ? "…" : "精"}</button>
      ) : null}
    </td>
  );
}

const isMid = (st: string) => st === "中学" || st === "zx";

function FilterBar({ f, set, biz, total, shown }: {
  f: Record<string, string>; set: (k: string, v: string) => void;
  biz: { district: string; bizcircle: string }[]; total: number; shown: number;
}) {
  const sel = (k: string, opts: { v: string; l: string }[]) => (
    <select
      value={f[k] || ""}
      onChange={(e) => set(k, e.target.value)}
      className="sans text-[11.5px] bg-transparent pr-1"
      style={{ color: "var(--color-ink)" }}
    >
      {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );

  const priceOpts = [
    { v: "", l: "不限单价" },
    { v: "20000", l: "2 万以下" },
    { v: "30000", l: "3 万以下" },
    { v: "40000", l: "4 万以下" },
    { v: "50000", l: "5 万以下" },
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-2.5 sans text-[11.5px]"
      style={{ borderTop: "1px solid var(--color-rule-2)", borderBottom: "1px solid var(--color-rule)" }}
    >
      {sel("district", [{ v: "", l: "全部区" }, { v: "通州", l: "通州" }, { v: "大兴", l: "大兴" }])}
      {sel("bizcircle", [{ v: "", l: "全部商圈" },
        ...biz.filter((b) => !f.district || b.district === f.district)
          .map((b) => ({ v: b.bizcircle, l: b.bizcircle }))])}
      {sel("maxPrice", priceOpts)}
      {sel("basis", [
        { v: "", l: "按中位" },
        { v: "low", l: "按最低源" },
        { v: "high", l: "按最高源" },
      ])}
      {sel("minYear", [{ v: "", l: "不限房龄" }, { v: "2005", l: "2005 后" }, { v: "2010", l: "2010 后" }, { v: "2015", l: "2015 后" }, { v: "2020", l: "2020 后" }])}
      {sel("commute", [
        { v: "", l: "不限通勤" },
        { v: "60", l: "通勤 ≤60 分" },
        { v: "75", l: "通勤 ≤75 分" },
        { v: "90", l: "通勤 ≤90 分" },
        { v: "120", l: "通勤 ≤120 分" },
      ])}
      {sel("resi", [{ v: "", l: "仅住宅" }, { v: "1", l: "含商住自建" }])}
      {sel("sort", [
        { v: "commute", l: "通勤最短" },
        { v: "deal", l: "有成交优先" },
        { v: "price-asc", l: "单价从低" },
        { v: "price-desc", l: "单价从高" },
        { v: "bargain", l: "议价最大" },
        { v: "year-desc", l: "房龄最新" },
      ])}
      <input
        value={f.kw || ""}
        onChange={(e) => set("kw", e.target.value)}
        placeholder="小区名"
        className="bg-transparent w-24 border-b outline-none text-[11.5px]"
        style={{ borderColor: "var(--color-rule-2)", color: "var(--color-ink)" }}
      />
      <span className="ml-auto num" style={{ color: "var(--color-mute)" }}>
        命中 <b style={{ color: "var(--color-ink)" }}>{shown}</b> 个
        {shown !== total ? <span> · 共 {total}</span> : null}
      </span>
    </div>
  );
}

function Detail({ row, year, onClose }: { row: HouseRow; year: number; onClose: () => void }) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [schools, setSchools] = useState<NearSchool[]>([]);
  const [busy, setBusy] = useState(false);
  const [t, setT] = useState<any[]>(row.transit || []);

  useEffect(() => {
    setImpact(null); setSchools([]); setT(row.transit || []);
    fetchImpact(row.id, year).then(setImpact).catch(() => {});
    fetchNearbySchools(row.id).then((r) => setSchools(r.rows)).catch(() => {});
  }, [row.id, year]);

  const doExact = async (wpId: number) => {
    setBusy(true);
    const r = await exactTransit(row.id, wpId);
    if (r.ok) {
      setT((prev) => prev.map((x) => (x.wp === wpId ? { ...x, min: r.min, max: r.max, missing: false, stale: false } : x)));
    }
    setBusy(false);
  };

  return (
    <aside
      className="sticky top-0 self-start h-screen overflow-y-auto px-7 py-6"
      style={{ background: "var(--color-paper-2)", borderLeft: "1px solid var(--color-rule)" }}
    >
      <div className="flex items-start justify-between">
        <div className="sans text-[10.5px] tracking-[.28em]" style={{ color: "var(--color-mute)" }}>
          {row.district} · {row.bizcircle}
        </div>
        <button onClick={onClose} className="sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>关闭</button>
      </div>

      <h2 className="text-[26px] leading-tight mt-2 font-semibold tracking-[.02em]">{row.name}</h2>
      <div className="sans text-[11px] mt-1" style={{ color: "var(--color-mute)" }}>{row.address || "地址未收录"}</div>

      <div className="flex items-baseline gap-2 mt-4">
        <span className="num leading-none" style={{ fontSize: 46, letterSpacing: "-.02em" }}>
          {row.price ? (row.price / 10000).toFixed(2) : "—"}
        </span>
        <span className="sans text-[12px]" style={{ color: "var(--color-seal)" }}>万/㎡</span>
        {row.build_year ? (
          <span className="sans text-[11px] ml-auto" style={{ color: "var(--color-mute)" }}>{row.build_year} 年建</span>
        ) : null}
      </div>

      {row.price_low != null && row.price_high != null ? (
        <div className="sans text-[10.5px] mt-1.5 leading-[1.7]" style={{ color: "var(--color-mute)" }}>
          {(row.price_src_n ?? 1) > 1 ? (
            <>
              {row.price_src_n} 个来源 · 区间{" "}
              <span className="num" style={{ color: "var(--color-ink-2)" }}>{wan(row.price_low)}</span>
              <span className="num">–{wan(row.price_high)}</span>
              {" "}万/㎡，主值取中位
            </>
          ) : (
            <>单一来源挂牌均价，非成交价</>
          )}
        </div>
      ) : null}

      {(row.sources?.length ?? 0) > 0 ? (
        <div className="mt-4">
          <div className="sans text-[10px] tracking-[.24em] mb-1" style={{ color: "var(--color-mute)" }}>
            各源报价 · 万/㎡
          </div>
          <table className="w-full text-[11.5px]">
            <tbody>
              {row.sources!.map((s) => (
                <tr key={s.source}>
                  <td className="py-1 dotted" style={{ color: "var(--color-ink-2)" }}>
                    {s.label || s.source}
                    {s.ym ? <span className="sans text-[9.5px] ml-1" style={{ color: "var(--color-mute)" }}>{s.ym}</span> : null}
                  </td>
                  <td className="py-1 dotted text-right num" style={{ color: "var(--color-ink)" }}>{wan(s.price)}</td>
                  <td className="py-1 dotted text-right w-14 sans text-[9.5px]" style={{ color: "var(--color-mute)" }}>
                    {s.online === 1 ? "在售" : s.online === 0 ? "下架" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sans text-[9.5px] mt-1 leading-[1.7]" style={{ color: "var(--color-seal-soft)" }}>
            各站口径不同（挂牌均价 / 参考均价），所以不合并成一个数。
          </div>
        </div>
      ) : null}

      <table className="w-full mt-5 text-[12px]">
        <tbody>
          {[
            ["真实成交均价", row.price_tx ? `${wan(row.price_tx)} 万/㎡` : "无成交样本"],
            ["成交样本", row.tx_n ? `${row.tx_n} 套` : "—"],
            ["议价空间", row.bargain != null ? `${(row.bargain * 100).toFixed(1)}%` : "—"],
            ["平均去化", row.cycle_days != null ? `${Math.round(row.cycle_days)} 天` : "—"],
            ["建筑类型", row.build_type || "—"],
            ["物业类型", row.property_type || "—"],
          ].map(([k, v]) => (
            <tr key={k as string}>
              <td className="py-1.5 dotted" style={{ color: "var(--color-mute)" }}>{k}</td>
              <td className="py-1.5 dotted text-right num" style={{ color: "var(--color-ink)" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <div className="sans text-[10.5px] tracking-[.24em] mb-2" style={{ color: "var(--color-mute)" }}>
          买这里 · 职住区域拉动
        </div>
        {impact ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="num text-[13px]" style={{ color: "var(--color-mute)" }}>{fmt(impact.zhizhu.before)}</span>
              <span style={{ color: "var(--color-mute)" }}>→</span>
              <span className="num text-[30px] leading-none" style={{ color: "var(--color-seal)" }}>{fmt(impact.zhizhu.after)}</span>
              <span className="sans text-[11px]" style={{ color: "var(--color-seal)" }}>分</span>
              {impact.zhizhu.after >= impact.zhizhu.cap ? (
                <span className="sans text-[10px] border px-1 ml-1" style={{ borderColor: "var(--color-green)", color: "var(--color-green)" }}>已触顶</span>
              ) : null}
            </div>
            <div className="sans text-[11px] mt-2 leading-[1.9]" style={{ color: "var(--color-mute)" }}>
              按 {impact.buyYm} 入手、计分截至 {impact.baseEnd} 测算<br />
              总分 <span className="num" style={{ color: "var(--color-ink)" }}>{fmt(impact.baseTotal)}</span>
              <span style={{ color: "var(--color-mute)" }}> → </span>
              <span className="num" style={{ color: "var(--color-green)" }}>{fmt(impact.afterTotal)}</span>
              <span style={{ color: "var(--color-green)" }}> +{fmt(impact.delta)}</span>
            </div>
            <div className="sans text-[10.5px] mt-1.5 leading-[1.8]" style={{ color: "var(--color-seal-soft)" }}>
              {impact.zhizhu.after <= impact.zhizhu.before ? (
                <>从 {impact.buyYm} 入手到计分截止不满 1 年，这一档<b>每满 1 年</b>才起算。满年后每年 +2（城六区外自有住所），上限 12。</>
              ) : (
                <>上限 12 分。租房段不计入自有住所，所以只有买房才吃这一档。</>
              )}
            </div>
          </>
        ) : <div className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>测算中…</div>}
      </div>

      <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <div className="sans text-[10.5px] tracking-[.24em] mb-2" style={{ color: "var(--color-mute)" }}>
          通勤 · 到各公司
        </div>
        <table className="w-full text-[12px]">
          <tbody>
            {t.map((x) => (
              <tr key={x.wp}>
                <td className="py-1.5 dotted" style={{ color: "var(--color-ink-2)" }}>{x.label}</td>
                <td className="py-1.5 dotted text-right num" style={{ color: tone(x.min) }}>
                  {x.missing ? "未测" : `${x.min}–${x.max} 分`}
                </td>
                <td className="py-1.5 dotted text-right w-8">
                  <button
                    onClick={() => doExact(x.wp)}
                    disabled={busy}
                    className="sans text-[9.5px]"
                    style={{ color: "var(--color-seal-soft)" }}
                  >{busy ? "…" : "精确"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sans text-[10px] mt-1 leading-[1.7]" style={{ color: "var(--color-mute)" }}>
          商圈质心口径，公交+步行早高峰。点「精确」按小区坐标重算。
        </div>
      </div>

      <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <div className="sans text-[10.5px] tracking-[.24em] mb-2" style={{ color: "var(--color-mute)" }}>
          最近的学校 · 直线距离
        </div>
        <div className="text-[11.5px] leading-[2]">
          {schools.map((s) => (
            <div key={s.id} className="flex justify-between gap-2">
              <span style={{ color: "var(--color-ink-2)" }}>
                <span className="sans text-[9.5px] mr-1" style={{ color: isMid(s.stage) ? "var(--color-seal)" : "var(--color-mute)" }}>
                  {isMid(s.stage) ? "中" : "小"}
                </span>
                {s.name}
              </span>
              <span className="num shrink-0" style={{ color: "var(--color-mute)" }}>{s.km} km</span>
            </div>
          ))}
          {!schools.length && <span style={{ color: "var(--color-mute)" }}>加载中…</span>}
        </div>
        <div className="sans text-[10px] mt-2 leading-[1.7]" style={{ color: "var(--color-seal-soft)" }}>
          ⚠ 距离近不等于对口。通州 2023-05-01 后取得的房产一律多校划片；经开区约 60 km² 归经开区社会事业局。买前须按官方划片文件核实。
        </div>
      </div>
    </aside>
  );
}

export default function HouseHunt({ year, go }: { year: number; go: (v: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({ district: "", bizcircle: "", maxPrice: "", minYear: "", sort: "commute", kw: "", commute: "", resi: "" });
  const [rows, setRows] = useState<HouseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [wps, setWps] = useState<Workplace[]>([]);
  const [biz, setBiz] = useState<{ district: string; bizcircle: string }[]>([]);
  const [sel, setSel] = useState<HouseRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [pre, setPre] = useState("");

  const wpIds = wps.map((w) => w.id).join(",");

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    const q: Record<string, string> = { limit: "60", offset: String(offset), wps: wpIds };
    for (const [k, v] of Object.entries(f)) {
      if (!v) continue;
      if (k === "resi") q.includeNonResi = v;
      else if (k !== "commute") q[k] = v;
    }
    const d = await fetchHouseRows(q);
    setTotal(d.total);
    setRows((prev) => (offset ? [...prev, ...d.rows] : d.rows));
    setLoading(false);
  }, [f, wpIds]);

  useEffect(() => { load(0); }, [load]);
  useEffect(() => { fetchWorkplaces().then(setWps).catch(() => {}); }, []);

  // 支持 ?pick=<小区id> 直接打开详情（截图与分享用）
  useEffect(() => {
    const p = new URLSearchParams(location.search).get("pick");
    if (!p || !rows.length) return;
    const r = rows.find((x) => x.id === Number(p));
    if (r) setSel(r);
  }, [rows]);

  // 商圈候选直接从当前数据里取（避免额外接口）
  useEffect(() => {
    const m = new Map<string, { district: string; bizcircle: string }>();
    for (const r of rows) if (r.bizcircle) m.set(`${r.district}|${r.bizcircle}`, { district: r.district, bizcircle: r.bizcircle });
    if (m.size) setBiz([...m.values()].sort((a, b) => a.district.localeCompare(b.district) || a.bizcircle.localeCompare(b.bizcircle)));
  }, [rows]);

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v, ...(k === "district" ? { bizcircle: "" } : {}) }));

  const view = useMemo(() => {
    const cap = Number(f.commute || 0);
    if (!cap) return rows;
    return rows.filter((r) => (r.transit || []).some((t) => t.min != null && t.min <= cap));
  }, [rows, f.commute]);

  const runPre = async (wpId: number) => {
    setPre("测算中，约 25 秒…");
    const r = await precomputeTransit(wpId);
    setPre(r.ok ? `完成 ${r.miss} 个商圈（缓存 ${r.hit}）` : r.error || "失败");
    load(0);
  };

  return (
    <div>
      <div className="px-5 pt-6">
        <h1 className="text-[26px] tracking-[.05em] font-semibold leading-tight">选房</h1>
        <div className="sans text-[11.5px] leading-[1.9] mt-2 max-w-[70ch]" style={{ color: "var(--color-ink-2)" }}>
          公司地址只决定通勤，不决定分数。单价取自多个站点的<b>小区挂牌均价</b>（安居客移动站为主，链家/贝壳/我爱我家有登录态时补抓），
          多源小区按<b>中位数</b>取主值、另给最低—最高区间，不取平均；通勤是高德公交加步行的早高峰口径。
          没有来源的值一律留空，不做估算。
        </div>
        <div className="rule-red-thin mt-4" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px]">
      <section className="pb-10">
        {/* 公司地址：只读，增删改在「公司地点线路维护」 */}
        <div className="px-5 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 sans text-[11.5px]"
          style={{ borderBottom: "1px solid var(--color-rule-2)" }}>
          <span style={{ color: "var(--color-mute)" }}>办公地</span>
          {wps.length ? wps.map((w) => (
            <span key={w.id} className="flex items-center gap-1.5 px-2 py-0.5"
              style={{ border: "1px solid var(--color-rule-2)", color: "var(--color-ink-2)" }}>
              <b style={{ color: "var(--color-ink)" }}>{w.label}</b>
              <span className="max-w-[13rem] truncate" style={{ color: "var(--color-mute)" }}>{w.address}</span>
              <button onClick={() => runPre(w.id)} style={{ color: "var(--color-seal)" }}>测通勤</button>
            </span>
          )) : (
            <span style={{ color: "var(--color-mute)" }}>还没设公司地址，通勤列全部为空</span>
          )}
          <button onClick={() => go("workplace")} className="ml-auto" style={{ color: "var(--color-seal)" }}>
            地点与线路维护 →
          </button>
          {pre && <span style={{ color: "var(--color-mute)" }}>{pre}</span>}
        </div>

        <FilterBar f={f} set={set} biz={biz} total={total} shown={view.length} />

        <div className="px-5">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="sans text-[10.5px] tracking-[.16em]" style={{ color: "var(--color-mute)" }}>
                <th className="text-left py-2 font-normal">小区</th>
                <th className="text-left py-2 font-normal">商圈</th>
                <th className="text-right py-2 font-normal">建成年</th>
                <th className="text-right py-2 font-normal">单价 万/㎡</th>
                <th className="text-right py-2 font-normal">议价</th>
                {wps.map((w) => <th key={w.id} className="text-right py-2 font-normal">{w.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {view.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSel(r)}
                  className="cursor-pointer"
                  style={{ background: sel?.id === r.id ? "var(--color-paper-2)" : undefined }}
                >
                  <td className="py-2.5 dotted" style={{ color: "var(--color-ink)" }}>
                    {r.name}
                    {r.price_tx ? <span className="sans text-[9.5px] ml-1.5" style={{ color: "var(--color-green)" }}>成交</span> : null}
                  </td>
                  <td className="py-2.5 dotted sans text-[11px]" style={{ color: "var(--color-mute)" }}>{r.bizcircle}</td>
                  <td className="py-2.5 dotted text-right num" style={{ color: "var(--color-mute)" }}>{r.build_year || "—"}</td>
                  <td
                    className="py-2.5 dotted text-right num whitespace-nowrap"
                    title={
                      r.price_low != null && r.price_high != null
                        ? `多源区间 ${wan(r.price_low)}–${wan(r.price_high)} 万/㎡（${r.price_src_n ?? 1} 个来源，主值取中位）`
                        : "单一来源"
                    }
                  >
                    {r.price ? (r.price / 10000).toFixed(2) : "—"}
                    {(r.price_src_n ?? 1) > 1 ? (
                      <span className="sans text-[9px] ml-1 align-[2px]" style={{ color: "var(--color-green)" }}>
                        {r.price_src_n}源
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2.5 dotted text-right num" style={{ color: "var(--color-mute)" }}>
                    {r.bargain != null ? `${(r.bargain * 100).toFixed(0)}%` : "—"}
                  </td>
                  {wps.map((w) => <TransitCell key={w.id} t={r.transit?.find((t) => t.wp === w.id)} />)}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="sans text-[11.5px] py-6" style={{ color: "var(--color-mute)" }}>读取中…</div>}
          {!loading && rows.length < total && (
            <button onClick={() => load(rows.length)} className="sans text-[11.5px] py-4" style={{ color: "var(--color-seal)" }}>
              继续加载（{rows.length} / {total}）
            </button>
          )}
        </div>
      </section>

      {sel ? (
        <Detail row={sel} year={year} onClose={() => setSel(null)} />
      ) : (
        <aside className="sticky top-0 self-start h-screen px-7 py-6"
          style={{ background: "var(--color-paper-2)", borderLeft: "1px solid var(--color-rule)" }}>
          <div className="sans text-[10.5px] tracking-[.28em]" style={{ color: "var(--color-mute)" }}>小区测算</div>
          <p className="text-[13px] leading-[2] mt-4" style={{ color: "var(--color-ink-2)" }}>
            左边点一个小区，这里会算出：<br />
            · 买它对<b>职住区域</b>分的拉动（上限 12）<br />
            · 到各公司的真实通勤分钟<br />
            · 周边最近的学校
          </p>
          <p className="sans text-[10.5px] leading-[1.9] mt-4" style={{ color: "var(--color-seal-soft)" }}>
            城六区外<b>租房不计</b>职住区域加分，细则要求自有住所。所以「先租后买攒分」不成立。
          </p>
        </aside>
      )}
      </div>
    </div>
  );
}
