import { useEffect } from "react";
import { CLAUSES } from "../lib/clauses";
import type { Item } from "../lib/api";

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export default function Detail({ item, onClose }: { item: Item | null; onClose: () => void }) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [item, onClose]);

  if (!item) return null;
  const steps = item.steps || [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-start justify-center overflow-y-auto md:px-4 md:py-[6vh]"
      style={{ background: "rgba(27,27,26,.34)" }}
      onClick={onClose}
    >
      <div
        className="detail-doc relative w-full md:w-[min(840px,96vw)]"
        style={{
          background: "var(--color-paper)",
          boxShadow: "0 24px 60px -18px rgba(27,27,26,.4)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 红头 */}
        <div className="px-5 md:px-9 pt-7">
          <div className="flex items-start justify-between gap-6">
            <div>
              <div className="sans text-[11px] tracking-[.26em]" style={{ color: "var(--color-seal)" }}>
                第{item.no}项 · 计算过程
              </div>
              <h2 className="text-[21px] md:text-[27px] font-semibold tracking-[.06em] mt-2 leading-snug">
                {item.title}
              </h2>
            </div>
            <div className="text-right shrink-0">
              <div className="num leading-none text-[34px] md:text-[46px]" style={{ letterSpacing: "-.03em" }}>
                {fmt(item.score)}
              </div>
              <div className="sans text-[10.5px] tracking-[.2em] mt-1" style={{ color: "var(--color-mute)" }}>
                得分
              </div>
            </div>
          </div>
          <div className="rule-red mt-4" />
          <div className="rule-red-thin mt-1" />
        </div>

        {/* 明细 */}
        <div className="px-5 md:px-9 pt-5 pb-2">
          <div className="sans text-[11px] tracking-[.22em] mb-2" style={{ color: "var(--color-mute)" }}>
            逐条演算
          </div>
          {steps.length === 0 ? (
            <div className="text-[13px] py-3" style={{ color: "var(--color-mute)" }}>
              这一项没有可分解的中间过程。
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {steps.map((s, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-2 dotted" style={{ width: "52%" }}>
                      <div style={{ color: "var(--color-ink)" }}>{s.t}</div>
                      {s.n ? (
                        <div className="sans text-[11px] leading-[1.6] mt-0.5" style={{ color: "var(--color-mute)" }}>
                          {s.n}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 dotted text-right num whitespace-nowrap pl-4" style={{ color: "var(--color-ink)" }}>
                      {s.v}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 公式 */}
        {item.formula ? (
          <div className="px-5 md:px-9 pb-1">
            <div
              className="px-4 py-3 mt-2 num text-[14.5px]"
              style={{ background: "var(--color-paper-2)", border: "1px solid var(--color-rule)" }}
            >
              <span className="sans text-[10.5px] tracking-[.2em] mr-3" style={{ color: "var(--color-mute)" }}>
                结式
              </span>
              {item.formula}
            </div>
          </div>
        ) : null}

        {/* 条文原文 */}
        <div className="px-5 md:px-9 pt-5 pb-1">
          <div className="sans text-[11px] tracking-[.22em] mb-2" style={{ color: "var(--color-mute)" }}>
            条文原文
          </div>
          <p
            className="text-[12.5px] leading-[1.95] pl-4"
            style={{ color: "var(--color-ink-2)", borderLeft: "2px solid var(--color-seal-soft)" }}
          >
            {CLAUSES[item.key] || "—"}
          </p>
        </div>

        {/* 注 */}
        <div className="px-5 md:px-9 pt-4 pb-8">
          <div className="sans text-[11.5px] leading-[1.8]" style={{ color: "var(--color-mute)" }}>
            {item.unit ? <div><span className="num">{item.unit}</span></div> : null}
            {item.note ? <div>{item.note}</div> : null}
            <div className="mt-1">依据 京政办发〔2020〕9 号 · 京人社开发发〔2020〕8 号</div>
          </div>
        </div>

        <button onClick={onClose} className="detail-x" aria-label="关闭">
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span>关闭</span>
        </button>
      </div>
    </div>
  );
}
