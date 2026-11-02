import { useState } from "react";
import {
  fetchZones, saveZone, dropZone, fetchSummary, searchSchools, searchCommunities, useApi,
  type ZoneRow, type SchoolHit, type CommHit,
} from "../../lib/maint";
import { PageHead, Facts, Band, Field, Seg, Suggest, Skeleton, Notice, Empty, dash } from "./Ui";

const stages = [
  { v: "", l: "全部阶段" },
  { v: "小学", l: "小学" },
  { v: "中学", l: "中学" },
];
const scopes = ["单校对口", "多校划片", "九年一贯", "电脑派位"];

const blank = {
  id: 0, community_id: 0, community_name: "", stage: "小学",
  school_id: 0, school_name: "", scope: "单校对口", group_name: "",
  authority: "", doc_ref: "", effective_from: "", verified: 0, note: "",
};

export default function ZoneMaint() {
  const [district, setDistrict] = useState("");
  const [stage, setStage] = useState("");
  const [verified, setVerified] = useState("");
  const [q, setQ] = useState("");

  const list = useApi(() => fetchZones({ district, stage, q, verified }), [district, stage, q, verified]);
  const sum = useApi(fetchSummary, []);

  const [form, setForm] = useState({ ...blank });
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const z = sum.data?.zone;
  const rows = list.data?.rows || [];

  const startNew = () => {
    setForm({ ...blank, stage: stage || "小学", effective_from: "" });
    setMsg("");
    setOpen(true);
  };
  const startEdit = (row: ZoneRow) => {
    setForm({
      id: row.id, community_id: row.community_id, community_name: row.community_name,
      stage: row.stage, school_id: row.school_id || 0, school_name: row.school_name,
      scope: row.scope, group_name: row.group_name || "", authority: row.authority || "",
      doc_ref: row.doc_ref || "", effective_from: row.effective_from || "",
      verified: row.verified, note: row.note || "",
    });
    setMsg("");
    setOpen(true);
  };

  const submit = async () => {
    setSaving(true);
    const res = await saveZone({
      id: form.id || undefined,
      community_id: form.community_id || null,
      stage: form.stage,
      school_id: form.school_id || null,
      school_name: form.school_name,
      scope: form.scope,
      group_name: form.group_name,
      authority: form.authority,
      doc_ref: form.doc_ref,
      effective_from: form.effective_from,
      verified: form.verified,
      note: form.note,
    } as Partial<ZoneRow>);
    setSaving(false);
    if (res.ok) {
      setOpen(false);
      list.reload();
      sum.reload();
    } else setMsg(res.error || "写入失败");
  };

  return (
    <>
      <PageHead
        title="小区学区"
        note={
          <>
            一条记录 = 一个小区在一个阶段上对口或派位到一所学校。城六区外没有「小区 → 学校」的官方反查系统，
            这张表只能照着区教委发布的划片文件、派位名单逐条抄；每条都留发布机关和文号，便于回溯。
            通州 <span className="num">2023-05-01</span> 之后取得的房产按多校划片登记（台湖、马驹桥除外）。
          </>
        }
      >
        <button className="m-btn" onClick={startNew}>+ 录一条</button>
      </PageHead>

      <Facts items={[
        { k: "台账条目", v: z ? z.n : dash(null) },
        { k: "已核实", v: z ? z.verified : dash(null), tone: z?.verified ? "green" : "mute" },
        { k: "待核实", v: z ? z.n - z.verified : dash(null), tone: z && z.n - z.verified > 0 ? "seal" : "mute" },
        { k: "覆盖小区", v: z ? z.communities.toLocaleString() : dash(null), tone: "mute" },
        { k: "在册小区", v: sum.data ? sum.data.community.n.toLocaleString() : dash(null), tone: "mute" },
        { k: "覆盖率", v: z && sum.data ? `${((z.communities / sum.data.community.n) * 100).toFixed(1)}%` : dash(null) },
      ]} />

      {open ? (
        <Band onReset={() => setOpen(false)}>
          <Suggest<CommHit>
            label="小区"
            w="16rem"
            placeholder="输入小区名"
            value={form.community_name}
            onChange={(t) => setForm({ ...form, community_name: t, community_id: 0 })}
            fetcher={(kw) => searchCommunities(kw, district)}
            onPick={(hit) => setForm({ ...form, community_id: hit.id, community_name: hit.name })}
            render={(hit) => (
              <span className="truncate">
                {hit.name}
                <span className="sans text-[9.5px] ml-2" style={{ color: "var(--color-mute)" }}>{hit.district}</span>
              </span>
            )}
            hint={form.community_id ? "已绑定在册小区" : "必须选中在册小区，才能关联房价和通勤"}
          />
          <Field label="阶段" w="5.5rem">
            <select className="m-input" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
              <option value="小学">小学</option>
              <option value="中学">中学</option>
            </select>
          </Field>
          <Suggest<SchoolHit>
            label="对口学校"
            w="16rem"
            placeholder="输入校名，或直接手打"
            value={form.school_name}
            onChange={(t) => setForm({ ...form, school_name: t, school_id: 0 })}
            fetcher={(kw) => searchSchools(kw, form.stage)}
            onPick={(hit) => setForm({ ...form, school_id: hit.id, school_name: hit.name })}
            render={(hit) => (
              <span className="truncate">
                {hit.name}
                <span className="sans text-[9.5px] ml-2" style={{ color: "var(--color-mute)" }}>{hit.stage}</span>
              </span>
            )}
          />
          <Field label="入学方式" w="7rem">
            <select className="m-input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              {scopes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="划片组 / 批次" w="9rem" hint={form.scope === "多校划片" ? "多校划片必填，写组名" : "可留空"}>
            <input className="m-input" value={form.group_name}
              onChange={(e) => setForm({ ...form, group_name: e.target.value })} />
          </Field>
          <Field label="发布机关" w="9rem">
            <input className="m-input" placeholder="通州区教委"
              value={form.authority} onChange={(e) => setForm({ ...form, authority: e.target.value })} />
          </Field>
          <Field label="文号 / 文件" w="12rem">
            <input className="m-input" placeholder="通教发〔2026〕x 号"
              value={form.doc_ref} onChange={(e) => setForm({ ...form, doc_ref: e.target.value })} />
          </Field>
          <Field label="生效" w="7rem" hint="YYYY-MM">
            <input className="m-input num" placeholder="2026-05"
              value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
          </Field>
          <Field label="备注" w="12rem">
            <input className="m-input" placeholder="覆盖楼栋、学期、特殊说明"
              value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 sans text-[11.5px] pb-1.5" style={{ color: "var(--color-ink-2)" }}>
            <input type="checkbox" checked={!!form.verified}
              onChange={(e) => setForm({ ...form, verified: e.target.checked ? 1 : 0 })}
              style={{ width: 14, height: 14, accentColor: "var(--color-seal)" }} />
            已对照原件核实
          </label>
          <button className="m-btn" onClick={submit} disabled={saving || !form.community_id || !form.school_name}>
            {saving ? "写入中" : "写入台账"}
          </button>
          {msg ? <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{msg}</span> : null}
        </Band>
      ) : null}

      <div className="px-8 md:px-16">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3"
          style={{ borderTop: "1px solid var(--color-rule-2)", borderBottom: "1px solid var(--color-rule)" }}>
          <Seg value={district} options={[{ v: "", l: "全部区" }, { v: "通州", l: "通州" }, { v: "大兴", l: "大兴" }]} onChange={setDistrict} />
          <Seg value={stage} options={stages} onChange={setStage} />
          <Seg value={verified} options={[{ v: "", l: "全部" }, { v: "1", l: "已核实" }, { v: "0", l: "待核实" }]} onChange={setVerified} />
          <label className="ml-auto flex items-center gap-2 sans text-[11.5px]" style={{ color: "var(--color-mute)" }}>
            小区 / 学校
            <input className="bg-transparent outline-none text-[11.5px] w-32"
              style={{ color: "var(--color-ink)", borderBottom: "1px solid var(--color-rule-2)", padding: "2px 2px" }}
              value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 py-2.5 sans text-[11px]" style={{ color: "var(--color-mute)" }}>
          {(list.data?.byDistrict || []).map((b) => (
            <span key={b.district}>{b.district} <span className="num" style={{ color: "var(--color-ink-2)" }}>{b.n}</span></span>
          ))}
          <span className="ml-auto num">命中 {(list.data?.total || 0).toLocaleString()} 条</span>
        </div>

        <div className="py-2">
          {list.error ? (
            <Notice>接口未响应：{list.error}</Notice>
          ) : list.busy && !rows.length ? (
            <Skeleton />
          ) : !rows.length ? (
            <Empty
              lead="还没有任何一条对口记录。"
              why={
                <>
                  这不是漏抓——划片结果只存在于区教委每年发布的入学工作意见和派位名单里，没有可信任的公开接口。
                  先拿一份今年的区级文件，把小区的入读学校、入学方式和文号抄进来；房和学两条线才能对着看。
                </>
              }
              action={<button className="m-btn" onClick={startNew}>录第一条</button>}
            />
          ) : (
            <table className="m-table">
              <thead>
                <tr>
                  <th>小区</th>
                  <th>阶段</th>
                  <th>对口学校</th>
                  <th>入学方式</th>
                  <th>组 / 批次</th>
                  <th className="text-right">生效</th>
                  <th>依据</th>
                  <th>核实</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="m-row" style={{ opacity: row.verified ? 1 : .72 }}>
                    <td style={{ color: "var(--color-ink)" }}>
                      {row.community_name}
                      <span className="sans text-[10px] ml-2" style={{ color: "var(--color-mute)" }}>{row.district}</span>
                    </td>
                    <td className="sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>{row.stage}</td>
                    <td style={{ color: row.verified ? "var(--color-ink-2)" : "var(--color-ink-2)" }}>{row.school_name}</td>
                    <td className="sans text-[10.5px]" style={{ color: row.scope === "多校划片" ? "var(--color-seal-soft)" : "var(--color-ink-2)" }}>
                      {row.scope}
                    </td>
                    <td className="sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>{dash(row.group_name)}</td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>{dash(row.effective_from)}</td>
                    <td className="sans text-[10.5px] max-w-[14rem] truncate" style={{ color: "var(--color-mute)" }} title={[row.authority, row.doc_ref].filter(Boolean).join(" · ")}>
                      {dash(row.doc_ref || row.authority)}
                    </td>
                    <td className="sans text-[10px]" style={{ color: row.verified ? "var(--color-green)" : "var(--color-seal-soft)" }}>
                      {row.verified ? "已核实" : "未核实"}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button className="m-row-act" onClick={() => startEdit(row)}>改</button>
                      <button className="m-row-act ml-3" data-quiet="true"
                        onClick={async () => { await dropZone(row.id); list.reload(); sum.reload(); }}>删</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="sans text-[11px] leading-[1.9] pb-10 max-w-[68ch]" style={{ color: "var(--color-mute)" }}>
          一个小区可以有两条记录（小学一条、中学一条），同一阶段只该有一条当前生效的。经开区约 60 km² 的学校归经开区社会事业局发布，
          不在这两区的文件里，遇到了要单独写发布机关。
        </p>
      </div>
    </>
  );
}
