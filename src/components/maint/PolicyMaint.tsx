import { useMemo, useState } from "react";
import { fetchPolicy, savePolicy, dropPolicy, useApi, type PolicyRow } from "../../lib/maint";
import { PageHead, Facts, Band, Field, Skeleton, Notice, dash } from "./Ui";

const empty = { year: "", cutoff: "", quota: "", apply_start: "", apply_end: "", deadline: "" };

export default function PolicyMaint() {
  const { data, error, busy, reload } = useApi<PolicyRow[]>(fetchPolicy, []);
  const [form, setForm] = useState({ ...empty });
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const rows = data || [];
  const stat = useMemo(() => {
    if (!rows.length) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const span = Math.max(1, last.year - first.year);
    return {
      rise: last.cutoff - first.cutoff,
      perYear: (last.cutoff - first.cutoff) / span,
    };
  }, [rows]);

  const startEdit = (r?: PolicyRow) => {
    setForm(r
      ? {
          year: String(r.year), cutoff: String(r.cutoff), quota: r.quota == null ? "" : String(r.quota),
          apply_start: r.apply_start || "", apply_end: r.apply_end || "", deadline: r.deadline || "",
        }
      : { ...empty });
    setMsg("");
    setOpen(true);
  };

  const submit = async () => {
    setSaving(true);
    const r = await savePolicy({
      year: Number(form.year),
      cutoff: Number(form.cutoff),
      quota: form.quota ? Number(form.quota) : null,
      apply_start: form.apply_start,
      apply_end: form.apply_end,
      deadline: form.deadline,
    });
    setSaving(false);
    if (r.ok) { setMsg("已写入"); setOpen(false); reload(); }
    else setMsg(r.error || "写入失败");
  };

  return (
    <>
      <PageHead
        title="分数线与年度参数"
        note={
          <>
            申报年度从这里取值：先取最新入档年度，再按年均涨幅推到申报年。官方公布后改这一处，结算、缺口、推算全站跟着变。
            分数线按「当年实际落户最低分」录入，规模按「年度落户人数」录入。
          </>
        }
      >
        <button className="m-btn" onClick={() => startEdit()}>+ 录一个年度</button>
      </PageHead>

      <Facts items={[
        { k: "入档年度", v: rows.length || dash(null) },
        { k: "最新年度", v: rows.length ? rows[rows.length - 1].year : dash(null) },
        { k: "最新分数线", v: rows.length ? rows[rows.length - 1].cutoff.toFixed(2) : dash(null), tone: "seal" },
        { k: "区间累计", v: stat ? `+${stat.rise.toFixed(2)}` : dash(null) },
        { k: "年均涨幅", v: stat ? `+${stat.perYear.toFixed(2)}` : dash(null) },
      ]} />

      {open ? (
        <Band onReset={() => setOpen(false)}>
          <Field label="年度" w="5.5rem">
            <input className="m-input num" inputMode="numeric" placeholder="2027"
              value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} />
          </Field>
          <Field label="落户分数线" w="7rem">
            <input className="m-input num" inputMode="decimal" placeholder="119.92"
              value={form.cutoff} onChange={(e) => setForm({ ...form, cutoff: e.target.value })} />
          </Field>
          <Field label="年度规模 人" w="7rem">
            <input className="m-input num" inputMode="numeric" placeholder="6000"
              value={form.quota} onChange={(e) => setForm({ ...form, quota: e.target.value })} />
          </Field>
          <Field label="申报开始" w="8rem">
            <input className="m-input num" placeholder="2027-04-15"
              value={form.apply_start} onChange={(e) => setForm({ ...form, apply_start: e.target.value })} />
          </Field>
          <Field label="申报结束" w="8rem">
            <input className="m-input num" placeholder="2027-05-15"
              value={form.apply_end} onChange={(e) => setForm({ ...form, apply_end: e.target.value })} />
          </Field>
          <Field label="材料截止" w="8rem">
            <input className="m-input num" placeholder="2027-05-31"
              value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
          </Field>
          <button className="m-btn" onClick={submit} disabled={saving || !form.year || !form.cutoff}>
            {saving ? "写入中" : "写入台账"}
          </button>
          {msg ? <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{msg}</span> : null}
        </Band>
      ) : null}

      <div className="px-8 md:px-16 py-5">
        {error ? (
          <Notice>接口未响应：{error}。确认 <span className="num">pnpm dev:api</span> 在跑。</Notice>
        ) : busy && !rows.length ? (
          <Skeleton />
        ) : (
          <table className="m-table">
            <thead>
              <tr>
                <th>年度</th>
                <th className="text-right">分数线</th>
                <th className="text-right">较上年</th>
                <th className="text-right">规模</th>
                <th>申报窗口</th>
                <th>材料截止</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const prev = rows[i - 1];
                const d = prev ? r.cutoff - prev.cutoff : null;
                return (
                  <tr key={r.year} className="m-row">
                    <td className="num">{r.year}</td>
                    <td className="num text-right">{r.cutoff.toFixed(2)}</td>
                    <td className="num text-right" style={{ color: d == null ? "var(--color-mute)" : "var(--color-ink-2)" }}>
                      {d == null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(2)}`}
                    </td>
                    <td className="num text-right" style={{ color: "var(--color-ink-2)" }}>{dash(r.quota)}</td>
                    <td className="num" style={{ color: "var(--color-ink-2)" }}>
                      {r.apply_start || r.apply_end ? `${r.apply_start || "?"} → ${r.apply_end || "?"}` : dash(null)}
                    </td>
                    <td className="num" style={{ color: "var(--color-ink-2)" }}>{dash(r.deadline)}</td>
                    <td className="text-right whitespace-nowrap">
                      <button className="m-row-act" onClick={() => startEdit(r)}>改</button>
                      <button className="m-row-act ml-3" data-quiet="true"
                        onClick={async () => { await dropPolicy(r.year); reload(); }}>删</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="sans text-[10.5px] leading-[1.9] mt-6 max-w-[70ch]" style={{ color: "var(--color-mute)" }}>
          历年分数线是唯一的硬事实，其余预测都由它推。删掉最新年度会让申报年回退，先确认再删。
        </div>
      </div>
    </>
  );
}
