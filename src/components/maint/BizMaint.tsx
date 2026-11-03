import { useMemo, useState } from "react";
import {
  fetchBizCircles, saveBizCircle, mergeBizCircle, dropBizCircle, useApi,
  type BizRow,
} from "../../lib/maint";
import { PageHead, Facts, Band, Field, Seg, Skeleton, Notice, Empty, dash } from "./Ui";

/* 单价在库里是元/㎡（地图图例除以一万显示），台账里统一写万/㎡ */
const wan = (n: number | null) => (n == null ? "—" : (n / 10000).toFixed(2));
const keyOf = (r: { district: string; name: string }) => `${r.district}|${r.name}`;

const blank = { id: 0, district: "通州", name: "", alias: "", bucket: 0, active: 1, note: "" };

const flags = [
  { v: "", l: "全部" },
  { v: "bucket", l: "兜底桶" },
  { v: "noloc", l: "无坐标" },
  { v: "unpriced", l: "无挂牌价" },
  { v: "off", l: "已停用" },
  { v: "empty", l: "空商圈" },
];

export default function BizMaint({ go }: { go: (v: string) => void }) {
  const [district, setDistrict] = useState("");
  const [flag, setFlag] = useState("");
  const [q, setQ] = useState("");

  const list = useApi(() => fetchBizCircles({ district, q, flag }), [district, q, flag]);
  // 并入的目标要从全量里选，不能被当前筛选挡住
  const all = useApi(() => fetchBizCircles({}), []);

  const [form, setForm] = useState({ ...blank });
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [merge, setMerge] = useState<{ row: BizRow; to: string } | null>(null);

  const st = all.data?.stats;
  const rows = list.data?.rows || [];
  const districts = all.data?.byDistrict || [];

  const reload = () => { list.reload(); all.reload(); };

  const startNew = () => {
    setForm({ ...blank, district: district || "通州" });
    setMsg("");
    setOpen(true);
    setMerge(null);
  };

  const startEdit = (row: BizRow) => {
    setForm({
      id: row.id, district: row.district, name: row.name, alias: row.alias || "",
      bucket: row.bucket, active: row.active, note: row.note || "",
    });
    setMsg("");
    setOpen(true);
    setMerge(null);
  };

  const submit = async () => {
    setSaving(true);
    const res = await saveBizCircle({
      id: form.id || undefined,
      district: form.district,
      name: form.name,
      alias: form.alias,
      bucket: form.bucket,
      active: form.active,
      note: form.note,
    });
    setSaving(false);
    if (res.ok) {
      setOpen(false);
      reload();
      setMsg(res.moved ? `已改名，${res.moved} 个小区一起搬过去了` : "");
    } else setMsg(res.error || "写入失败");
  };

  const startMerge = (row: BizRow) => {
    const first = (all.data?.rows || []).find((r) => keyOf(r) !== keyOf(row) && r.district === row.district);
    setMerge({ row, to: first ? keyOf(first) : "" });
    setMsg("");
    setOpen(false);
  };

  const doMerge = async () => {
    if (!merge?.to) return;
    setSaving(true);
    const res = await mergeBizCircle({ from: [keyOf(merge.row)], to: merge.to });
    setSaving(false);
    if (res.ok) {
      setMsg(`「${merge.row.name}」已并入，${res.moved ?? 0} 个小区换了商圈`);
      setMerge(null);
      reload();
    } else setMsg(res.error || "并入失败");
  };

  const remove = async (row: BizRow) => {
    const res = await dropBizCircle(row.id);
    setMsg(res.ok ? `「${row.name}」已从名录里删掉` : res.error || "删除失败");
    if (res.ok) reload();
  };

  /* 地图只看商圈：写进 URL 再切视图，刷新/分享都还在这个模式 */
  const openMap = () => {
    if (typeof location !== "undefined") {
      const sp = new URLSearchParams(location.search);
      sp.delete("view");
      sp.set("mode", "map");
      sp.set("bizonly", "1");
      history.replaceState(null, "", `${location.pathname}?${sp.toString()}`);
    }
    go("house");
  };

  const mergeOptions = useMemo(
    () =>
      (all.data?.rows || [])
        .filter((r) => !merge || keyOf(r) !== keyOf(merge.row))
        .map((r) => ({ k: keyOf(r), label: `${r.district} · ${r.name}（${r.communities} 个小区）` })),
    [all.data, merge]
  );

  return (
    <>
      <PageHead
        title="商圈"
        note={
          <>
            地图上的商圈面不是官方边界：它由小区的<b>最近质心</b>推出来，颜色是该商圈的中位单价。
            名录决定三件事——<b>别名</b>把站点写成两种名字的同一片区并成一块（如「瀛海」与「瀛海镇」）、
            <b>兜底桶</b>（「大兴周边」这类）只描边不上色、<b>停用</b>的商圈连同它的小区都不上地图。
            改名字会把这个商圈下的小区一起改过来，不会剩下对不上的旧名。
          </>
        }
      >
        <button className="m-btn m-btn-quiet" onClick={openMap}>地图只看商圈 →</button>
        <button className="m-btn" onClick={startNew}>+ 登记商圈</button>
      </PageHead>

      <Facts
        items={[
          { k: "商圈", v: st ? st.n : dash(null) },
          {
            k: "地图可见",
            v: st ? `${st.mapped}/${st.n}` : dash(null),
            tone: st && st.mapped < st.n ? "seal" : "mute",
          },
          { k: "覆盖小区", v: st ? st.comms.toLocaleString() : dash(null), tone: "mute" },
          { k: "有挂牌价", v: st ? st.priced.toLocaleString() : dash(null), tone: "mute" },
          {
            k: "有价覆盖率",
            v: st && st.comms ? `${((st.priced / st.comms) * 100).toFixed(1)}%` : dash(null),
          },
          { k: "兜底桶", v: st ? st.buckets : dash(null), tone: st?.buckets ? "seal" : "mute" },
          { k: "已停用", v: st ? st.disabled : dash(null), tone: st?.disabled ? "seal" : "mute" },
        ]}
      />

      {open ? (
        <Band onReset={() => setOpen(false)}>
          <Field label="区" w="5.5rem">
            <select
              className="m-input"
              value={form.district}
              onChange={(e) => setForm({ ...form, district: e.target.value })}
            >
              {(districts.length ? districts.map((d) => d.district) : ["通州", "大兴"]).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="商圈名" w="11rem" hint={form.id ? "改名会把名下小区一起搬过去" : "站点上的原始写法"}>
            <input
              className="m-input"
              placeholder="黄村"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="别名" w="15rem" hint="同一片区的其它写法，逗号或空格分隔">
            <input
              className="m-input"
              placeholder="九棵树(家乐福), 九棵树地铁"
              value={form.alias}
              onChange={(e) => setForm({ ...form, alias: e.target.value })}
            />
          </Field>
          <Field label="备注" w="14rem">
            <input
              className="m-input"
              placeholder="口径说明，例如「含亦庄经开区部分小区」"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 sans text-[11.5px] pb-1.5" style={{ color: "var(--color-ink-2)" }}>
            <input
              type="checkbox"
              checked={!!form.bucket}
              onChange={(e) => setForm({ ...form, bucket: e.target.checked ? 1 : 0 })}
              style={{ width: 14, height: 14, accentColor: "var(--color-seal)" }}
            />
            兜底桶（只描边、不参与着色）
          </label>
          <label className="flex items-center gap-2 sans text-[11.5px] pb-1.5" style={{ color: "var(--color-ink-2)" }}>
            <input
              type="checkbox"
              checked={!form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked ? 0 : 1 })}
              style={{ width: 14, height: 14, accentColor: "var(--color-seal)" }}
            />
            停用（不上地图）
          </label>
          <button className="m-btn" onClick={submit} disabled={saving || !form.name.trim()}>
            {saving ? "写入中" : form.id ? "保存修改" : "写入名录"}
          </button>
          {msg ? <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{msg}</span> : null}
        </Band>
      ) : null}

      {merge ? (
        <Band onReset={() => setMerge(null)}>
          <div className="sans text-[11.5px] pb-2" style={{ color: "var(--color-ink-2)" }}>
            把「{merge.row.district} · {merge.row.name}」名下 {merge.row.communities} 个小区并到：
          </div>
          <Field label="目标商圈" w="20rem" hint="源商圈会从名录里删掉，小区改成目标的归属">
            <select
              className="m-input"
              value={merge.to}
              onChange={(e) => setMerge({ ...merge, to: e.target.value })}
            >
              {mergeOptions.map((o) => (
                <option key={o.k} value={o.k}>{o.label}</option>
              ))}
            </select>
          </Field>
          <button className="m-btn" onClick={doMerge} disabled={saving || !merge.to}>
            {saving ? "并入中" : "执行并入"}
          </button>
          {msg ? <span className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{msg}</span> : null}
        </Band>
      ) : null}

      <div className="px-8 md:px-16">
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3"
          style={{ borderTop: "1px solid var(--color-rule-2)", borderBottom: "1px solid var(--color-rule)" }}
        >
          <Seg
            value={district}
            options={[{ v: "", l: "全部区" }, ...districts.map((d) => ({ v: d.district, l: d.district }))]}
            onChange={setDistrict}
          />
          <Seg value={flag} options={flags} onChange={setFlag} />
          <label className="ml-auto flex items-center gap-2 sans text-[11.5px]" style={{ color: "var(--color-mute)" }}>
            商圈 / 别名
            <input
              className="bg-transparent outline-none text-[11.5px] w-32"
              style={{ color: "var(--color-ink)", borderBottom: "1px solid var(--color-rule-2)", padding: "2px 2px" }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 py-2.5 sans text-[11px]" style={{ color: "var(--color-mute)" }}>
          {districts.map((b) => (
            <span key={b.district}>
              {b.district} <span className="num" style={{ color: "var(--color-ink-2)" }}>{b.n}</span>
              <span className="num ml-1" style={{ color: "var(--color-seal-soft)" }}>{b.communities}</span>
            </span>
          ))}
          <span className="ml-auto num">命中 {rows.length.toLocaleString()} 个商圈</span>
        </div>

        <div className="py-2">
          {flag === "noloc" ? (
            <Notice>
              这些商圈名下的小区都没有坐标，所以图上不画他们的面——地图只看商圈时默认看不到。要让它们出现，得先给下面这些小区补经纬度。
            </Notice>
          ) : null}
          {list.error ? (
            <Notice>接口未响应：{list.error}</Notice>
          ) : list.busy && !rows.length ? (
            <Skeleton />
          ) : !rows.length ? (
            <Empty
              lead="这个筛选下没有商圈。"
              why="商圈名是从小区挂牌数据里带出来的，名录会自动登记；空的时候通常是筛选条件太窄，或者还没导入小区。"
              action={<button className="m-btn" onClick={() => { setDistrict(""); setFlag(""); setQ(""); }}>清掉筛选</button>}
            />
          ) : (
            <table className="m-table">
              <thead>
                <tr>
                  <th>商圈</th>
                  <th>区</th>
                  <th>别名</th>
                  <th className="text-right">小区</th>
                  <th className="text-right">有价</th>
                  <th className="text-right">中位单价</th>
                  <th className="text-right">P25–P75</th>
                  <th>状态</th>
                  <th>备注</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="m-row" style={{ opacity: row.active ? 1 : 0.55 }}>
                    <td style={{ color: "var(--color-ink)" }}>{row.name}</td>
                    <td className="sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>{row.district}</td>
                    <td className="sans text-[10.5px] max-w-[12rem] truncate" style={{ color: "var(--color-ink-2)" }} title={row.alias || ""}>
                      {dash(row.alias)}
                    </td>
                    <td className="num text-right">{row.communities.toLocaleString()}</td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>{row.priced.toLocaleString()}</td>
                    <td className="num text-right" style={{ color: "var(--color-ink-2)" }}>{wan(row.median)}</td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>
                      {row.p25 == null ? dash(null) : `${wan(row.p25)}–${wan(row.p75)}`}
                    </td>
                    <td className="sans text-[10px]" style={{ color: row.bucket ? "var(--color-seal-soft)" : "var(--color-mute)" }}>
                      {!row.active ? "停用" : row.bucket ? "兜底桶" : "正常"}
                    </td>
                    <td className="sans text-[10.5px] max-w-[12rem] truncate" style={{ color: "var(--color-mute)" }} title={row.note || ""}>
                      {dash(row.note)}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button className="m-row-act" onClick={() => startEdit(row)}>改</button>
                      <button className="m-row-act ml-3" onClick={() => startMerge(row)}>并入</button>
                      <button className="m-row-act ml-3" data-quiet="true" onClick={() => remove(row)}>删</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="sans text-[11px] leading-[1.9] pb-10 max-w-[68ch]" style={{ color: "var(--color-mute)" }}>
          两个区一共六十多个商圈，逐条看比改代码的 ALIAS 表快。改完保存，地图会在下一次请求时重新算一遍面
          （服务端缓存 5 分钟，名录一改就失效）。停用一个商圈只是不画，小区本身和房价都还在「小区维护」里。
        </p>
      </div>
    </>
  );
}
