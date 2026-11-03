import { useEffect, useState } from "react";
import { fetchImpact, fetchNearbySchools, exactTransit,
  type HouseRow, type Impact, type NearSchool,
} from "../lib/api";

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const wan = (n: number | null) => (n == null ? "—" : (n / 10000).toFixed(2));
const isMid = (st: string) => st === "中学" || st === "zx";

/* 通勤分档：≤60 绿 / 60–90 墨 / >90 朱红 */
function tone(m: number | null) {
  if (m == null) return "var(--color-mute)";
  if (m <= 60) return "var(--color-green)";
  if (m <= 90) return "var(--color-ink-2)";
  return "var(--color-seal)";
}

/**
 * 小区详情。aside = 列表模式右侧常驻栏；drawer = 抽屉里铺满一屏。
 * 列表与 AI 选房共用同一份内容，口径不两套。
 */
export default function HouseDetail({ row, year, onClose, variant = "aside" }: {
  row: HouseRow;
  year: number;
  onClose: () => void;
  variant?: "aside" | "drawer";
}) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [schools, setSchools] = useState<NearSchool[]>([]);
  const [busy, setBusy] = useState(false);
  const [t, setT] = useState<any[]>(row.transit || []);

  useEffect(() => {
    setImpact(null); setSchools([]); setT(row.transit || []);
    fetchImpact(row.id, year).then(setImpact).catch(() => {});
    fetchNearbySchools(row.id).then((r) => setSchools(r.rows)).catch(() => {});
  }, [row.id, year]);

  const doExact = async (wpId: number) => {
    setBusy(true);
    const r = await exactTransit(row.id, wpId);
    if (r.ok) {
      setT((prev) => prev.map((x) => (x.wp === wpId ? { ...x, min: r.min, max: r.max, missing: false, stale: false } : x)));
    }
    setBusy(false);
  };

  return (
    <aside
      className={
        (variant === "drawer"
          ? "h-full overflow-y-auto "
          : "house-detail sticky top-0 self-start h-screen overflow-y-auto ")
        + "px-5 py-5 md:px-7 md:py-6"
      }
      style={{ background: "var(--color-paper-2)" }}
    >
      <div className="flex items-start justify-between">
        <div className="sans text-[10.5px] tracking-[.28em]" style={{ color: "var(--color-mute)" }}>
          {row.district} · {row.bizcircle}
        </div>
        <button onClick={onClose} className="sans text-[10.5px]" style={{ color: "var(--color-mute)" }}>关闭</button>
      </div>

      <h2 className="text-[21px] md:text-[26px] leading-tight mt-2 font-semibold tracking-[.02em]">{row.name}</h2>
      <div className="sans text-[11px] mt-1" style={{ color: "var(--color-mute)" }}>{row.address || "地址未收录"}</div>

      <div className="flex items-baseline gap-2 mt-4">
        <span className="num leading-none text-[34px] md:text-[46px]" style={{ letterSpacing: "-.02em" }}>
          {row.price ? (row.price / 10000).toFixed(2) : "—"}
        </span>
        <span className="sans text-[12px]" style={{ color: "var(--color-seal)" }}>万/㎡</span>
        {row.build_year ? (
          <span className="sans text-[11px] ml-auto" style={{ color: "var(--color-mute)" }}>{row.build_year} 年建</span>
        ) : null}
      </div>

      {row.price_low != null && row.price_high != null ? (
        <div className="sans text-[10.5px] mt-1.5 leading-[1.7]" style={{ color: "var(--color-mute)" }}>
          {(row.price_src_n ?? 1) > 1 ? (
            <>
              {row.price_src_n} 个来源 · 区间{" "}
              <span className="num" style={{ color: "var(--color-ink-2)" }}>{wan(row.price_low)}</span>
              <span className="num">–{wan(row.price_high)}</span>
              {" "}万/㎡，主值取中位
            </>
          ) : (
            <>单一来源挂牌均价，非成交价</>
          )}
        </div>
      ) : null}

      {(row.sources?.length ?? 0) > 0 ? (
        <div className="mt-4">
          <div className="sans text-[10px] tracking-[.24em] mb-1" style={{ color: "var(--color-mute)" }}>
            各源报价 · 万/㎡
          </div>
          <table className="w-full text-[11.5px]">
            <tbody>
              {row.sources!.map((s) => (
                <tr key={s.source}>
                  <td className="py-1 dotted" style={{ color: "var(--color-ink-2)" }}>
                    {s.label || s.source}
                    {s.ym ? <span className="sans text-[9.5px] ml-1" style={{ color: "var(--color-mute)" }}>{s.ym}</span> : null}
                  </td>
                  <td className="py-1 dotted text-right num" style={{ color: "var(--color-ink)" }}>{wan(s.price)}</td>
                  <td className="py-1 dotted text-right w-14 sans text-[9.5px]" style={{ color: "var(--color-mute)" }}>
                    {s.online === 1 ? "在售" : s.online === 0 ? "下架" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sans text-[9.5px] mt-1 leading-[1.7]" style={{ color: "var(--color-seal-soft)" }}>
            各站口径不同（挂牌均价 / 参考均价），所以不合并成一个数。
          </div>
        </div>
      ) : null}

      <table className="w-full mt-5 text-[12px]">
        <tbody>
          {[
            ["真实成交均价", row.price_tx ? `${wan(row.price_tx)} 万/㎡` : "无成交样本"],
            ["成交样本", row.tx_n ? `${row.tx_n} 套` : "—"],
            ["议价空间", row.bargain != null ? `${(row.bargain * 100).toFixed(1)}%` : "—"],
            ["平均去化", row.cycle_days != null ? `${Math.round(row.cycle_days)} 天` : "—"],
            ["建筑类型", row.build_type || "—"],
            ["物业类型", row.property_type || "—"],
          ].map(([k, v]) => (
            <tr key={k as string}>
              <td className="py-1.5 dotted" style={{ color: "var(--color-mute)" }}>{k}</td>
              <td className="py-1.5 dotted text-right num" style={{ color: "var(--color-ink)" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <div className="sans text-[10.5px] tracking-[.24em] mb-2" style={{ color: "var(--color-mute)" }}>
          买这里 · 职住区域拉动
        </div>
        {impact ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="num text-[13px]" style={{ color: "var(--color-mute)" }}>{fmt(impact.zhizhu.before)}</span>
              <span style={{ color: "var(--color-mute)" }}>→</span>
              <span className="num text-[30px] leading-none" style={{ color: "var(--color-seal)" }}>{fmt(impact.zhizhu.after)}</span>
              <span className="sans text-[11px]" style={{ color: "var(--color-seal)" }}>分</span>
              {impact.zhizhu.after >= impact.zhizhu.cap ? (
                <span className="sans text-[10px] border px-1 ml-1" style={{ borderColor: "var(--color-green)", color: "var(--color-green)" }}>已触顶</span>
              ) : null}
            </div>
            <div className="sans text-[11px] mt-2 leading-[1.9]" style={{ color: "var(--color-mute)" }}>
              按 {impact.buyYm} 入手、计分截至 {impact.baseEnd} 测算<br />
              总分 <span className="num" style={{ color: "var(--color-ink)" }}>{fmt(impact.baseTotal)}</span>
              <span style={{ color: "var(--color-mute)" }}> → </span>
              <span className="num" style={{ color: "var(--color-green)" }}>{fmt(impact.afterTotal)}</span>
              <span style={{ color: "var(--color-green)" }}> +{fmt(impact.delta)}</span>
            </div>
          </>
        ) : <div className="sans text-[11px]" style={{ color: "var(--color-mute)" }}>测算中…</div>}
      </div>

      <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <div className="sans text-[10.5px] tracking-[.24em] mb-2" style={{ color: "var(--color-mute)" }}>
          通勤 · 到各公司
        </div>
        <table className="w-full text-[12px]">
          <tbody>
            {t.map((x) => (
              <tr key={x.wp}>
                <td className="py-1.5 dotted" style={{ color: "var(--color-ink-2)" }}>{x.label}</td>
                <td className="py-1.5 dotted text-right num" style={{ color: tone(x.min) }}>
                  {x.missing ? "未测" : `${x.min}–${x.max} 分`}
                </td>
                <td className="py-1.5 dotted text-right w-8">
                  <button
                    onClick={() => doExact(x.wp)}
                    disabled={busy}
                    className="sans text-[9.5px]"
                    style={{ color: "var(--color-seal-soft)" }}
                  >{busy ? "…" : "精确"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sans text-[10px] mt-1 leading-[1.7]" style={{ color: "var(--color-mute)" }}>
          商圈质心口径，公交+步行早高峰。点「精确」按小区坐标重算。
        </div>
      </div>

      <div className="mt-5 pt-4" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <div className="sans text-[10.5px] tracking-[.24em] mb-2" style={{ color: "var(--color-mute)" }}>
          最近的学校 · 直线距离
        </div>
        <div className="text-[11.5px] leading-[2]">
          {schools.map((s) => (
            <div key={s.id} className="flex justify-between gap-2">
              <span style={{ color: "var(--color-ink-2)" }}>
                <span className="sans text-[9.5px] mr-1" style={{ color: isMid(s.stage) ? "var(--color-seal)" : "var(--color-mute)" }}>
                  {isMid(s.stage) ? "中" : "小"}
                </span>
                {s.name}
              </span>
              <span className="num shrink-0" style={{ color: "var(--color-mute)" }}>{s.km} km</span>
            </div>
          ))}
          {!schools.length && <span style={{ color: "var(--color-mute)" }}>加载中…</span>}
        </div>
        <div className="sans text-[10px] mt-2 leading-[1.7]" style={{ color: "var(--color-seal-soft)" }}>
          ⚠ 距离近不等于对口。通州 2023-05-01 后取得的房产一律多校划片；经开区约 60 km² 归经开区社会事业局。买前须按官方划片文件核实。
        </div>
      </div>
    </aside>
  );
}
