// 维护台账的接口客户端：一类数据一个 fetch，写法跟 lib/api.ts 保持一致。
import { useEffect, useState } from "react";

async function read<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

const qs = (p: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") u.set(k, String(v));
  return u.toString();
};

export const getJSON = <T,>(path: string) => fetch(path).then((r) => read<T>(r));

export const postJSON = <T,>(path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => read<T>(r));

export const delJSON = <T,>(path: string) =>
  fetch(path, { method: "DELETE" }).then((r) => read<T>(r));

/* ---------------- 类型 ---------------- */

export type PriceSource = {
  community_id: number; source: string; label?: string; price: number;
  online: number | null; ym: string | null; url: string | null;
  source_id: string | null; note: string | null; fetched_at: string | null;
};

export type PriceSourceStat = {
  source: string; label: string; communities: number; comms: number;
  low: number; high: number; last: string | null;
};

export type Summary = {
  community: {
    n: number; withPrice: number; coverage: number; lastFetched: string | null;
    missing: number; points: number; sources: number; withMulti: number;
  };
  priceSources: PriceSourceStat[];
  school: { primary: number; middle: number; total: number };
  rank: { n: number; verified: number; years: [number, number] | null };
  zone: { n: number; verified: number; communities: number };
  workplace: { n: number };
  transit: { cached: number; last: string | null };
  route: RouteStats;
  policy: { n: number; latest: number | null };
};

export type PolicyRow = {
  year: number; cutoff: number; quota: number | null;
  apply_start: string | null; apply_end: string | null; deadline: string | null;
};

export type PriceRow = {
  id: number; name: string; district: string; bizcircle: string | null;
  price: number | null; price_low: number | null; price_high: number | null;
  price_src_n: number | null;
  source: string | null; fetched_at: string | null;
  points: number; last_ym: string | null;
  sources: PriceSource[];
};

export type PriceResp = {
  total: number; rows: PriceRow[];
  byDistrict: { district: string; n: number; withPrice: number }[];
  sources: PriceSourceStat[];
};

export type RankRow = {
  id: number; school_id: number | null; school_name: string; stage: string;
  region: string | null;
  year: number; metric: string; tier: string | null;
  rank: number | null; score: number | null;
  source: string | null; source_url: string | null; verified: number;
  note: string | null; updated_at: string | null;
};

export type ZoneRow = {
  id: number; community_id: number; community_name: string; district: string;
  bizcircle: string | null; stage: string; school_id: number | null;
  school_name: string; scope: string; group_name: string | null;
  authority: string | null; doc_ref: string | null; effective_from: string | null;
  verified: number; note: string | null; updated_at: string | null;
};

export type SchoolHit = { id: number; name: string; stage: string; addr: string | null };
export type CommHit = { id: number; name: string; district: string; bizcircle: string | null; price: number | null };

export type WorkplaceRow = {
  id: number; person_id: number; label: string | null; address: string | null;
  lng: number | null; lat: number | null; created_at: string | null;
};

export type RouteStats = {
  n: number; manual: number; amap: number; verified: number;
  communities: number; wps: number; avgMin: number | null;
  last: string | null; stale: number;
};

// 小区 → 工作地点一行的实测记录（手填或高德）
export type RouteRec = {
  id: number; community_id: number; wp_id: number; mode: string;
  minutes_min: number | null; minutes_max: number | null;
  distance_m: number | null; walk_m: number | null; transfers: number | null;
  line_text: string | null; depart_at: string | null; source: string;
  fetched_at: string | null; verified: number; note: string | null;
  updated_at: string | null;
};

export type RouteRow = {
  id: number; name: string; district: string; bizcircle: string | null;
  price: number | null;
  rec: RouteRec | null;
  est: { min: number; max: number; distance_m: number | null; fetched_at: string | null } | null;
  source: "amap" | "manual" | "estimate" | null;
  min: number | null; max: number | null; distance_m: number | null;
  fetched_at: string | null; stale: boolean;
};

export type RouteResp = {
  wps: WorkplaceRow[]; wp: WorkplaceRow | null;
  departDefault: string; staleDays: number;
  total: number; rows: RouteRow[]; stats: RouteStats;
  byDistrict: { district: string; n: number; recorded: number }[];
  coverage: { communities: number; recorded: number };
};

/* ---------------- 端点 ---------------- */

export const fetchSummary = () => getJSON<Summary>("/api/maint/summary");
export const fetchPolicy = () => getJSON<PolicyRow[]>("/api/maint/policy");
export const savePolicy = (b: Partial<PolicyRow>) => postJSON<{ ok: boolean; error?: string }>("/api/maint/policy", b);
export const dropPolicy = (y: number) => delJSON<{ ok: boolean }>(`/api/maint/policy/${y}`);

export const fetchPrices = (p: { district?: string; q?: string; only?: string; source?: string; offset?: number; limit?: number }) =>
  getJSON<PriceResp>(`/api/maint/price?${qs({ ...p })}`);
export const savePrice = (b: { community_id: number; price: number; ym?: string; note?: string; source?: string; online?: number | null; url?: string }) =>
  postJSON<{ ok: boolean; error?: string; ym?: string; source?: string; price_src_n?: number }>("/api/maint/price", b);
export const dropPriceSource = (communityId: number, source: string) =>
  delJSON<{ ok: boolean; removed?: number }>(`/api/maint/price?${qs({ community_id: communityId, source })}`);
export const fetchPriceSources = () => getJSON<{ rows: PriceSourceStat[] }>("/api/maint/price-sources");

export const fetchRanks = (p: { stage?: string; region?: string; year?: string; q?: string; verified?: string; tier?: string }) =>
  getJSON<{
    total: number; rows: RankRow[]; years: number[];
    byTier: { t: string; c: number }[]; byRegion: { r: string; c: number }[];
  }>(
    `/api/maint/rank?${qs({ ...p })}`
  );
export const saveRank = (b: Partial<RankRow>) =>
  postJSON<{ ok: boolean; error?: string; id?: number; merged?: boolean }>("/api/maint/rank", b);
export const dropRank = (id: number) => delJSON<{ ok: boolean }>(`/api/maint/rank/${id}`);

export const fetchZones = (p: { district?: string; stage?: string; q?: string; verified?: string }) =>
  getJSON<{ total: number; rows: ZoneRow[]; byDistrict: { district: string; n: number }[] }>(
    `/api/maint/zone?${qs({ ...p })}`
  );
export const saveZone = (b: Partial<ZoneRow>) =>
  postJSON<{ ok: boolean; error?: string; id?: number }>("/api/maint/zone", b);
export const dropZone = (id: number) => delJSON<{ ok: boolean }>(`/api/maint/zone/${id}`);

export const searchSchools = (q: string, stage?: string) =>
  getJSON<{ total: number; rows: SchoolHit[] }>(`/api/maint/school?${qs({ q, stage, limit: 8 })}`);
export const searchCommunities = (q: string, district?: string) =>
  getJSON<{ total: number; rows: CommHit[] }>(`/api/maint/community?${qs({ q, district, limit: 8 })}`);

export const fetchWorkplaceMaint = () =>
  getJSON<{ rows: WorkplaceRow[]; biz: { district: string; n: number }[]; transit: { cached: number; last: string | null } }>(
    "/api/maint/workplace"
  );
export const saveWorkplace = (b: { person_id: number; label: string; address: string }) =>
  postJSON<{ ok: boolean; id?: number; error?: string; formatted?: string }>("/api/workplace", b);
export const dropWorkplace = (id: number) => delJSON<{ ok: boolean }>(`/api/workplace/${id}`);
export const runTransit = (wpId: number) =>
  postJSON<{ ok: boolean; centers?: number; hit?: number; miss?: number; fail?: number; error?: string }>(
    "/api/transit/precompute",
    { wpId }
  );

/* ---------------- 路线与时间 ---------------- */

export const fetchRoutes = (p: {
  wpId?: number; district?: string; q?: string; only?: string; sort?: string;
  offset?: number; limit?: number;
}) => getJSON<RouteResp>(`/api/maint/route?${qs({ ...p })}`);

export const saveRoute = (b: {
  community_id: number; wp_id: number; minutes_min: number; minutes_max?: number;
  mode?: string; distance_m?: number | null; walk_m?: number | null;
  transfers?: number | null; line_text?: string; depart_at?: string;
  verified?: boolean; note?: string;
}) => postJSON<{ ok: boolean; error?: string; row?: RouteRec }>("/api/maint/route", b);

export const dropRoute = (id: number) =>
  delJSON<{ ok: boolean; error?: string }>(`/api/maint/route/${id}`);

// 传 communityId 是测一条，只传 wpId 是按条件批量补测
export const measureRoutes = (b: {
  wp_id: number; community_id?: number; district?: string; limit?: number; only?: string;
}) =>
  postJSON<{
    ok: boolean; error?: string; row?: RouteRec;
    requested?: number; hit?: number; fail?: number; sample?: string[];
    remaining?: number; seconds?: number;
  }>("/api/maint/route/measure", b);

/* ---------------- 极小的数据钩子 ---------------- */

export function useApi<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    fn()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(String(e?.message || e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, busy, reload: () => setTick((n) => n + 1) };
}
