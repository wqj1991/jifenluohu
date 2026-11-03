// 小区维护 = 一册两页：房价、到公司的路线与时间。
// 两页都以小区为行，名字能对上，改完价不用换菜单就能看它离公司多远。
import { useState } from "react";
import PriceMaint from "./PriceMaint";
import RouteMaint from "./RouteMaint";
import { PageHead } from "./Ui";
import { fetchSummary, useApi } from "../../lib/maint";

export type CommTab = "price" | "route";

const NOTE: Record<CommTab, React.ReactNode> = {
  price: (
    <>
      单价来自各站<b>挂牌均价</b>，不是成交价；同一小区多源时不取平均，主口径用<b>中位数</b>，另给最低—最高区间。
      每一行带抓取时点，超过 30 天标为待刷新。
    </>
  ),
  route: (
    <>
      一个小区对一个公司一行：最快耗时、区间、出发到到达。高德算的是<b>同一时刻的公交 + 步行</b>；
      你亲自跑过的就手填进去标「已核实」，批量重测只覆盖时间和线路，不动备注。
    </>
  ),
};

export default function CommunityMaint({ initial = "price" }: { initial?: CommTab }) {
  const [tab, setTab] = useState<CommTab>(initial);
  const [tick, setTick] = useState(0);
  const sum = useApi(fetchSummary, []);

  const c = sum.data?.community;
  const rt = sum.data?.route;

  const tabs: { k: CommTab; no: string; l: string; n: string }[] = [
    { k: "price", no: "一", l: "挂牌房价", n: c ? `${c.withPrice} / ${c.n}` : "—" },
    { k: "route", no: "二", l: "路线与时间", n: rt ? `${rt.n} 条` : "—" },
  ];

  return (
    <>
      <PageHead
        title="小区维护"
        note={
          <>
            {NOTE[tab]}
            <span className="block mt-1" style={{ color: "var(--color-mute)" }}>
              在册小区 <span className="num">{c ? c.n.toLocaleString() : "—"}</span> 个；
              两页共用同一份小区名单，编号、区、商圈都一致。
            </span>
          </>
        }
      >
        <button className="m-btn m-btn-quiet" onClick={() => { setTick((n) => n + 1); sum.reload(); }}>
          重读台账
        </button>
      </PageHead>

      <div className="px-8 md:px-16 pt-4">
        <div className="flex items-end gap-9">
          {tabs.map((t) => {
            const on = tab === t.k;
            return (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
                className="pb-2 flex items-baseline gap-2"
                style={{
                  borderBottom: `2px solid ${on ? "var(--color-seal)" : "transparent"}`,
                  color: on ? "var(--color-ink)" : "var(--color-mute)",
                }}
              >
                <span className="num text-[10.5px]" style={{ color: on ? "var(--color-seal)" : "var(--color-mute)" }}>
                  {t.no}
                </span>
                <span className="text-[14px] tracking-[.04em]">{t.l}</span>
                <span className="num text-[10.5px]" style={{ color: "var(--color-mute)" }}>{t.n}</span>
              </button>
            );
          })}
        </div>
        <div className="rule-red-thin mt-0" />
      </div>

      <div key={`${tab}-${tick}`}>
        {tab === "price" ? <PriceMaint bare /> : <RouteMaint bare />}
      </div>
    </>
  );
}
