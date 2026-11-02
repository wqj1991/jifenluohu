import { useMemo, useState } from "react";
import {
  fetchRoutes, saveRoute, dropRoute, measureRoutes, searchCommunities, useApi,
  type RouteRow, type CommHit,
} from "../../lib/maint";
import { PageHead, Facts, Band, Field, Seg, Suggest, Skeleton, Notice, Empty, dash } from "./Ui";

const PAGE = 120;

const onlyOpts = [
  { v: "", l: "全部" },
  { v: "manual", l: "手填" },
  { v: "measured", l: "实测" },
  { v: "estimate", l: "估算" },
  { v: "missing", l: "未测" },
  { v: "stale", l: "超 30 天" },
];
const sortOpts = [
  { v: "min", l: "最快优先" },
  { v: "min-desc", l: "最远优先" },
  { v: "price", l: "房价" },
  { v: "name", l: "小区名" },
];

const shortAddr = (a: string | null) => {
  if (!a) return "未定位";
  const s = a.replace(/^北京市?/, "");
  return s.length > 14 ? `…${s.slice(-14)}` : s;
};
// 08:10 + 53 分钟 → 09:03
function arrive(depart: string, m: number | null) {
  if (m == null) return null;
  const [h, mm] = (depart || "08:10").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(mm)) return null;
  const t = h * 60 + mm + m;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
const span = (r: RouteRow) =>
  r.min == null ? "—" : r.max != null && r.max !== r.min ? `${r.min}–${r.max}` : `${r.min}`;

const SOURCE_LABEL: Record<string, string> = { amap: "实测", manual: "手填", estimate: "估算" };

const blank = {
  community_id: 0, community_name: "",
  minutes_min: "", minutes_max: "", line_text: "", depart_at: "",
  note: "", verified: false, recId: 0,
};

export default function RouteMaint({ bare }: { bare?: boolean }) {
  const [wpId, setWpId] = useState<number | null>(null);
  const [district, setDistrict] = useState("");
  const [only, setOnly] = useState("");
  const [sort, setSort] = useState("min");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(20);

  const [form, setForm] = useState({ ...blank });
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  const { data, busy, error, reload } = useApi(
    () => fetchRoutes({ wpId: wpId ?? undefined, district, q, only, sort, limit: PAGE, offset: page * PAGE }),
    [wpId, district, q, only, sort, page]
  );

  const rows = data?.rows || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const wp = data?.wp || null;
  const cover = data?.coverage;
  const pct = cover && cover.communities ? Math.round((cover.recorded / cover.communities) * 100) : 0;

  const districts = useMemo(
    () => [{ v: "", l: "全部区" }, ...(data?.byDistrict || []).map((b) => ({ v: b.district, l: b.district }))],
    [data?.byDistrict]
  );

  const wpOpts = (data?.wps || []).map((w) => ({ v: String(w.id), l: `${w.label || "工作地点"} · ${shortAddr(w.address)}` }));
  const curWp = wp ? String(wp.id) : "";

  const reset = (fn: () => void) => { fn(); setPage(0); };

  const startEdit = (r: RouteRow) => {
    const rec = r.rec;
    setForm({
      community_id: r.id,
      community_name: r.name.trim(),
      minutes_min: rec?.minutes_min != null ? String(rec.minutes_min) : r.min != null ? String(r.min) : "",
      minutes_max: rec?.minutes_max != null ? String(rec.minutes_max) : r.max != null ? String(r.max) : "",
      line_text: rec?.line_text || "",
      depart_at: rec?.depart_at || data?.departDefault || "08:10",
      note: rec?.note || "",
      verified: !!rec?.verified,
      recId: rec?.id || 0,
    });
    setMsg("");
    setOpen(true);
  };

  const startNew = () => {
    setForm({ ...blank, depart_at: data?.departDefault || "08:10" });
    setMsg("");
    setOpen(true);
  };

  const submit = async () => {
    if (!wp) return;
    if (!form.community_id) { setMsg("先在「小区」里点一个候选"); return; }
    const min = Number(form.minutes_min);
    if (!min || min <= 0) { setMsg("最快耗时填个正数分钟"); return; }
    setSaving(true);
    const r = await saveRoute({
      community_id: form.community_id,
      wp_id: wp.id,
      minutes_min: min,
      minutes_max: Number(form.minutes_max) || min,
      depart_at: form.depart_at || undefined,
      line_text: form.line_text || undefined,
      note: form.note || undefined,
      verified: form.verified,
      distance_m: null,
    });
    setSaving(false);
    if (r.ok) {
      setMsg(`已写入：${form.community_name} → ${wp.label || "工作地点"} ${min}′`);
      setOpen(false);
      reload();
    } else setMsg(r.error || "写入失败");
  };

  // 单条重测：覆盖时间与线路，手填的备注和核实标记保留
  const remeasure = async (r: RouteRow) => {
    if (!wp) return;
    setRunning(`row-${r.id}`);
    setMsg("");
    const res = await measureRoutes({ wp_id: wp.id, community_id: r.id });
    setRunning(null);
    if (res.ok && res.row) {
      setMsg(`${r.name}：${res.row.minutes_min}–${res.row.minutes_max} 分钟，${res.row.line_text || "无线路摘要"}`);
      reload();
    } else setMsg(res.error || "高德没返回方案");
  };

  // 批量补测：只补当前筛选下的缺失行，一次限 limit 条，避免把接口额度打光
  const batch = async () => {
    if (!wp) return;
    setRunning("batch");
    setMsg("");
    const res = await measureRoutes({ wp_id: wp.id, district: district || undefined, limit, only: "missing" });
    setRunning(null);
    if (res.ok) {
      setMsg(
        `本轮 ${res.requested ?? 0} 条，成功 ${res.hit ?? 0}，失败 ${res.fail ?? 0}` +
        `${res.seconds ? ` · 用时 ${res.seconds}s` : ""}${res.remaining ? ` · 还剩 ${res.remaining} 条未测` : ""}` +
        `${res.sample?.length ? ` · ${res.sample[0]}` : ""}`
      );
      reload();
    } else setMsg(res.error || "批量补测失败");
  };

  const remove = async (r: RouteRow) => {
    if (!r.rec) return;
    const res = await dropRoute(r.rec.id);
    if (res.ok) { setMsg(`已删除 ${r.name} 的这条记录`); reload(); }
    else setMsg(res.error || "删除失败");
  };

  const body = (
    <>
      <Facts items={[
        { k: "选定公司", v: wp ? shortAddr(wp.address) : dash(null), tone: "mute" },
        { k: "已测小区", v: cover ? `${cover.recorded} / ${cover.communities}` : dash(null) },
        { k: "覆盖率", v: cover ? `${pct}%` : dash(null), tone: pct >= 80 ? "green" : "seal" },
        { k: "高德实测", v: data ? String(data.stats.amap) : dash(null) },
        { k: "手填", v: data ? String(data.stats.manual) : dash(null) },
        { k: "中位耗时", v: data?.stats.avgMin != null ? `${data.stats.avgMin}′` : dash(null) },
        { k: "最近测算", v: data?.stats.last || dash(null), tone: "mute" },
        { k: "待刷新", v: data ? String(data.stats.stale) : dash(null), tone: data?.stats.stale ? "seal" : undefined },
      ]} />

      <div className="px-8 md:px-16 py-3 flex flex-wrap items-center gap-x-6 gap-y-2"
        style={{ borderTop: "1px solid var(--color-rule-2)", borderBottom: "1px solid var(--color-rule)" }}>
        <Seg value={curWp} options={wpOpts} onChange={(v) => reset(() => setWpId(Number(v)))} />
        <span className="flex items-center gap-2 sans text-[11px]" style={{ color: "var(--color-mute)" }}>
          批量补测
          <input
            className="bg-transparent outline-none text-[11px] w-10 num"
            style={{ color: "var(--color-ink)", borderBottom: "1px solid var(--color-rule-2)", padding: "2px 2px" }}
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
          />
          <button className="m-row-act" onClick={batch} disabled={running === "batch" || !wp}>
            {running === "batch" ? "测算中…" : "开始"}
          </button>
        </span>
        <button className="m-row-act ml-auto" onClick={startNew}>手填一条</button>
      </div>

      {open ? (
        <Band onReset={() => setOpen(false)}>
          <Suggest<CommHit>
            label="小区"
            placeholder="搜小区名"
            w="16rem"
            value={form.community_name}
            onChange={(t) => setForm({ ...form, community_name: t, community_id: 0 })}
            fetcher={(t) => searchCommunities(t, district || undefined)}
            render={(c) => (
              <span className="flex items-baseline gap-2 text-[11.5px]">
                <span>{c.name.trim()}</span>
                <span className="sans text-[10px]" style={{ color: "var(--color-mute)" }}>
                  {c.district}{c.bizcircle ? ` · ${c.bizcircle}` : ""}
                </span>
              </span>
            )}
            onPick={(c) => setForm({ ...form, community_id: c.id, community_name: c.name.trim() })}
            hint={form.community_id ? "已选定这条小区" : "必须从候选里点一个"}
          />
          <Field label="最快 分钟" w="6.5rem">
            <input className="m-input num" inputMode="numeric" placeholder="55"
              value={form.minutes_min} onChange={(e) => setForm({ ...form, minutes_min: e.target.value })} />
          </Field>
          <Field label="最慢 分钟" w="6.5rem" hint="留空=同最快">
            <input className="m-input num" inputMode="numeric" placeholder="68"
              value={form.minutes_max} onChange={(e) => setForm({ ...form, minutes_max: e.target.value })} />
          </Field>
          <Field label="出发时刻" w="6.5rem" hint="HH:MM">
            <input className="m-input num" placeholder="08:10"
              value={form.depart_at} onChange={(e) => setForm({ ...form, depart_at: e.target.value })} />
          </Field>
          <Field label="线路摘要" w="20rem">
            <input className="m-input" placeholder="地铁 4 号线 → 亦庄线 → 步行 600 米"
              value={form.line_text} onChange={(e) => setForm({ ...form, line_text: e.target.value })} />
          </Field>
          <Field label="备注" w="14rem">
            <input className="m-input" placeholder="例：实测周二早高峰"
              value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 sans text-[11.5px] pb-2" style={{ color: "var(--color-mute)" }}>
            <input type="checkbox" checked={form.verified}
              onChange={(e) => setForm({ ...form, verified: e.target.checked })} />
            已核实
          </label>
          <button className="m-btn" onClick={submit} disabled={saving || !form.minutes_min}>
            {saving ? "写入中" : form.recId ? "覆盖这条" : "写入"}
          </button>
          {msg ? <span className="sans text-[11px] max-w-[24rem] leading-[1.6]" style={{ color: "var(--color-mute)" }}>{msg}</span> : null}
        </Band>
      ) : msg ? (
        <div className="px-8 md:px-16 pt-2">
          <Notice tone="quiet">{msg}</Notice>
        </div>
      ) : null}

      <div className="px-8 md:px-16">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3"
          style={{ borderBottom: "1px solid var(--color-rule)" }}>
          <Seg value={district} options={districts} onChange={(v) => reset(() => setDistrict(v))} />
          <Seg value={only} options={onlyOpts} onChange={(v) => reset(() => setOnly(v))} />
          <Seg value={sort} options={sortOpts} onChange={(v) => reset(() => setSort(v))} />
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
              {b.district} <span className="num" style={{ color: "var(--color-ink-2)" }}>{b.recorded}</span>
              <span className="num"> / {b.n}</span>
            </span>
          ))}
          <span className="ml-auto num">命中 {total.toLocaleString()} 个</span>
        </div>

        {error ? (
          <Notice>接口未响应：{error}</Notice>
        ) : busy && !rows.length ? (
          <Skeleton />
        ) : !wp ? (
          <Empty
            lead="还没有工作地点，没法算路线。"
            why="小区维护只负责存路线和时间；起点在公司这一侧。先去「公司地点线路维护」把公司地址建档，回来这里就有可比的对象了。"
          />
        ) : !rows.length ? (
          <Empty
            lead="这个筛选下没有小区。"
            why="未测筛选看的是还没有记录的小区；把它们补测之后就会出现在「实测」里。也可以在片区里挑几个重点小区单独测。"
          />
        ) : (
          <table className="m-table">
            <thead>
              <tr>
                <th>小区</th>
                <th>商圈</th>
                <th className="text-right">单价 万</th>
                <th className="text-right">最快 分钟</th>
                <th className="text-right">区间</th>
                <th>出发 → 到达</th>
                <th>线路</th>
                <th className="text-right">来源</th>
                <th className="text-right">时点</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const depart = r.rec?.depart_at || data?.departDefault || "08:10";
                const a1 = arrive(depart, r.min);
                const a2 = arrive(depart, r.max);
                return (
                  <tr key={r.id} className="m-row">
                    <td style={{ color: "var(--color-ink)" }}>{r.name.trim()}</td>
                    <td className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{dash(r.bizcircle)}</td>
                    <td className="num text-right" style={{ color: r.price ? "var(--color-ink-2)" : "var(--color-mute)" }}>
                      {r.price == null ? "—" : (r.price / 10000).toFixed(2)}
                    </td>
                    <td className="num text-right" style={{
                      color: r.source === "manual" ? "var(--color-seal)" : r.source === "amap" ? "var(--color-ink)" : "var(--color-mute)",
                      fontWeight: r.source ? 500 : 400,
                    }}>
                      {r.min == null ? "—" : `${r.min}′`}
                    </td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>{span(r)}</td>
                    <td className="num text-[11.5px]" style={{ color: "var(--color-ink-2)" }}>
                      {r.min == null ? "—" : `${depart} → ${a1}${a2 && a2 !== a1 ? ` ~ ${a2}` : ""}`}
                    </td>
                    <td className="sans text-[10.5px] max-w-[24rem] truncate" style={{ color: "var(--color-mute)" }}
                      title={r.rec?.line_text || ""}>
                      {r.rec?.line_text || "—"}
                    </td>
                    <td className="text-right sans text-[10.5px]" style={{
                      color: r.source === "manual" ? "var(--color-seal)"
                        : r.source === "amap" ? "var(--color-green)"
                        : "var(--color-mute)",
                    }}>
                      {r.source ? SOURCE_LABEL[r.source] : "未测"}
                      {r.stale ? <span className="ml-1">待刷新</span> : null}
                    </td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>{r.fetched_at || "—"}</td>
                    <td className="text-right whitespace-nowrap">
                      <button className="m-row-act" onClick={() => startEdit(r)}>{r.rec ? "改" : "手填"}</button>
                      <button className="m-row-act ml-2" data-quiet="true"
                        onClick={() => remeasure(r)} disabled={running === `row-${r.id}`}>
                        {running === `row-${r.id}` ? "测算中…" : "测"}
                      </button>
                      {r.rec ? (
                        <button className="m-row-act ml-2" data-quiet="true" onClick={() => remove(r)}>删</button>
                      ) : null}
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
          <span className="ml-auto max-w-[58ch] leading-[1.8]">
            一分钟内的差别对通勤没意义，这里给的是区间：最快那个方案的耗时作下限，同城前三方案的较慢值作上限，出发时刻按早高峰
            <span className="num"> 08:10</span> 反推到达。没测过的小区显示的是商圈质心估算值，灰色、写成「估算」，不当实测用。
          </span>
        </div>
      </div>
    </>
  );

  if (bare) return body;

  return (
    <>
      <PageHead
        title="小区路线与时间"
        note={
          <>
            一个小区对一个公司一行，记最快耗时和区间，出发时刻按早高峰反推到达。高德算的是<b>同一时刻的公交 + 步行</b>方案，
            不是你哪天实际堵了多久；你亲自跑过的就把数字手填进去，标「已核实」，之后批量重测只覆盖时间和线路，不动你的备注。
          </>
        }
      >
        <button className="m-btn m-btn-quiet" onClick={reload}>重读台账</button>
      </PageHead>
      {body}
    </>
  );
}
