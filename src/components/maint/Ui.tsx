// 维护页共用的排版件：页头、台账行、表单带、选择器、空态。
import { useEffect, useRef, useState } from "react";

export function PageHead({ title, note, children }: {
  title: string; note?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="px-8 md:px-16 pt-6">
      <div className="flex items-end justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-[26px] md:text-[30px] tracking-[.05em] font-semibold leading-tight">{title}</h1>
          {note ? (
            <div className="sans text-[11.5px] leading-[1.9] mt-2 max-w-[64ch]" style={{ color: "var(--color-ink-2)" }}>
              {note}
            </div>
          ) : null}
        </div>
        {children ? <div className="flex items-center gap-2 pb-1 shrink-0">{children}</div> : null}
      </div>
      <div className="rule-red-thin mt-5" />
    </div>
  );
}

export function Facts({ items }: { items: { k: string; v: React.ReactNode; tone?: "seal" | "green" | "mute" }[] }) {
  return (
    <div className="facts px-8 md:px-16 py-3">
      {items.map((it) => (
        <div key={it.k}>
          <div className="sans text-[10px] tracking-[.2em]" style={{ color: "var(--color-mute)" }}>{it.k}</div>
          <div
            className="num text-[17px] leading-tight mt-0.5"
            style={{
              color:
                it.tone === "seal" ? "var(--color-seal)"
                : it.tone === "green" ? "var(--color-green)"
                : it.tone === "mute" ? "var(--color-mute)"
                : "var(--color-ink)",
            }}
          >{it.v}</div>
        </div>
      ))}
    </div>
  );
}

export function Band({ children, onReset }: { children: React.ReactNode; onReset?: () => void }) {
  return (
    <div
      className="px-8 md:px-16 py-4"
      style={{ background: "var(--color-paper-2)", borderTop: "1px solid var(--color-rule-2)", borderBottom: "1px solid var(--color-rule)" }}
    >
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        {children}
        {onReset ? (
          <button className="m-btn m-btn-quiet ml-auto" onClick={onReset}>收起</button>
        ) : null}
      </div>
    </div>
  );
}

export function Field({ label, children, w = "11rem", hint }: {
  label: string; children: React.ReactNode; w?: string; hint?: string;
}) {
  return (
    <label className="block" style={{ width: w }}>
      <span className="m-label">{label}</span>
      {children}
      {hint ? <span className="sans text-[10px] mt-1 block leading-[1.5]" style={{ color: "var(--color-seal-soft)" }}>{hint}</span> : null}
    </label>
  );
}

export function Seg({ value, options, onChange }: {
  value: string; options: { v: string; l: string }[]; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-baseline gap-4 sans text-[11.5px]">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className="pb-1"
          style={{
            color: value === o.v ? "var(--color-seal)" : "var(--color-mute)",
            borderBottom: `1px solid ${value === o.v ? "var(--color-seal)" : "transparent"}`,
          }}
        >{o.l}</button>
      ))}
    </div>
  );
}

export function Empty({ lead, why, action }: { lead: string; why?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="py-12 max-w-[52ch]">
      <div className="text-[15px]" style={{ color: "var(--color-ink-2)" }}>{lead}</div>
      {why ? (
        <div className="sans text-[11.5px] leading-[1.95] mt-2" style={{ color: "var(--color-mute)" }}>{why}</div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-6 py-2.5" style={{ borderBottom: "1px dotted var(--color-rule-2)" }}>
          <div className="m-skel" style={{ width: `${22 + ((i * 7) % 14)}%` }} />
          <div className="m-skel" style={{ width: "12%" }} />
          <div className="m-skel ml-auto" style={{ width: "9%" }} />
        </div>
      ))}
    </div>
  );
}

export function Notice({ children, tone = "warn" }: { children: React.ReactNode; tone?: "warn" | "quiet" }) {
  return (
    <div
      className="sans text-[11px] leading-[1.85] px-3 py-2 mt-3"
      style={{
        color: tone === "warn" ? "var(--color-seal-soft)" : "var(--color-mute)",
        background: "rgba(138,28,20,.028)",
        borderLeft: "1px solid var(--color-rule-2)",
      }}
    >{children}</div>
  );
}

/* 带搜索建议的选择器：点选写入 id 与名称，纯手输则只取名称。 */
export function Suggest<T extends { id: number; name: string }>({
  placeholder, value, onChange, fetcher, render, onPick, w = "16rem", label, hint,
}: {
  placeholder: string;
  value: string;
  onChange: (text: string) => void;
  fetcher: (q: string) => Promise<{ rows: T[] }>;
  render: (row: T) => React.ReactNode;
  onPick: (row: T) => void;
  w?: string;
  label: string;
  hint?: string;
}) {
  const [rows, setRows] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const q = value.trim();
    if (q.length < 1) { setRows([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      fetcherRef.current(q).then((r) => alive && setRows(r.rows.slice(0, 8))).catch(() => {});
    }, 180);
    return () => { alive = false; clearTimeout(t); };
  }, [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="block relative" style={{ width: w }} ref={box}>
      <span className="m-label">{label}</span>
      <input
        className="m-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
      />
      {hint ? <span className="sans text-[10px] mt-1 block" style={{ color: "var(--color-mute)" }}>{hint}</span> : null}
      {open && rows.length > 0 ? (
        <div className="menu-pop" style={{ left: 0, right: 0, minWidth: 0, maxHeight: 210, overflowY: "auto" }}>
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => { onPick(r); setOpen(false); }}
              style={{ display: "block" }}
            >{render(r)}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const dash = (v: React.ReactNode) => (v == null || v === "" ? <span style={{ color: "var(--color-mute)" }}>—</span> : v);
