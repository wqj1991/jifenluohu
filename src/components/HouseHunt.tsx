import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fetchHouseRows, fetchWorkplaces, fetchBizcircles,
  type HouseRow, type Workplace, type BizCircle,
} from "../lib/api";
import AiPick from "./AiPick";
import HouseDetail from "./HouseDetail";

// 地图带着 leaflet（约 150 KB min）与瓦片请求，只有切到地图模式才需要，懒加载掉
const MapView = lazy(() => import("./MapView"));

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

/** 商圈选择器：71 个选项的原生 select 太难翻，改成可输入过滤的下拉。 */
function BizPicker({ value, biz, district, onPick }: {
  value: string;
  biz: { district: string; bizcircle: string; n?: number }[];
  district: string;
  onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState("");
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => {
    const pool = biz.filter((b) => !district || b.district === district);
    const k = kw.trim().toLowerCase();
    if (k) return pool.filter((b) => b.bizcircle.toLowerCase().includes(k));
    return [{ district: "", bizcircle: "", n: undefined as number | undefined }, ...pool];
  }, [biz, district, kw]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setKw("");
    setHi(0);
    input.current?.focus();
  }, [open]);

  const pick = (v: string) => {
    onPick(v);
    setOpen(false);
  };

  const key = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[hi]) pick(rows[hi].bizcircle); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="bizpick" ref={box}>
      <button type="button" className="bizpick-btn sans" onClick={() => setOpen((o) => !o)}>
        {value || "全部商圈"}
        <span className="bizpick-caret">▾</span>
      </button>
      {open && (
        <div className="bizpick-pop">
          <input
            ref={input}
            value={kw}
            onChange={(e) => { setKw(e.target.value); setHi(0); }}
            onKeyDown={key}
            placeholder="搜商圈名…"
            className="bizpick-in sans"
          />
          <div className="bizpick-list">
            {rows.map((b, i) => (
              <button
                type="button"
                key={b.district + "|" + b.bizcircle}
                className={"bizpick-row" + (i === hi ? " on" : "") + (b.bizcircle && b.bizcircle === value ? " cur" : "")}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(b.bizcircle)}
              >
                <span>{b.bizcircle || "全部商圈"}</span>
                {!district && b.district && <em className="bizpick-d">{b.district}</em>}
                {b.n != null && <em className="bizpick-n">{b.n}</em>}
              </button>
            ))}
            {!rows.length && <div className="bizpick-empty sans">没有匹配的商圈</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterBar({ f, set, biz, total, shown }: {
  f: Record<string, string>; set: (k: string, v: string) => void;
  biz: { district: string; bizcircle: string; n?: number }[]; total: number; shown: number;
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
      <BizPicker value={f.bizcircle || ""} biz={biz} district={f.district || ""} onPick={(v) => set("bizcircle", v)} />
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

/* ?mode=map 直接进地图；?bizonly=1 再顺手摘掉小区点（「商圈维护」页的「地图只看商圈」就是这么跳过来的） */
const initialMode = (): "list" | "map" | "ai" => {
  if (typeof location === "undefined") return "list";
  const sp = new URLSearchParams(location.search);
  const m = sp.get("mode");
  if (m === "ai") return "ai";
  return m === "map" || sp.get("bizonly") === "1" ? "map" : "list";
};
const initialBizOnly = () => {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("bizonly") === "1";
};

export default function HouseHunt({ year, go }: { year: number; go: (v: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({ district: "", bizcircle: "", maxPrice: "", minYear: "", sort: "commute", kw: "", commute: "", resi: "" });
  const [rows, setRows] = useState<HouseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [wps, setWps] = useState<Workplace[]>([]);
  const [biz, setBiz] = useState<BizCircle[]>([]);
  const [sel, setSel] = useState<HouseRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"list" | "map" | "ai">(initialMode);
  const [bizOnly] = useState(initialBizOnly);

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

  // 商圈候选要全量：从 rows 里派生只能拿到当前这一页（60 条）涉及的商圈，
  // 换 district 或翻页都会跟着变，下拉会「缺货」。改走独立的轻接口。
  useEffect(() => {
    fetchBizcircles().then(setBiz).catch(() => {});
  }, []);

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v, ...(k === "district" ? { bizcircle: "" } : {}) }));

  const view = useMemo(() => {
    const cap = Number(f.commute || 0);
    if (!cap) return rows;
    return rows.filter((r) => (r.transit || []).some((t) => t.min != null && t.min <= cap));
  }, [rows, f.commute]);

  return (
    <div>
      <div className="px-5 pt-6">
        <div className="flex items-end justify-between gap-4">
          <h1 className="text-[26px] tracking-[.05em] font-semibold leading-tight">选房</h1>
          <div className="flex items-center gap-4 sans text-[11.5px] pb-1">
            {(["list", "map", "ai"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setMode(k)}
                style={{
                  color: mode === k ? "var(--color-ink)" : "var(--color-mute)",
                  borderBottom: mode === k ? "1px solid var(--color-seal)" : "1px solid transparent",
                  paddingBottom: 2,
                }}
              >
                {k === "list" ? "列表" : k === "map" ? "地图" : "AI 选房"}
              </button>
            ))}
          </div>
        </div>
        {mode === "ai" ? (
          <div className="sans text-[11.5px] leading-[1.9] mt-2 max-w-[76ch]" style={{ color: "var(--color-ink-2)" }}>
            先说要求（区域、单价、房龄、到一个公司的通勤上限、学区梯度和半径），程序在本地库里<b>硬筛</b>，
            再按通勤/学区/房龄/价格可信度打分排序；服务器自己的模型只负责<b>比较与取舍</b>那一段文字。
            价格是<b>挂牌均价</b>不是成交价，学区是<b>最近的学校 + 该校梯队</b>，不是官方对口。
          </div>
        ) : mode === "list" ? (
          <div className="sans text-[11.5px] leading-[1.9] mt-2 max-w-[70ch]" style={{ color: "var(--color-ink-2)" }}>
            公司地址只决定通勤，不决定分数。单价取自多个站点的<b>小区挂牌均价</b>（安居客移动站为主，链家/贝壳/我爱我家有登录态时补抓），
            多源小区按<b>中位数</b>取主值、另给最低—最高区间，不取平均；通勤是高德公交加步行的早高峰口径。
            没有来源的值一律留空，不做估算。
          </div>
        ) : (
          <div className="sans text-[11.5px] leading-[1.9] mt-2 max-w-[76ch]" style={{ color: "var(--color-ink-2)" }}>
            商圈面按小区分布的<b>最近质心</b>推断（高德只到区县，没有官方商圈边界），颜色是该商圈的<b>中位单价</b>，不是算术平均。
            点商圈看读数，再跳回列表；灰虚线是站点自己的兜底商圈（「大兴周边」这类），不参与着色。
            右上角可以在<b>只看商圈</b>和<b>商圈 + 小区</b>之间切，商圈名与别名在「商圈维护」里改。
          </div>
        )}
        <div className="rule-red-thin mt-4" />
      </div>

      {mode === "map" ? (
        <Suspense
          fallback={
            <div className="py-16 text-center" style={{ color: "var(--color-mute)" }}>
              地图加载中…
            </div>
          }
        >
          <MapView
            bizOnly={bizOnly}
            onPickBiz={(b) => {
              setF((p) => ({ ...p, district: b.district, bizcircle: b.bizcircle }));
              setMode("list");
            }}
          />
        </Suspense>
      ) : mode === "ai" ? (
        <AiPick
          year={year}
          wps={wps}
          biz={biz}
          onLocate={(row) => { setSel(row); setMode("list"); }}
        />
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px]">
      <section className="pb-10">
        <FilterBar f={f} set={set} biz={biz} total={total} shown={view.length} />

        <div className="px-5 m-scroll">
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
        <HouseDetail row={sel} year={year} onClose={() => setSel(null)} />
      ) : (
        <aside className="hidden lg:block sticky top-0 self-start h-screen px-7 py-6"
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
      )}
    </div>
  );
}
