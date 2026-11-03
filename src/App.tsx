import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CLAUSES, ACTION } from "./lib/clauses";
import { fetchState, type StateResp, type Item } from "./lib/api";
import { logout, whoami } from "./lib/auth";
import { AUTH_LOST } from "./lib/http";
import Login from "./components/Login";
import Profile from "./components/Profile";
import Detail from "./components/Detail";
import HouseHunt from "./components/HouseHunt";
import ProfileMaint from "./components/maint/ProfileMaint";
import WorkplaceMaint from "./components/maint/WorkplaceMaint";
import RankMaint from "./components/maint/RankMaint";
import CommunityMaint, { type CommTab } from "./components/maint/CommunityMaint";
import BizMaint from "./components/maint/BizMaint";
import ZoneMaint from "./components/maint/ZoneMaint";
import PolicyMaint from "./components/maint/PolicyMaint";

const fmt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

type View = "clauses" | "house" | "profile" | "workplace" | "rank" | "kg" | "comm" | "biz" | "zone" | "policy";

const VIEWS: View[] = ["clauses", "house", "profile", "workplace", "rank", "kg", "comm", "biz", "zone", "policy"];
/* 卷内目录：顺序即序号，序号印在右侧（页号位） */
type Entry = { k: View; l: string; d: string; grp: "core" | "person" | "data" };
const INDEX: Entry[] = [
  { k: "clauses", l: "条文与结算", d: "9 项积分逐条核算", grp: "core" },
  { k: "house", l: "选房", d: "通州 · 大兴 房源与通勤", grp: "core" },
  { k: "profile", l: "积分档案维护", d: "就业 / 住所 / 教育 / 纳税 / 荣誉", grp: "person" },
  { k: "workplace", l: "公司地点线路维护", d: "公司地址与商圈通勤预算", grp: "person" },
  { k: "rank", l: "学校排名维护", d: "学校排名与中考成绩", grp: "data" },
  { k: "kg", l: "幼儿园名录", d: "亦庄 · 大兴幼儿园分档、收费与电话", grp: "data" },
  { k: "comm", l: "小区维护", d: "挂牌房价 · 到公司的路线与时间", grp: "data" },
  { k: "biz", l: "商圈维护", d: "商圈名录、别名与地图着色", grp: "data" },
  { k: "zone", l: "小区学区维护", d: "小区划片与对口学校", grp: "data" },
  { k: "policy", l: "政策参数维护", d: "分数线、规模与计分参数", grp: "data" },
];
const NO = new Map(INDEX.map((e, i) => [e.k, String(i + 1).padStart(2, "0")]));

/* ---------- 卷内目录列表：桌面卷脊与手持抽屉共用同一份 ---------- */
function IndexList({ view, pick }: { view: View; pick: (v: View) => void }) {
  const navRef = useRef<HTMLElement | null>(null);
  const [mark, setMark] = useState({ y: 0, h: 0 });
  const [live, setLive] = useState(false);

  const syncMark = useCallback(() => {
    const el = navRef.current?.querySelector<HTMLElement>('.idx-row[data-on="true"]');
    setMark(el ? { y: el.offsetTop + 6, h: Math.max(0, el.offsetHeight - 12) } : { y: 0, h: 0 });
  }, []);

  useLayoutEffect(() => { syncMark(); }, [view, syncMark]);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncMark());
    ro.observe(nav);
    return () => ro.disconnect();
  }, [syncMark]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setLive(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const row = (e: Entry, extra = "") => (
    <button
      key={e.k}
      className={`idx-row ${extra}`.trim()}
      data-on={view === e.k}
      aria-current={view === e.k ? "page" : undefined}
      title={e.d}
      onClick={() => pick(e.k)}
    >
      <span className="idx-label">{e.l}</span>
      <span className="idx-lead" aria-hidden />
      <span className="idx-no">{NO.get(e.k)}</span>
    </button>
  );

  return (
    <nav ref={navRef} className="spine-index" aria-label="卷宗目录">
      <span
        className="idx-marker"
        aria-hidden
        style={{
          transform: `translateY(${mark.y}px)`,
          height: mark.h,
          opacity: mark.h > 0 ? 1 : 0,
          transition: live ? undefined : "none",
        }}
      />

      <div className="idx-head"><span>核算</span><i /></div>
      {INDEX.filter((e) => e.grp === "core").map((e) => row(e, "idx-row-core"))}

      <div className="idx-head"><span>台账</span><i /></div>
      <div className="idx-subhead">个人信息</div>
      {INDEX.filter((e) => e.grp === "person").map((e) => row(e, "idx-row-sub"))}
      <div className="idx-subhead">参照数据</div>
      {INDEX.filter((e) => e.grp === "data").map((e) => row(e))}

      <div className="idx-end" aria-hidden />
    </nav>
  );
}

function yearRange(maxYear: number) {
  const years: number[] = [];
  for (let y = maxYear + 1; y >= 2027; y--) years.push(y);
  return years;
}

function YearPicker({ year, setYear, maxYear, wait = "申报年度" }: {
  year: number; setYear: (y: number) => void; maxYear: number; wait?: string;
}) {
  return (
    <label className="spine-year">
      <span>{wait}</span>
      <span className="spine-selectwrap">
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="spine-select num"
          aria-label="申报年度"
        >
          {yearRange(maxYear).map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </span>
    </label>
  );
}

/* ---------- 左侧卷脊：只在 ≥1024px 出现 ---------- */
function Side({ view, go, year, setYear, maxYear, onEdit, user, onLogout }: {
  view: View; go: (v: View) => void; year: number; setYear: (y: number) => void;
  maxYear: number; onEdit: () => void; user: string; onLogout: () => void;
}) {

  return (
    <aside className="spine hidden lg:flex lg:flex-col lg:w-[248px] lg:shrink-0 lg:sticky lg:top-0 lg:h-screen">
      <div className="spine-head">
        <div className="flex items-center gap-3 min-w-0">
          <span className="spine-mark" aria-hidden>京</span>
          <span className="spine-title">积分落户</span>
        </div>
        <YearPicker year={year} setYear={setYear} maxYear={maxYear} />
      </div>

      <div className="spine-rule" />
      <div className="spine-rule-thin" />

      <IndexList view={view} pick={go} />

      <div className="spine-foot">
        {view === "clauses" || view === "house" ? (
          <button className="spine-stamp" onClick={onEdit}>改我的档案</button>
        ) : null}
        <div
          className="mt-3 flex items-baseline justify-between gap-3 sans text-[10px] tracking-[.12em]"
          style={{ color: "var(--mute-d)" }}
        >
          <span className="truncate">已登录 · {user}</span>
          <button className="m-row-act shrink-0" onClick={onLogout}>退出</button>
        </div>
        <div className="spine-code">京人社开发发〔2020〕8 号</div>
      </div>
    </aside>
  );
}

/* ---------- 手持端：顶栏 / 抽屉 / 结算条 ---------- */
function MobileBar({ view, onOpenIndex }: { view: View; onOpenIndex: () => void }) {
  const cur = INDEX.find((e) => e.k === view) || INDEX[0];
  const title = view === "clauses" ? "北京市积分落户操作管理细则" : cur.l;
  return (
    <header className="mobile-bar lg:hidden">
      <span className="mb-mark" aria-hidden>京</span>
      <div className="mb-id">
        <div className="mb-title">{title}</div>
        <div className="mb-sub">京人社开发发〔2020〕8 号 · 现行有效</div>
      </div>
      <button className="mb-btn" onClick={onOpenIndex} aria-label="打开卷宗目录" aria-haspopup="dialog">
        <svg viewBox="0 0 20 20" aria-hidden>
          <path d="M2.5 5.5h15M2.5 10h10M2.5 14.5h15" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  );
}

function Drawer({ open, onClose, label, tall, children }: {
  open: boolean; onClose: () => void; label: string; tall?: boolean; children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <button className="scrim" aria-label="关闭" tabIndex={-1} onClick={onClose} />
      <div className={`drawer${tall ? " drawer-tall" : ""}`} role="dialog" aria-modal="true" aria-label={label}>
        <div className="drawer-grip" aria-hidden />
        {children}
      </div>
    </>
  );
}

function SumBar({ data, onOpen }: { data: StateResp; onOpen: () => void }) {
  const neg = data.gap > 0;
  return (
    <button className="sum-bar lg:hidden" onClick={onOpen} aria-haspopup="dialog" aria-label="查看结算明细">
      <span className="num sum-score">{fmt(data.total)}<em>分</em></span>
      <span className="sum-meta">
        <span className="sum-gap" style={{ color: neg ? "var(--color-seal)" : "var(--color-green)" }}>
          缺口 <span className="num">{fmt(data.gap)}</span>
        </span>
        <span className="sum-line">预测线 <span className="num">{fmt(data.cutoff)}</span></span>
      </span>
      <span className="sum-open">
        明细
        <svg viewBox="0 0 10 10" aria-hidden>
          <path d="M1.6 6.6 5 3.2l3.4 3.4" fill="none" stroke="currentColor"
            strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  );
}

function TopBar() {
  return (
    <header className="px-8 md:px-14 pt-7 shrink-0">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="sans text-[12px] tracking-[.18em]" style={{ color: "var(--color-seal)" }}>
            京人社开发发〔2020〕8 号 · 现行有效
          </div>
          <h1 className="text-[24px] md:text-[34px] tracking-[.1em] font-semibold mt-2.5 leading-tight">
            北京市积分落户操作管理细则
          </h1>
        </div>
        <div className="sans text-[10.5px] tracking-[.22em] text-right shrink-0 mt-2 hidden md:block" style={{ color: "var(--color-mute)" }}>
          核算台
        </div>
      </div>
      <div className="rule-red mt-4" />
      <div className="rule-red-thin mt-1" />
    </header>
  );
}

function Clause({
  item, active, onEnter, onLeave, onOpen,
}: { item: Item; active: boolean; onEnter: () => void; onLeave: () => void; onOpen: () => void }) {
  return (
    <div
      className="clause mb-6 pl-5 pr-6 py-1 cursor-pointer"
      data-active={active}
      role="button"
      tabIndex={0}
      title="点击查看详细计算过程"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
    >
      <div className="flex items-baseline gap-3">
        <span className="sans text-[12px] tracking-[.1em]" style={{ color: "var(--color-seal)" }}>
          {item.no}
        </span>
        <h3 className="text-[19px] font-semibold tracking-[.03em]">{item.title}</h3>
        <span className="num text-[15px] ml-auto" style={{ color: item.score > 0 ? "var(--color-green)" : "var(--color-mute)" }}>
          {fmt(item.score)}
        </span>
      </div>
      <p className="text-[13px] leading-[1.95] mt-1.5" style={{ color: "var(--color-ink-2)" }}>
        {CLAUSES[item.key]}
      </p>
      <div className="sans text-[11.5px] mt-2 leading-[1.7]" style={{ color: "var(--color-mute)" }}>
        <span className="num">{item.unit}</span>
        {item.note ? <span> · {item.note}</span> : null}
      </div>
      {item.optimizable === "高" && (
        <div className="sans text-[11px] mt-1.5 tracking-[.04em]" style={{ color: "var(--color-seal-soft)" }}>
          ▲ 可优化 · {ACTION[item.key]}
        </div>
      )}
    </div>
  );
}

function SheetBody({ data, activeKey, setActiveKey, onOpen, size = 78 }: {
  data: StateResp; activeKey: string | null; setActiveKey: (k: string | null) => void;
  onOpen: (k: string) => void; size?: number;
}) {
  const neg = data.gap > 0;
  return (
    <>
      <div className="sheet-kicker sans text-[11px] tracking-[.3em]" style={{ color: "var(--color-mute)" }}>
        {data.applyYear} 年度 结算预演
      </div>
      <div className="num leading-none mt-2" style={{ fontSize: size, letterSpacing: "-.03em" }}>
        {fmt(data.total)}
        <em className="not-italic text-[24px] tracking-[.06em] ml-1" style={{ color: "var(--color-seal)" }}>
          分
        </em>
      </div>
      <div className="sans text-[12.5px] mt-2" style={{ color: "var(--color-mute)" }}>
        预测分数线 <span className="num" style={{ color: "var(--color-ink-2)" }}>{fmt(data.cutoff)}</span>
        {" · "}
        <span style={{ color: neg ? "var(--color-seal)" : "var(--color-green)" }}>
          缺口 <span className="num">{fmt(data.gap)}</span>
        </span>
      </div>

      <table className="w-full mt-6 text-[13px]">
        <tbody>
          {data.items.map((it) => (
            <tr
              key={it.key}
              className="sheet-row cursor-pointer"
              data-active={activeKey === it.key}
              onMouseEnter={() => setActiveKey(it.key)}
              onMouseLeave={() => setActiveKey(null)}
              onClick={() => onOpen(it.key)}
            >
              <td className="py-2 dotted" style={{ color: it.score > 0 ? "var(--color-ink)" : "var(--color-mute)" }}>
                {it.title}
                {it.key === "education" && it.detail?.study?.length ? (
                  <span className="sans text-[10px] tracking-[.1em] border px-1 ml-1.5 align-[1px]">已扣减</span>
                ) : null}
                {it.optimizable === "高" ? (
                  <span className="sans text-[10px] tracking-[.1em] border px-1 ml-1.5 align-[1px]" style={{ borderColor: "var(--color-seal-soft)", color: "var(--color-seal-soft)" }}>可优化</span>
                ) : null}
              </td>
              <td className="py-2 dotted text-right num" style={{ color: it.score > 0 ? "var(--color-ink)" : "var(--color-mute)" }}>
                {fmt(it.score)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="sans text-[12px] leading-[1.9] mt-5" style={{ color: "var(--color-mute)" }}>
        增速：就业 <span className="num">+{fmt(data.annualGain)}</span>／年　
        分数线 <span className="num">+{fmt(data.slope)}</span>／年
        <br />
        <span style={{ color: data.driftPerYear > 0 ? "var(--color-seal)" : "var(--color-green)" }}>
          不动任何项，每年净{data.driftPerYear > 0 ? "退" : "进"} <span className="num">{fmt(Math.abs(data.driftPerYear))}</span> 分。
        </span>
      </div>

      <div className="mt-auto pt-6 sans text-[11px] leading-[1.8]" style={{ color: "var(--color-mute)" }}>
        <div className="dotted pb-2 mb-2" style={{ color: "var(--color-ink-2)" }}>
          计分截至 <span className="num">{data.endDate}</span>
        </div>
        <div>申报人 {data.person.name} · {data.person.birth_ym}</div>
      </div>
    </>
  );
}

function Sheet({ data, activeKey, setActiveKey, onOpen }: {
  data: StateResp; activeKey: string | null; setActiveKey: (k: string | null) => void;
  onOpen: (k: string) => void;
}) {
  return (
    <aside
      className="hidden lg:flex sticky top-0 self-start h-screen overflow-y-auto px-8 py-7 flex-col"
      style={{ background: "var(--color-paper-2)", borderLeft: "1px solid var(--color-rule)" }}
    >
      <SheetBody data={data} activeKey={activeKey} setActiveKey={setActiveKey} onOpen={onOpen} />
    </aside>
  );
}

function Footer() {
  return (
    <footer
      className="px-8 md:px-14 py-3 flex flex-wrap gap-x-8 gap-y-1 justify-between sans text-[11px] tracking-[.1em]"
      style={{ borderTop: "1px solid var(--color-rule)", color: "var(--color-mute)" }}
    >
      <span>北京市人力资源和社会保障局</span>
      <span>每条分值可回溯至原文 · 灰色项为未核实或不可优化</span>
      <span className="num">数据时点 2026-11-02</span>
    </footer>
  );
}

const initialView = (): View => {
  if (typeof location === "undefined") return "clauses";
  const sp = new URLSearchParams(location.search);
  const v = sp.get("view");
  // 老的 ?view=price / ?view=route 都并到「小区维护」里，存过的链接还能用
  if (v === "price" || v === "route") return "comm";
  if (v && (VIEWS as string[]).includes(v)) return v as View;
  return sp.has("house") ? "house" : "clauses";
};

const initialTab = (): CommTab => {
  if (typeof location === "undefined") return "price";
  const sp = new URLSearchParams(location.search);
  return sp.get("view") === "route" || sp.get("tab") === "route" ? "route" : "price";
};

export default function App() {
  const [auth, setAuth] = useState<{ s: "checking" | "anon" | "authed"; setup: boolean; username: string | null }>({
    s: "checking", setup: false, username: null,
  });
  const [year, setYear] = useState(2027);
  const [data, setData] = useState<StateResp | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(() => typeof location !== "undefined" && location.search.includes("edit"));
  const [view, setView] = useState<View>(initialView);
  const [commTab] = useState<CommTab>(initialTab);
  const [reload, setReload] = useState(0);
  const [idxOpen, setIdxOpen] = useState(false);
  const [sumOpen, setSumOpen] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(() =>
    typeof location !== "undefined" ? new URLSearchParams(location.search).get("detail") : null
  );

  const go = (v: string) => {
    setView(v as View);
    setDetailKey(null);
    if (typeof location === "undefined") return;
    const sp = new URLSearchParams(location.search);
    sp.delete("view");
    sp.delete("house");
    sp.delete("detail");
    if (v !== "clauses") sp.set("view", v);
    const q = sp.toString();
    history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}`);
  };

  useEffect(() => {
    let alive = true;
    whoami()
      .then((m) => {
        if (alive) setAuth({ s: m.authenticated ? "authed" : "anon", setup: m.setup, username: m.username });
      })
      .catch(() => { if (alive) setAuth({ s: "anon", setup: false, username: null }); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const lost = () => setAuth((a) => (a.s === "anon" ? a : { ...a, s: "anon" }));
    window.addEventListener(AUTH_LOST, lost);
    return () => window.removeEventListener(AUTH_LOST, lost);
  }, []);

  useEffect(() => {
    if (auth.s !== "authed") return;
    fetchState(year)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, [year, reload, auth.s]);

  const doLogout = async () => {
    await logout().catch(() => {});
    setAuth((a) => ({ ...a, s: "anon" }));
  };

  const maxYear = useMemo(
    () => (data?.history?.length ? data.history[data.history.length - 1].year : 2026),
    [data]
  );

  if (auth.s === "checking") {
    return (
      <div className="min-h-screen grid place-items-center sans text-[12px]" style={{ color: "var(--color-mute)" }}>
        校验登录态…
      </div>
    );
  }

  if (auth.s === "anon") {
    return (
      <Login
        setup={auth.setup}
        onAuthed={(m) => {
          setAuth({ s: "authed", setup: false, username: m.username });
          setReload((n) => n + 1);
        }}
      />
    );
  }

  if (err) return <div className="p-10 sans text-[13px]">接口未启动：{err}</div>;

  const maint =
    view === "profile" ? <ProfileMaint go={go} />
    : view === "workplace" ? <WorkplaceMaint />
    : view === "rank" ? <RankMaint />
    : view === "kg" ? <RankMaint initialStage="幼儿园" />
    : view === "comm" ? <CommunityMaint initial={commTab} />
    : view === "biz" ? <BizMaint go={go} />
    : view === "zone" ? <ZoneMaint />
    : view === "policy" ? <PolicyMaint />
    : null;

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      <Side
        view={view}
        go={go}
        year={year}
        setYear={setYear}
        maxYear={maxYear}
        onEdit={() => setEditOpen(true)}
        user={auth.username || "me"}
        onLogout={doLogout}
      />
      <Profile open={editOpen} onClose={() => setEditOpen(false)} onSaved={() => setReload((n) => n + 1)} />

      <div className="flex-1 min-w-0 flex flex-col">
        <MobileBar view={view} onOpenIndex={() => setIdxOpen(true)} />
        <div className="hidden lg:block">{view === "clauses" ? <TopBar /> : null}</div>

        {view === "clauses" ? (
          data ? (
            <main className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] mt-5">
              <section className="px-8 md:px-14 pb-10">
                <div className="md:columns-2 md:gap-[44px]" style={{ columnRule: "1px solid var(--color-rule)" }}>
                  {data.items.map((it) => (
                    <Clause
                      key={it.key}
                      item={it}
                      active={activeKey === it.key}
                      onEnter={() => setActiveKey(it.key)}
                      onLeave={() => setActiveKey(null)}
                      onOpen={() => setDetailKey(it.key)}
                    />
                  ))}
                </div>
              </section>
              <Sheet data={data} activeKey={activeKey} setActiveKey={setActiveKey} onOpen={(k) => setDetailKey(k)} />
            </main>
          ) : (
            <div className="p-10 sans text-[13px]" style={{ color: "var(--color-mute)" }}>结算中…</div>
          )
        ) : view === "house" ? (
          <main className="flex-1 mt-4">
            <HouseHunt year={year} go={go} />
          </main>
        ) : (
          <main className="flex-1 mt-3">{maint}</main>
        )}

        {view === "clauses" && data ? (
          <Detail item={data.items.find((i) => i.key === detailKey) || null} onClose={() => setDetailKey(null)} />
        ) : null}
        <Footer />
        {view === "clauses" && data ? <div className="sum-space lg:hidden" aria-hidden /> : null}
      </div>

      <Drawer open={idxOpen} onClose={() => setIdxOpen(false)} label="卷宗目录">
        <div className="drawer-head">
          <span className="drawer-title">卷内目录</span>
          <YearPicker year={year} setYear={setYear} maxYear={maxYear} />
        </div>
        <div className="drawer-body">
          <IndexList view={view} pick={(v) => { setIdxOpen(false); go(v); }} />
          <div className="drawer-foot">
            {view === "clauses" || view === "house" ? (
              <button
                className="spine-stamp"
                onClick={() => { setIdxOpen(false); setEditOpen(true); }}
              >改我的档案</button>
            ) : null}
            <div className="drawer-who">
              <span className="truncate">已登录 · {auth.username || "me"}</span>
              <button className="m-row-act shrink-0" onClick={doLogout}>退出</button>
            </div>
          </div>
        </div>
      </Drawer>

      {view === "clauses" && data ? (
        <>
          <SumBar data={data} onOpen={() => setSumOpen(true)} />
          <Drawer open={sumOpen} onClose={() => setSumOpen(false)} label="结算明细" tall>
            <div className="drawer-head">
              <span className="drawer-title">结算预演 · {data.applyYear} 年度</span>
              <button className="drawer-close" onClick={() => setSumOpen(false)}>收起</button>
            </div>
            <div className="drawer-body drawer-sheet">
              <SheetBody
                data={data}
                activeKey={activeKey}
                setActiveKey={setActiveKey}
                size={56}
                onOpen={(k) => { setSumOpen(false); setDetailKey(k); }}
              />
            </div>
          </Drawer>
        </>
      ) : null}
    </div>
  );
}
