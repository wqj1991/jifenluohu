// AI 选房：条件表单 + 本地库筛选结果 + 模型解读。
// 数字全部来自本地 sqlite；模型只负责「取舍判断」这段文字，且 id 会被后端白名单校验。
import { useEffect, useMemo, useState } from "react";
import {
  aiConfig, aiParse, aiPick,
  type AiCandidate, type AiCond, type AiPickResp, type BizCircle, type HouseRow, type Workplace,
} from "../lib/api";
import { createPortal } from "react-dom";
import HouseDetail from "./HouseDetail";

const wan = (n: number | null | undefined) => (n == null ? "—" : (n / 10000).toFixed(2));

/** 公司显示名：库里的 label 常常都叫「公司」，只能靠地址认（环球贸易中心 / 施耐德园区） */
const placeOf = (w: { label?: string | null; address?: string | null }) => {
  const a = String(w.address || "").replace(/^北京市?/, "").replace(/[（(].*$/, "").trim();
  return a || w.label || "公司";
};

const MIN_OPTS = [45, 60, 75, 90, 120];
const STAGE_OPTS = ["小学", "中学"];
const TIER_OPTS = ["一梯队", "二梯队", "三梯队"];
const KM_OPTS = [1, 2, 3, 5];

/** 一行通勤要求；空字符串代表不限 */
type CRow = { wpId: string; maxMin: string };
/** 一行学区要求 */
type SRow = { stage: string; tier: string; maxKm: string };

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className="sans text-[10.5px] tracking-[.08em]" style={{ color: "var(--color-mute)" }}>
      {label}
      {hint ? <span style={{ color: "var(--color-rule-2)" }}> · {hint}</span> : null}
    </span>
    {children}
  </label>
);

const RowAdd = ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
  <button
    className="sans self-start text-[11px] px-2 py-[1px]"
    style={{
      border: "1px dashed var(--color-rule-2)",
      color: disabled ? "var(--color-rule-2)" : "var(--color-seal)",
    }}
    disabled={disabled}
    onClick={onClick}
  >
    {label}
  </button>
);

export default function AiPick({
  year, wps, biz, onLocate,
}: {
  year: number;
  wps: Workplace[];
  biz: BizCircle[];
  onLocate: (row: HouseRow) => void;
}) {
  const [district, setDistrict] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [priceMax, setPriceMax] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [buildYearMin, setBuildYearMin] = useState("");
  // 通勤：可以同时盯两个公司（环球贸易 ≤75 + 施耐德 ≤90）
  const [crows, setCrows] = useState<CRow[]>([{ wpId: "", maxMin: "" }]);
  // 学区：小学、初中各一条
  const [srows, setSrows] = useState<SRow[]>([{ stage: "", tier: "", maxKm: "" }]);
  const [brief, setBrief] = useState("");

  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AiPickResp | null>(null);
  const [err, setErr] = useState("");
  const [cfg, setCfg] = useState<{ enabled: boolean; model: string } | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseNote, setParseNote] = useState("");
  // 抽屉里正在看的那一个（点任意候选卡片打开，不跳走去列表）
  const [detail, setDetail] = useState<AiCandidate | null>(null);

  useEffect(() => { aiConfig().then(setCfg).catch(() => {}); }, []);
  // 默认拿第一个办公地当通勤基准，省一步操作
  useEffect(() => {
    if (!wps.length) return;
    setCrows((rows) => rows.map((r) => (r.wpId ? r : { ...r, wpId: String(wps[0].id) })));
  }, [wps]);

  const bizList = useMemo(
    () => (district ? biz.filter((b) => b.district === district) : biz),
    [biz, district],
  );

  const toggleBiz = (name: string) =>
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name].slice(0, 6)));

  /** 公司下拉项：同名就补一个地名/编号，避免两个「公司」分不出来 */
  const wpOptions = useMemo(() => {
    const places = wps.map((w) => placeOf(w));
    return wps.map((w, i) => {
      const dup = places.filter((x) => x === places[i]).length > 1;
      return { id: w.id, text: dup ? `${places[i]}（#${w.id}）` : places[i] };
    });
  }, [wps]);

  const body = (): AiCond => ({
    district,
    bizcircles: picked,
    priceMin: priceMin ? Number(priceMin) : null,
    priceMax: priceMax ? Number(priceMax) : null,
    buildYearMin: buildYearMin ? Number(buildYearMin) : null,
    commutes: crows
      .filter((r) => r.wpId || r.maxMin)
      .map((r) => ({ wpId: r.wpId ? Number(r.wpId) : null, maxMin: r.maxMin ? Number(r.maxMin) : null })),
    schools: srows
      .filter((r) => r.stage || r.tier || r.maxKm)
      .map((r) => ({ stage: r.stage, tier: r.tier, maxKm: r.maxKm ? Number(r.maxKm) : null })),
    brief: brief.trim(),
    topN: 12,
  });

  const run = async () => {
    setBusy(true); setErr(""); setParseNote("");
    try {
      const d = await aiPick(body());
      // ok:false 时没有 candidates/filters，先接住再说，别让渲染崩掉
      if (!d || d.ok === false) {
        setRes(null);
        setErr(d?.error || "筛选失败，换个条件再试");
        return;
      }
      setRes(d);
    } catch (e) {
      setRes(null);
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  /** 一句话 → 条件回填（只是抽取，不查库） */
  const parse = async () => {
    const t = brief.trim();
    if (!t) { setParseNote("先写一句你的要求"); return; }
    setParsing(true); setParseNote("");
    try {
      const r = await aiParse(t);
      if (!r.ok || !r.parsed) { setParseNote(r.error || "没抽出来，手动填条件即可"); return; }
      const p = r.parsed;
      if (p.district) setDistrict(p.district);
      if (p.bizcircles?.length) setPicked(p.bizcircles);
      if (p.priceMax) setPriceMax(String(p.priceMax));
      if (p.priceMin) setPriceMin(String(p.priceMin));
      if (p.buildYearMin) setBuildYearMin(String(p.buildYearMin));
      if (p.commutes?.length) {
        setCrows(p.commutes.slice(0, 3).map((c) => ({
          wpId: c.wpId != null ? String(c.wpId) : "",
          maxMin: c.maxMin != null ? String(c.maxMin) : "",
        })));
      } else if (p.maxMin) {
        setCrows([{ wpId: wps[0] ? String(wps[0].id) : "", maxMin: String(p.maxMin) }]);
      }
      if (p.schools?.length) {
        setSrows(p.schools.slice(0, 2).map((s) => ({
          stage: s.stage || "",
          tier: s.tier || "",
          maxKm: s.maxKm != null ? String(s.maxKm) : "",
        })));
      } else if (p.schoolStage || p.schoolTier) {
        setSrows([{ stage: p.schoolStage || "", tier: p.schoolTier || "", maxKm: p.maxKm ? String(p.maxKm) : "" }]);
      }
      setParseNote(p.note ? `已回填；模型备注：${p.note}` : "条件已回填，可再手改");
    } catch (e) {
      setParseNote(String((e as Error).message || e));
    } finally {
      setParsing(false);
    }
  };

  useEffect(() => {
    if (!detail) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setDetail(null); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [detail]);

  const aiById = useMemo(() => {
    const m = new Map<number, { verdict: string; reason: string; risk: string; rank: number }>();
    for (const p of res?.ai?.picks || []) m.set(p.id, p);
    return m;
  }, [res]);

  const setC = (i: number, patch: Partial<CRow>) =>
    setCrows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setS = (i: number, patch: Partial<SRow>) =>
    setSrows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr]">
      {/* ---------- 条件 ---------- */}
      <aside className="px-5 py-4" style={{ borderRight: "1px solid var(--color-rule-2)" }}>
        <div className="sans text-[10.5px] tracking-[.14em]" style={{ color: "var(--color-mute)" }}>
          筛选条件
        </div>

        <div className="mt-3 flex flex-col gap-3">
          <Field label="一句话要求" hint="写完可让 AI 补全下面各项">
            <textarea
              className="m-input sans"
              rows={2}
              placeholder="大兴西红门，单价 4 万以下，小学二梯队，到环球贸易 75 分钟"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
            <button className="m-btn m-btn-quiet self-start mt-1" disabled={parsing} onClick={parse}>
              {parsing ? "解析中…" : "按描述补全条件"}
            </button>
          </Field>

          <Field label="区域">
            <select className="m-input sans" value={district} onChange={(e) => { setDistrict(e.target.value); setPicked([]); }}>
              <option value="">通州 + 大兴（全部）</option>
              <option value="通州">通州</option>
              <option value="大兴">大兴</option>
            </select>
          </Field>

          <Field label="商圈" hint={picked.length ? `已选 ${picked.length}` : "不选=不限"}>
            <div className="m-scroll flex flex-wrap gap-1.5 max-h-[132px] overflow-y-auto pr-1">
              {bizList.map((b) => {
                const on = picked.includes(b.bizcircle);
                return (
                  <button
                    key={`${b.district}|${b.bizcircle}`}
                    onClick={() => toggleBiz(b.bizcircle)}
                    className="sans px-2 py-[2px] text-[11px]"
                    style={{
                      border: `1px solid ${on ? "var(--color-seal)" : "var(--color-rule)"}`,
                      color: on ? "var(--color-seal)" : "var(--color-ink-2)",
                      background: on ? "rgba(138,28,20,.04)" : "transparent",
                    }}
                  >
                    {b.bizcircle}
                  </button>
                );
              })}
              {!bizList.length && <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>商圈清单未加载</span>}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="单价下限" hint="万/㎡">
              <input className="m-input num" type="number" step="0.1" placeholder="不限" value={priceMin ? Number(priceMin) / 10000 : ""}
                onChange={(e) => setPriceMin(e.target.value ? String(Math.round(Number(e.target.value) * 10000)) : "")} />
            </Field>
            <Field label="单价上限" hint="万/㎡">
              <input className="m-input num" type="number" step="0.1" placeholder="不限" value={priceMax ? Number(priceMax) / 10000 : ""}
                onChange={(e) => setPriceMax(e.target.value ? String(Math.round(Number(e.target.value) * 10000)) : "")} />
            </Field>
          </div>

          <Field label="建成年" hint="下限">
            <select className="m-input sans num" value={buildYearMin} onChange={(e) => setBuildYearMin(e.target.value)}>
              <option value="">不限</option>
              {[2020, 2015, 2010, 2005, 2000].map((y) => <option key={y} value={y}>≥ {y}</option>)}
            </select>
          </Field>

          {/* 通勤：公司可以加第二个，各自一个上限 */}
          <div className="flex flex-col gap-2">
            <span className="sans text-[10.5px] tracking-[.08em]" style={{ color: "var(--color-mute)" }}>
              通勤要求<span style={{ color: "var(--color-rule-2)" }}> · 多个公司要同时满足</span>
            </span>
            {crows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_78px_20px] items-center gap-1.5">
                <select className="m-input sans" value={r.wpId} onChange={(e) => setC(i, { wpId: e.target.value })}>
                  <option value="">不指定公司</option>
                  {wpOptions.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
                </select>
                <select className="m-input sans num" value={r.maxMin} onChange={(e) => setC(i, { maxMin: e.target.value })}>
                  <option value="">不限</option>
                  {MIN_OPTS.map((m) => <option key={m} value={m}>≤ {m} 分</option>)}
                </select>
                <button
                  className="sans text-[13px] leading-none"
                  style={{ color: crows.length > 1 ? "var(--color-mute)" : "var(--color-rule-2)" }}
                  disabled={crows.length <= 1}
                  onClick={() => setCrows((rows) => rows.filter((_, j) => j !== i))}
                  title="删除这条"
                >
                  ×
                </button>
              </div>
            ))}
            <RowAdd
              label="+ 再加一个公司"
              disabled={crows.length >= 3}
              onClick={() => setCrows((rows) => [...rows, { wpId: wps[1] ? String(wps[1].id) : "", maxMin: "" }])}
            />
          </div>

          {/* 学区：小学、初中各一条 */}
          <div className="flex flex-col gap-2">
            <span className="sans text-[10.5px] tracking-[.08em]" style={{ color: "var(--color-mute)" }}>
              学区要求<span style={{ color: "var(--color-rule-2)" }}> · 小学 / 初中可各一条</span>
            </span>
            {srows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_62px_20px] items-center gap-1.5">
                <select className="m-input sans" value={r.stage} onChange={(e) => setS(i, { stage: e.target.value })}>
                  <option value="">学段</option>
                  {STAGE_OPTS.map((s) => <option key={s} value={s}>{s === "中学" ? "初中" : s}</option>)}
                </select>
                <select className="m-input sans" value={r.tier} onChange={(e) => setS(i, { tier: e.target.value })}>
                  <option value="">梯队不限</option>
                  {TIER_OPTS.map((t) => <option key={t} value={t}>{t}以内</option>)}
                </select>
                <select className="m-input sans num" value={r.maxKm} onChange={(e) => setS(i, { maxKm: e.target.value })}>
                  <option value="">km</option>
                  {KM_OPTS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <button
                  className="sans text-[13px] leading-none"
                  style={{ color: srows.length > 1 ? "var(--color-mute)" : "var(--color-rule-2)" }}
                  disabled={srows.length <= 1}
                  onClick={() => setSrows((rows) => rows.filter((_, j) => j !== i))}
                  title="删除这条"
                >
                  ×
                </button>
              </div>
            ))}
            <RowAdd
              label="+ 再加一条（小学/初中）"
              disabled={srows.length >= 2}
              onClick={() => setSrows((rows) => [...rows, { stage: rows.some((r) => r.stage === "小学") ? "中学" : "小学", tier: "", maxKm: "" }])}
            />
          </div>

          <button className="m-btn mt-1" disabled={busy} onClick={run}>
            {busy ? "筛选中…" : "让 AI 从库里挑"}
          </button>

          <div className="sans text-[10.5px] leading-[1.8]" style={{ color: "var(--color-mute)" }}>
            {cfg
              ? cfg.enabled
                ? <>模型：{cfg.model}（服务器本地）</>
                : <>模型未接通，只出本地排序</>
              : "…"}
            {parseNote ? <div style={{ color: "var(--color-seal-soft)" }}>{parseNote}</div> : null}
          </div>
        </div>
      </aside>

      {/* ---------- 结果 ---------- */}
      <section className="px-5 py-4 pb-12">
        {err && (
          <div
            className="sans text-[12px] py-2 px-3 my-1"
            style={{ color: "var(--color-seal)", borderLeft: "2px solid var(--color-seal)", background: "rgba(138,28,20,.03)" }}
          >
            {err}
          </div>
        )}

        {!res && !err && (
          <div className="py-16 text-center sans text-[12px]" style={{ color: "var(--color-mute)" }}>
            左侧填条件（或写一句话让 AI 补全），再点「让 AI 从库里挑」。<br />
            筛选与打分全部在本地库完成，模型只做取舍解读。
          </div>
        )}

        {res && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {res.filters.map((f, i) => (
                <span key={`${f.k}-${i}`} className="sans text-[11px] px-2 py-[1px]"
                  style={{ border: "1px solid var(--color-rule)", color: "var(--color-ink-2)" }}>
                  <span style={{ color: "var(--color-mute)" }}>{f.k}</span> {f.v}
                </span>
              ))}
              {!res.filters.length && <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>无硬条件，按通勤/学区/房龄/价格综合排</span>}
            </div>

            {res.warnings?.length ? (
              <div className="mt-2 sans text-[11px]" style={{ color: "var(--color-seal-soft)" }}>
                {res.warnings.map((w, i) => <div key={i}>· {w}</div>)}
              </div>
            ) : null}

            <div className="sans text-[11px] mt-2" style={{ color: "var(--color-mute)" }}>
              库内扫描 <b className="num">{res.pool.scanned}</b> 个小区 · 命中 <b className="num">{res.pool.matched}</b>
              {res.pool.droppedByCommute ? <> · 通勤筛掉 <b className="num">{res.pool.droppedByCommute}</b></> : null}
              {res.pool.droppedBySchool ? <> · 学区筛掉 <b className="num">{res.pool.droppedBySchool}</b></> : null}
              {" "}· 入榜 <b className="num">{res.pool.shortlist}</b>（{res.elapsed} ms）
            </div>

            <div className="rule-red-thin mt-3 mb-1" />

            {res.ai?.summary && (
              <div className="py-3 my-2" style={{ borderBottom: "1px dotted var(--color-rule-2)" }}>
                <div className="sans text-[10.5px] tracking-[.14em] mb-1" style={{ color: "var(--color-seal)" }}>
                  AI 取舍
                </div>
                <p className="text-[13px] leading-[1.85] max-w-[78ch]">{res.ai.summary}</p>
                {res.ai.picks.length < res.candidates.length && (
                  <div className="sans text-[10.5px] mt-1" style={{ color: "var(--color-mute)" }}>
                    AI 只解读前 {res.ai.picks.length} 个（模型：{res.ai.model}，{res.ai.ms} ms），第 {res.ai.picks.length + 1} 名往后按本地分排。
                  </div>
                )}
              </div>
            )}

            {res.aiError && (
              <div className="sans text-[11px] py-2" style={{ color: "var(--color-mute)" }}>
                模型解读这轮没出来（{res.aiError}），下面仍是本地打分排序。
              </div>
            )}

            {!res.candidates.length && (
              <div className="py-12 text-center sans text-[12px]" style={{ color: "var(--color-mute)" }}>
                条件过紧，一个都没剩下。放宽单价、通勤或学区梯队再试。
              </div>
            )}

            <div>
              {res.candidates.map((c, i) => {
                const a = aiById.get(c.id);
                // 卡了通勤就报卡住的那几条；一条没卡就退回第一个有数的通勤
                const cs = (c.commute || []).filter((x) => x.min != null);
                const fallback = c.transit.find((x) => x.min != null);
                const schools = c.schools?.length ? c.schools : c.school ? [c.school] : [];
                return (
                  <div
                    key={c.id}
                    onClick={() => setDetail(c)}
                    className="py-3 cursor-pointer transition-colors hover:bg-[rgba(138,28,20,.028)]"
                    style={{ borderBottom: "1px dotted var(--color-rule-2)" }}
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="num text-[11px]" style={{ color: "var(--color-seal)" }}>
                        {String(a?.rank ?? i + 1).padStart(2, "0")}
                      </span>
                      <h3 className="text-[15px] font-medium tracking-[.02em]">{c.name}</h3>
                      <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>
                        {c.district}{c.bizcircle ? ` · ${c.bizcircle}` : ""}
                      </span>
                      {a?.verdict && (
                        <span className="sans text-[10.5px] px-1.5 py-[1px]"
                          style={{ border: "1px solid var(--color-seal)", color: "var(--color-seal)" }}>
                          {a.verdict}
                        </span>
                      )}
                      <span className="ml-auto num text-[12px]" style={{ color: "var(--color-ink-2)" }}>
                        {c.score}
                      </span>
                    </div>

                    <div className="sans text-[11.5px] mt-1.5 flex flex-wrap gap-x-4 gap-y-1" style={{ color: "var(--color-ink-2)" }}>
                      <span>
                        单价 <b className="num" style={{ color: "var(--color-ink)" }}>{wan(c.price)}</b> 万/㎡
                        {c.price_low != null && c.price_high != null && c.price_low !== c.price_high && (
                          <span className="num" style={{ color: "var(--color-mute)" }}>（{wan(c.price_low)}–{wan(c.price_high)}，{c.price_src_n} 源）</span>
                        )}
                      </span>
                      <span>{c.build_year ? `${c.build_year} 年建` : "建成年未知"}{c.build_type ? ` · ${c.build_type}` : ""}</span>
                      {c.bargain != null && <span>议价空间 <b className="num">{(c.bargain * 100).toFixed(0)}%</b></span>}
                      {c.price_tx && <span>成交 <b className="num">{wan(c.price_tx)}</b> 万/㎡</span>}
                    </div>

                    <div className="sans text-[11.5px] mt-1 flex flex-wrap gap-x-4 gap-y-1" style={{ color: "var(--color-ink-2)" }}>
                      {cs.length ? (
                        cs.map((x) => (
                          <span key={x.wp}>
                            通勤 <b className="num" style={{ color: x.maxMin != null && (x.min ?? 0) > x.maxMin ? "var(--color-seal)" : "var(--color-ink)" }}>
                              {x.min}{x.max !== x.min ? `–${x.max}` : ""}
                            </b> 分（{x.label}{x.maxMin != null ? `，上限 ${x.maxMin}` : ""}）
                          </span>
                        ))
                      ) : (
                        <span>
                          通勤 {fallback
                            ? <><b className="num" style={{ color: "var(--color-ink)" }}>{fallback.min}{fallback.max !== fallback.min ? `–${fallback.max}` : ""}</b> 分（{fallback.label}，{fallback.source}）</>
                            : <span style={{ color: "var(--color-mute)" }}>未测</span>}
                        </span>
                      )}
                      {schools.map((s) => (
                        <span key={`${s.stage}-${s.name}`}>
                          学区 {s.stage === "中学" ? "初中" : "小学"} <b style={{ color: "var(--color-ink)" }}>{s.name}</b>
                          {s.tier ? ` ${s.tier}` : " 未定档"} <span className="num">{s.km}</span> km
                        </span>
                      ))}
                      {!schools.length && (
                        <span>
                          学区 <span style={{ color: "var(--color-mute)" }}>周边学校未收录</span>
                        </span>
                      )}
                    </div>

                    {(a?.reason || a?.risk) && (
                      <div className="mt-2 pl-3" style={{ borderLeft: "2px solid var(--color-seal)" }}>
                        {a?.reason && <div className="text-[12.5px] leading-[1.8]">{a.reason}</div>}
                        {a?.risk && (
                          <div className="sans text-[11px] mt-0.5" style={{ color: "var(--color-mute)" }}>
                            要核实：{a.risk}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="mt-2 flex items-center gap-3 sans text-[11px]">
                      <button
                        className="m-row-act"
                        onClick={(e) => { e.stopPropagation(); setDetail(c); }}
                      >
                        看详情 →
                      </button>
                      <span style={{ color: "var(--color-mute)" }}>评分构成：{c.scoreParts.join(" / ")}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* ---------- 详情抽屉 ---------- */}
      {detail && createPortal(
        <>
          <div className="scrim" onClick={() => setDetail(null)} />
          <div className="detail-drawer" role="dialog" aria-modal="true">
            <div className="min-h-0 flex-1">
              <HouseDetail
                row={detail as unknown as HouseRow}
                year={year}
                onClose={() => setDetail(null)}
                variant="drawer"
              />
            </div>
            <div
              className="flex flex-none items-center gap-3 px-5 py-2 sans text-[11px]"
              style={{ borderTop: "1px solid var(--color-rule)" }}
            >
              <button
                className="m-row-act"
                onClick={() => { onLocate(detail as unknown as HouseRow); setDetail(null); }}
              >
                在列表打开详情 →
              </button>
              <span className="ml-auto" style={{ color: "var(--color-mute)" }}>Esc 关闭</span>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
