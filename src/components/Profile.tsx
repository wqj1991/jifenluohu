import { useEffect, useState } from "react";

type Emp = { start_ym: string; end_ym?: string | null; pay_district: string; is_municipal: number; backfill_months: number };
type Res = { kind: string; district: string; start_ym: string; end_ym?: string | null; registered: number };
type Edu = { level: string; has_degree: number; obtain_ym: string; study_months: number };

type Profile = {
  id: number; name: string; birth_ym: string;
  employment: Emp[]; residence: Res[]; education: Edu[]; tax: { year: number; amount: number }[];
};

const DISTRICTS = ["东城", "西城", "朝阳", "海淀", "丰台", "石景山", "通州", "大兴", "昌平", "顺义", "房山", "门头沟", "平谷", "怀柔", "密云", "延庆"];
const LEVELS = ["专科", "本科", "硕士", "博士"];
const KINDS = [
  { v: "own", t: "自有住所（1 分/年）" },
  { v: "rent", t: "租赁住所（0.5 分/年）" },
  { v: "dorm", t: "单位宿舍（0.5 分/年）" },
];

const blank: Profile = {
  id: 1, name: "我", birth_ym: "1988-06",
  employment: [{ start_ym: "2012-07", pay_district: "朝阳", is_municipal: 0, backfill_months: 0 }],
  residence: [{ kind: "rent", district: "朝阳", start_ym: "2012-07", registered: 1 }],
  education: [{ level: "本科", has_degree: 1, obtain_ym: "2012-06", study_months: 0 }],
  tax: [],
};

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline py-2" style={{ borderBottom: "1px dotted var(--color-rule-2)" }}>
      <div className="sans text-[12px] w-[76px] shrink-0" style={{ color: "var(--color-mute)" }}>{label}</div>
      <div className="flex-1 text-[14px] min-w-0">{children}</div>
      {hint ? <div className="sans text-[10.5px] ml-2 shrink-0 max-w-[104px] text-right leading-[1.3]" style={{ color: "var(--color-mute)" }}>{hint}</div> : null}
    </div>
  );
}

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-6 first:mt-5">
      <div className="flex items-baseline justify-between mb-1">
        <div className="sans text-[10.5px] tracking-[.24em]" style={{ color: "var(--color-seal)" }}>{title}</div>
        {extra}
      </div>
      {children}
    </div>
  );
}

export function ProfileForm({ onSaved, onDone }: { onSaved: () => void; onDone?: () => void }) {
  const [p, setP] = useState<Profile>(blank);
  const [saving, setSaving] = useState(false);
  const [flashed, setFlashed] = useState(false);
  useEffect(() => {
    fetch("/api/profile").then((r) => r.json()).then((d) => {
      if (d && d.id) setP({ ...blank, ...d, residence: d.residence?.length ? d.residence : blank.residence });
    });
  }, []);

  const emp = p.employment[0] || blank.employment[0];
  const edu = p.education[0] || blank.education[0];
  const setEmp = (k: string, v: any) => setP({ ...p, employment: [{ ...emp, [k]: v }] });
  const setEdu = (k: string, v: any) => setP({ ...p, education: [{ ...edu, [k]: v }] });

  const setRes = (i: number, k: string, v: any) => {
    const list = p.residence.map((r, j) => (j === i ? { ...r, [k]: v } : r));
    setP({ ...p, residence: list });
  };
  const addRes = () => {
    const last = p.residence[p.residence.length - 1];
    setP({ ...p, residence: [...p.residence, { kind: "own", district: "通州", start_ym: last?.end_ym || "", registered: 0 }] });
  };
  const delRes = (i: number) => setP({ ...p, residence: p.residence.filter((_, j) => j !== i) });

  const save = async () => {
    setSaving(true);
    const clean = { ...p, residence: p.residence.map((r) => ({ ...r, end_ym: r.end_ym || null })) };
    await fetch("/api/profile", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(clean),
    });
    setSaving(false);
    onSaved();
    setFlashed(true);
    onDone?.();
  };

  return (
    <div>
      <Section title="申报人">
          <Row label="姓名">
            <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} className="w-full" />
          </Row>
          <Row label="出生年月" hint="算年龄分">
            <input value={p.birth_ym} onChange={(e) => setP({ ...p, birth_ym: e.target.value })} className="num w-full" placeholder="1988-06" />
          </Row>
        </Section>

        <Section title="合法稳定就业">
          <Row label="起缴年月" hint="1998-07 前按 07 算">
            <input value={emp.start_ym} onChange={(e) => setEmp("start_ym", e.target.value)} className="num w-full" placeholder="2012-07" />
          </Row>
          <Row label="缴费区" hint="市本级按城六区算">
            <select value={emp.pay_district} onChange={(e) => setEmp("pay_district", e.target.value)} className="w-full">
              {[...DISTRICTS, "市本级"].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Row>
          <Row label="补缴月数" hint="不计分">
            <input type="number" value={emp.backfill_months} onChange={(e) => setEmp("backfill_months", Number(e.target.value))} className="num w-full" />
          </Row>
        </Section>

        <Section
          title={`合法稳定住所 · ${p.residence.length} 段`}
          extra={<button className="sans text-[11px]" style={{ color: "var(--color-seal)" }} onClick={addRes}>+ 添加一段</button>}
        >
          {p.residence.map((r, i) => (
            <div key={i} className="mb-3 pl-3" style={{ borderLeft: "2px solid var(--color-rule)" }}>
              <div className="flex items-baseline justify-between">
                <div className="sans text-[10.5px] tracking-[.18em]" style={{ color: "var(--color-mute)" }}>
                  第 {i + 1} 段
                </div>
                {p.residence.length > 1 && (
                  <button className="sans text-[10.5px]" style={{ color: "var(--color-seal-soft)" }} onClick={() => delRes(i)}>
                    删除
                  </button>
                )}
              </div>
              <Row label="类型">
                <select value={r.kind} onChange={(e) => setRes(i, "kind", e.target.value)} className="w-full">
                  {KINDS.map((k) => <option key={k.v} value={k.v}>{k.t}</option>)}
                </select>
              </Row>
              <Row label="所在区" hint={r.kind === "own" && !["东城", "西城", "朝阳", "海淀", "丰台", "石景山"].includes(r.district) ? "城六区外自有 → 职住 +2/年" : undefined}>
                <select value={r.district} onChange={(e) => setRes(i, "district", e.target.value)} className="w-full">
                  {DISTRICTS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </Row>
              <Row label="登记备案" hint={r.kind === "own" ? "需不动产权证" : "2020-08 起需备案"}>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!r.registered}
                    onChange={(e) => setRes(i, "registered", e.target.checked ? 1 : 0)}
                    style={{ width: 14, height: 14, accentColor: "var(--color-seal)" }}
                  />
                  <span style={{ color: r.registered ? "var(--color-green)" : "var(--color-seal)" }}>
                    {r.registered
                      ? "已登记 · 计分"
                      : r.kind === "own"
                        ? "无产权证 · 不计分"
                        : "未备案 · 2020-08 起不计分"}
                  </span>
                </label>
              </Row>
              <Row label="起始年月">
                <input value={r.start_ym} onChange={(e) => setRes(i, "start_ym", e.target.value)} className="num w-full" placeholder="2012-07" />
              </Row>
              <Row label="结束年月" hint="至今就留空">
                <input value={r.end_ym || ""} onChange={(e) => setRes(i, "end_ym", e.target.value)} className="num w-full" placeholder="至今" />
              </Row>
            </div>
          ))}
        </Section>

        <Section title="教育背景">
          <Row label="最高学历">
            <select value={edu.level} onChange={(e) => setEdu("level", e.target.value)} className="w-full">
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </Row>
          <Row label="取得年月">
            <input value={edu.obtain_ym} onChange={(e) => setEdu("obtain_ym", e.target.value)} className="num w-full" placeholder="2012-06" />
          </Row>
          <Row label="在职就读" hint="学制内扣社保/住所分">
            <select value={edu.study_months} onChange={(e) => setEdu("study_months", Number(e.target.value))} className="w-full">
              <option value={0}>否（脱产，不扣减）</option>
              <option value={24}>是 · 2 年制</option>
              <option value={30}>是 · 2.5 年制</option>
              <option value={36}>是 · 3 年制</option>
              <option value={48}>是 · 4 年制</option>
            </select>
          </Row>
        </Section>

        <button
          onClick={save}
          disabled={saving}
          className="mt-8 w-full py-3 sans text-[13px] tracking-[.2em]"
          style={{ background: "var(--color-seal)", color: "#fbfaf6" }}
        >
          {saving ? "保存中…" : "保存并重算"}
        </button>
        <div className="sans text-[11px] mt-3 leading-[1.8]" style={{ color: "var(--color-mute)" }}>
          {flashed ? "已写入本机并重算，条文页右侧的结算栏会跟着变。" : "分段按起止年月计月数，重叠部分按先出现的段算。数据只存本机 sqlite。"}
        </div>
    </div>
  );
}

/* 抽屉形态：条文页的「改我的档案」从右侧滑出，复用同一份表单。 */
export default function Profile({ open, onClose, onSaved }: {
  open: boolean; onClose: () => void; onSaved: () => void;
}) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" style={{ background: "rgba(27,27,26,.28)" }} onClick={onClose} />
      <aside
        className="fixed right-0 top-0 bottom-0 z-50 w-[min(540px,95vw)] overflow-y-auto px-9 py-8"
        style={{ background: "var(--color-paper)", borderLeft: "1px solid var(--color-rule)", boxShadow: "-20px 0 60px rgba(0,0,0,.08)" }}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-[22px] tracking-[.08em] font-semibold">我的档案</h2>
          <button className="sans text-[12px]" style={{ color: "var(--color-mute)" }} onClick={onClose}>关闭</button>
        </div>
        <div className="rule-red-thin mt-3" />
        <ProfileForm onSaved={onSaved} onDone={onClose} />
      </aside>
    </>
  );
}
