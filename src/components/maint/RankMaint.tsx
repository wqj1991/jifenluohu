import { useState } from "react";
import {
  fetchRanks, saveRank, dropRank, fetchSummary, searchSchools, useApi,
  type RankRow, type SchoolHit,
} from "../../lib/maint";
import { PageHead, Facts, Band, Field, Seg, Suggest, Skeleton, Notice, Empty, dash } from "./Ui";

const stages = [
  { v: "", l: "全部" },
  { v: "小学", l: "小学" },
  { v: "中学", l: "中学" },
];
const metrics = ["综合", "中考平均分", "区排名", "市重点率", "优质高中录取率"];
const tiers = ["一梯队", "二梯队", "三梯队", "民办/国际", "其他梯队"];
const tierSeg = [{ v: "", l: "全部梯队" }, ...tiers.map((t) => ({ v: t, l: t }))];
const regions = ["通州", "大兴", "经开"];
const regionSeg = [{ v: "", l: "全部区域" }, ...regions.map((x) => ({ v: x, l: x }))];

const blank = {
  id: 0, school_id: 0, school_name: "", stage: "小学", region: "", year: String(new Date().getFullYear()),
  metric: "综合", tier: "", rank: "", score: "", source: "", source_url: "", verified: 0, note: "",
};

const tierTone = (t?: string | null) =>
  t === "一梯队" ? "var(--color-seal)"
    : t === "二梯队" ? "var(--color-ink)"
      : t === "其他梯队" || !t ? "var(--color-mute)" : "var(--color-ink-2)";

export default function RankMaint() {
  const [stage, setStage] = useState("");
  const [region, setRegion] = useState("");
  const [year, setYear] = useState("");
  const [verified, setVerified] = useState("");
  const [tier, setTier] = useState("");
  const [q, setQ] = useState("");

  const list = useApi(() => fetchRanks({ stage, region, year, q, verified, tier }), [stage, region, year, q, verified, tier]);
  const sum = useApi(fetchSummary, []);

  const [form, setForm] = useState({ ...blank });
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const r = sum.data?.rank;
  const rows = list.data?.rows || [];

  const startNew = () => { setForm({ ...blank, stage: stage || "小学", region: region || "", year: year || String(new Date().getFullYear()), tier: tier || "" }); setMsg(""); setOpen(true); };
  const startEdit = (row: RankRow) => {
    setForm({
      id: row.id, school_id: row.school_id || 0, school_name: row.school_name, stage: row.stage,
      region: row.region || "",
      year: String(row.year), metric: row.metric, tier: row.tier || "",
      rank: row.rank == null ? "" : String(row.rank),
      score: row.score == null ? "" : String(row.score),
      source: row.source || "", source_url: row.source_url || "",
      verified: row.verified, note: row.note || "",
    });
    setMsg(""); setOpen(true);
  };

  const submit = async () => {
    setSaving(true);
    const res = await saveRank({
      id: form.id || undefined,
      school_id: form.school_id || null,
      school_name: form.school_name,
      stage: form.stage,
      region: form.region,
      year: Number(form.year),
      metric: form.metric,
      tier: form.tier,
      rank: form.rank === "" ? null : Number(form.rank),
      score: form.score === "" ? null : Number(form.score),
      source: form.source,
      source_url: form.source_url,
      verified: form.verified,
      note: form.note,
    } as Partial<RankRow>);
    setSaving(false);
    if (res.ok) {
      setMsg(res.merged ? "已合并到同名同年度条目" : "已入档");
      setOpen(false);
      list.reload();
      sum.reload();
    } else setMsg(res.error || "写入失败");
  };

  return (
    <>
      <PageHead
        title="学校排名台账"
        note={
          <>
            学校排名没有全市统一口径，中考成绩也不公开到校。这张表只装你自己核实过的条目：每条必须带年度、指标口径和来源。
            没有来源的行按「未核实」标灰，结算与选房页不引用它。
          </>
        }
      >
        <button className="m-btn" onClick={startNew}>+ 录一条</button>
      </PageHead>

      <Facts items={[
        { k: "条目", v: r ? r.n : dash(null) },
        { k: "已核实", v: r ? r.verified : dash(null), tone: r?.verified ? "green" : "mute" },
        { k: "待核实", v: r ? r.n - r.verified : dash(null), tone: r && r.n - r.verified > 0 ? "seal" : "mute" },
        { k: "覆盖年度", v: r?.years ? `${r.years[0]}–${r.years[1]}` : dash(null), tone: "mute" },
        { k: "梯队分布", v: list.data?.byTier?.length
          ? list.data.byTier.map((t) => `${t.t} ${t.c}`).join(" · ")
          : dash(null), tone: "mute" },
        { k: "在册学校", v: sum.data ? `${sum.data.school.primary} 小 / ${sum.data.school.middle} 中` : dash(null), tone: "mute" },
      ]} />

      {open ? (
        <Band onReset={() => setOpen(false)}>
          <Suggest<SchoolHit>
            label="学校"
            w="16rem"
            placeholder="输入校名，或直接手打"
            value={form.school_name}
            onChange={(t) => setForm({ ...form, school_name: t, school_id: 0 })}
            fetcher={(kw) => searchSchools(kw, form.stage)}
            onPick={(hit) => setForm({ ...form, school_id: hit.id, school_name: hit.name, stage: hit.stage })}
            render={(hit) => (
              <span className="truncate">
                {hit.name}
                <span className="sans text-[9.5px] ml-2" style={{ color: "var(--color-mute)" }}>{hit.stage}</span>
              </span>
            )}
            hint={form.school_id ? "已绑定到在册学校" : "手打校名也能存，只是对不上地图"}
          />
          <Field label="阶段" w="6rem">
            <select className="m-input" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
              <option value="小学">小学</option>
              <option value="中学">中学</option>
            </select>
          </Field>
          <Field label="榜单年度" w="6rem">
            <input className="m-input num" inputMode="numeric" value={form.year}
              onChange={(e) => setForm({ ...form, year: e.target.value })} />
          </Field>
          <Field label="指标口径" w="9rem">
            <select className="m-input" value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })}>
              {metrics.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="区域" w="6rem">
            <select className="m-input" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>
              <option value="">未分区</option>
              {regions.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <Field label="梯队" w="7rem">
            <select className="m-input" value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
              <option value="">未分档</option>
              {tiers.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="名次" w="5rem">
            <input className="m-input num" inputMode="numeric" value={form.rank}
              onChange={(e) => setForm({ ...form, rank: e.target.value })} />
          </Field>
          <Field label="分值" w="5.5rem">
            <input className="m-input num" inputMode="decimal" value={form.score}
              onChange={(e) => setForm({ ...form, score: e.target.value })} />
          </Field>
          <Field label="来源 · 文件名或公众号" w="14rem">
            <input className="m-input" placeholder="例：通州区 2026 中考质量分析"
              value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
          </Field>
          <Field label="来源链接" w="12rem">
            <input className="m-input" placeholder="https://…"
              value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} />
          </Field>
          <Field label="备注" w="12rem">
            <input className="m-input" placeholder="口径差异、并列名次等"
              value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 sans text-[11.5px] pb-1.5" style={{ color: "var(--color-ink-2)" }}>
            <input type="checkbox" checked={!!form.verified}
              onChange={(e) => setForm({ ...form, verified: e.target.checked ? 1 : 0 })}
              style={{ width: 14, height: 14, accentColor: "var(--color-seal)" }} />
            已对照原件核实
          </label>
          <button className="m-btn" onClick={submit} disabled={saving || !form.school_name || !form.year}>
            {saving ? "写入中" : "写入台账"}
          </button>
          {msg ? <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{msg}</span> : null}
        </Band>
      ) : null}

      <div className="px-8 md:px-16">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3"
          style={{ borderTop: "1px solid var(--color-rule-2)", borderBottom: "1px solid var(--color-rule)" }}>
          <Seg value={stage} options={stages} onChange={setStage} />
          <Seg value={region} options={regionSeg} onChange={setRegion} />
          <Seg value={tier} options={tierSeg} onChange={setTier} />
          <Seg value={verified} options={[{ v: "", l: "全部" }, { v: "1", l: "已核实" }, { v: "0", l: "待核实" }]} onChange={setVerified} />
          <label className="sans text-[11.5px] flex items-center gap-2" style={{ color: "var(--color-mute)" }}>
            年度
            <select className="bg-transparent outline-none num text-[11.5px]" style={{ color: "var(--color-ink)", borderBottom: "1px solid var(--color-rule-2)" }}
              value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">全部</option>
              {(list.data?.years || []).map((y) => <option key={y} value={String(y)}>{y}</option>)}
            </select>
          </label>
          <label className="ml-auto flex items-center gap-2 sans text-[11.5px]" style={{ color: "var(--color-mute)" }}>
            校名
            <input className="bg-transparent outline-none text-[11.5px] w-32"
              style={{ color: "var(--color-ink)", borderBottom: "1px solid var(--color-rule-2)", padding: "2px 2px" }}
              value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>

        <div className="py-4">
          {list.error ? (
            <Notice>接口未响应：{list.error}</Notice>
          ) : list.busy && !rows.length ? (
            <Skeleton />
          ) : !rows.length ? (
            <Empty
              lead="台账还是空的。"
              why={
                <>
                  这里不预填榜单——学校排名没有官方统一发布，凭印象塞一个看起来合理的名次，等于自己给自己造假依据。
                  建议从区教委的中考质量分析、学校的公开喜报入手，一条一条录，来源写清楚。
                </>
              }
              action={<button className="m-btn" onClick={startNew}>录第一条</button>}
            />
          ) : (
            <table className="m-table">
              <thead>
                <tr>
                  <th>学校</th>
                  <th>阶段</th>
                  <th>区域</th>
                  <th className="text-right">年度</th>
                  <th>口径</th>
                  <th>梯队</th>
                  <th className="text-right">名次</th>
                  <th className="text-right">分值</th>
                  <th>来源</th>
                  <th>核实</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="m-row" style={{ opacity: row.verified ? 1 : .72 }}>
                    <td style={{ color: row.verified ? "var(--color-ink)" : "var(--color-ink-2)" }}>{row.school_name}</td>
                    <td className="sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>{row.stage}</td>
                    <td className="sans text-[10.5px]" style={{ color: "var(--color-ink-2)" }}>{row.region || dash(null)}</td>
                    <td className="num text-right">{row.year}</td>
                    <td className="sans text-[11px]" style={{ color: "var(--color-ink-2)" }}>{row.metric}</td>
                    <td className="sans text-[11px]" style={{ color: tierTone(row.tier) }}>{row.tier || dash(null)}</td>
                    <td className="num text-right">{dash(row.rank)}</td>
                    <td className="num text-right">{dash(row.score)}</td>
                    <td className="sans text-[10.5px] max-w-[16rem] truncate" style={{ color: "var(--color-mute)" }} title={row.source || ""}>
                      {row.source_url
                        ? <a href={row.source_url} target="_blank" rel="noreferrer" style={{ color: "var(--color-seal-soft)", textDecoration: "underline", textUnderlineOffset: 2 }}>{row.source || row.source_url}</a>
                        : dash(row.source)}
                    </td>
                    <td className="sans text-[10px]" style={{ color: row.verified ? "var(--color-green)" : "var(--color-seal-soft)" }}>
                      {row.verified ? "已核实" : "未核实"}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button className="m-row-act" onClick={() => startEdit(row)}>改</button>
                      <button className="m-row-act ml-3" data-quiet="true"
                        onClick={async () => { await dropRank(row.id); list.reload(); sum.reload(); }}>删</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
