import { useState } from "react";
import {
  fetchWorkplaceMaint, saveWorkplace, dropWorkplace, runTransit, getJSON, useApi,
  type WorkplaceRow,
} from "../../lib/maint";
import { PageHead, Facts, Band, Field, Skeleton, Notice, Empty, dash } from "./Ui";

type Person = { id: number; name: string };

export default function WorkplaceMaint() {
  const list = useApi(fetchWorkplaceMaint, []);
  const persons = useApi(() => getJSON<Person[]>("/api/persons"), []);

  const [personId, setPersonId] = useState(1);
  const [label, setLabel] = useState("公司");
  const [address, setAddress] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<number | null>(null);

  const rows = list.data?.rows || [];
  const biz = list.data?.biz || [];
  const bizTotal = biz.reduce((s, b) => s + b.n, 0);
  const nameOf = (id: number) => persons.data?.find((p) => p.id === id)?.name || `#${id}`;

  const add = async () => {
    if (!address.trim()) return;
    setBusy(true);
    setMsg("");
    const r = await saveWorkplace({ person_id: personId, label: label || "公司", address: address.trim() });
    setBusy(false);
    if (r.ok) {
      setMsg(r.formatted ? `已定位到：${r.formatted}` : "已建档");
      setAddress("");
      list.reload();
    } else setMsg(r.error || "建档失败，地址可能没解析出来");
  };

  const transit = async (row: WorkplaceRow) => {
    setRunning(row.id);
    setMsg("");
    const r = await runTransit(row.id);
    setRunning(null);
    if (r.ok) {
      setMsg(`商圈预算完成：${r.centers ?? 0} 个质心，命中 ${r.hit ?? 0}，新增 ${r.miss ?? 0}，失败 ${r.fail ?? 0}`);
      list.reload();
    } else setMsg(r.error || "通勤预算失败");
  };

  return (
    <>
      <PageHead
        title="公司地点与线路"
        note={
          <>
            公司地址只用来算通勤，不进分数。提交时走一次高德地址解析，回写标准地址和经纬度；
            解析不出来说明地址太含糊，补到门牌或写字楼名再试。商圈质心可以批量预算，单个小区要精确值就回选房页点测算。
          </>
        }
      >
        <button className="m-btn m-btn-quiet" onClick={() => { list.reload(); persons.reload(); }}>重读台账</button>
      </PageHead>

      <Facts items={[
        { k: "公司地点", v: rows.length || dash(null) },
        { k: "涉及申报人", v: new Set(rows.map((r) => r.person_id)).size || dash(null), tone: "mute" },
        { k: "商圈质心", v: bizTotal ? bizTotal.toLocaleString() : dash(null), tone: "mute" },
        { k: "已缓存线路", v: list.data ? list.data.transit.cached.toLocaleString() : dash(null) },
        { k: "缓存时点", v: list.data?.transit.last || dash(null), tone: "mute" },
      ]} />

      <Band onReset={() => { setAddress(""); setMsg(""); }}>
        <Field label="申报人" w="8rem">
          <select className="m-input" value={personId} onChange={(e) => setPersonId(Number(e.target.value))}>
            {(persons.data || [{ id: 1, name: "我" }]).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="标签" w="7rem" hint="公司 / 常去的点">
          <input className="m-input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="地址" w="24rem">
          <input className="m-input" placeholder="北京市朝阳区望京 SOHO T1"
            value={address} onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()} />
        </Field>
        <button className="m-btn" onClick={add} disabled={busy || !address.trim()}>
          {busy ? "解析中" : "定位并建档"}
        </button>
        {msg ? <span className="sans text-[11px] max-w-[26rem] leading-[1.6]" style={{ color: "var(--color-mute)" }}>{msg}</span> : null}
      </Band>

      <div className="px-8 md:px-16 pb-14">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 py-3 sans text-[11px]"
          style={{ borderBottom: "1px solid var(--color-rule)", color: "var(--color-mute)" }}>
          {biz.map((b) => (
            <span key={b.district}>{b.district} <span className="num" style={{ color: "var(--color-ink-2)" }}>{b.n}</span></span>
          ))}
          <span className="ml-auto">商圈质心是高德检索出来的中心点，不是行政边界</span>
        </div>

        <div className="py-3">
          {list.error ? (
            <Notice>接口未响应：{list.error}</Notice>
          ) : list.busy && !rows.length ? (
            <Skeleton />
          ) : !rows.length ? (
            <Empty
              lead="还没有任何公司地点。"
              why="通勤分两个口径：商圈质心是预算值，用来快速筛掉一大片；小区坐标才是精确值，只在你要认真比的那几个上算。先把公司地址加上，选房页才有得比。"
            />
          ) : (
            <table className="m-table">
              <thead>
                <tr>
                  <th>申报人</th>
                  <th>标签</th>
                  <th>标准地址</th>
                  <th className="text-right">经度</th>
                  <th className="text-right">纬度</th>
                  <th className="text-right">建档</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="m-row">
                    <td style={{ color: "var(--color-ink)" }}>{nameOf(r.person_id)}</td>
                    <td className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>{dash(r.label)}</td>
                    <td className="max-w-[26rem] truncate" title={r.address || ""}>{dash(r.address)}</td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>{r.lng == null ? "—" : r.lng.toFixed(5)}</td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>{r.lat == null ? "—" : r.lat.toFixed(5)}</td>
                    <td className="num text-right" style={{ color: "var(--color-mute)" }}>{dash(r.created_at)}</td>
                    <td className="text-right whitespace-nowrap">
                      <button className="m-row-act" onClick={() => transit(r)} disabled={running === r.id}>
                        {running === r.id ? "测算中…" : "重测通勤"}
                      </button>
                      <button className="m-row-act ml-3" data-quiet="true"
                        onClick={async () => { await dropWorkplace(r.id); list.reload(); }}>删</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="sans text-[11px] leading-[1.9] max-w-[70ch]" style={{ color: "var(--color-mute)" }}>
          「重测通勤」按早高峰公交 + 步行重算这家公司到所有商圈质心的耗时，已有缓存会覆盖。全量重算要打高德接口，
          两百多个质心大概一两分钟，别连续点。地址解析和线路都要求 <span className="num">AMAP_KEY</span> 有效，报「失败」先看这个。
        </p>
      </div>
    </>
  );
}
