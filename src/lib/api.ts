import { apiFetch } from "./http";
export type Step = { t: string; v: string; n?: string };

export type Item = {
  key: string;
  no: string;
  title: string;
  score: number;
  raw: number | string | null;
  unit: string;
  note: string;
  optimizable: string;
  detail: any;
  steps?: Step[];
  formula?: string;
};

export type StateResp = {
  person: { id: number; name: string; birth_ym: string; is_primary: number };
  applyYear: number;
  endDate: string;
  items: Item[];
  total: number;
  cutoff: number;
  gap: number;
  slope: number;
  history: { year: number; cutoff: number; quota: number }[];
  projection: { year: number; cutoff: number; slope: number }[];
  annualGain: number;
  driftPerYear: number;
};

export async function fetchState(year: number, person = 1): Promise<StateResp> {
  const r = await apiFetch(`/api/state?year=${year}&person=${person}`);
  if (!r.ok) throw new Error("state fetch failed");
  return r.json();
}

export async function fetchMeta() {
  const r = await apiFetch("/api/meta");
  return r.json();
}

export type PriceSource = {
  source: string; label?: string; price: number; online: number | null;
  ym: string | null; url: string | null; fetched_at: string | null;
};

export type Community = {
  id: number; name: string; district: string; bizcircle: string | null;
  price: number | null; price_tx: number | null; tx_n: number | null; tx_last: number | null;
  price_low: number | null; price_high: number | null; price_src_n: number | null;
  sources?: PriceSource[];
  bargain: number | null; build_year: number | null; lng: number; lat: number;
  cycle_days: number | null;
  online: number | null; address: string | null; build_type: string | null;
  property_type: string | null; tags: string | null;
};

export async function fetchCommunities(params: Record<string, string | number>) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r = await apiFetch(`/api/communities?${q}`);
  return r.json() as Promise<{ total: number; rows: Community[] }>;
}

/* ---------------- 选房 ---------------- */

export type Transit = {
  wp: number; label: string;
  min: number | null; max: number | null;
  distance_m: number | null;
  /** 该段通勤的来源：实测路线 / 商圈估算（AI 选房结果里带） */
  source?: string | null;
  stale: boolean; missing: boolean;
};

export type HouseRow = Community & { transit: Transit[] };

export type Workplace = {
  id: number; person_id: number; label: string;
  address: string; lng: number; lat: number;
};

export type NearSchool = {
  id: number; name: string; stage: string; addr: string; km: number;
};

export type Impact = {
  community: { id: number; name: string; district: string; bizcircle: string; price: number | null };
  buyYm: string;
  applyYear: number;
  baseTotal: number;
  afterTotal: number;
  delta: number;
  zhizhu: { before: number; after: number; cap: number; rawBefore: number; rawAfter: number };
  residence: { before: number; after: number };
  baseEnd: string;
};

export async function fetchHouseRows(params: Record<string, string | number>) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r = await apiFetch(`/api/house/rows?${q}`);
  return r.json() as Promise<{ total: number; rows: HouseRow[]; workplaces: Workplace[] }>;
}

export async function fetchWorkplaces(): Promise<Workplace[]> {
  const r = await apiFetch("/api/workplace");
  return r.json();
}

export async function addWorkplace(body: { person_id: number; label: string; address: string }) {
  const r = await apiFetch("/api/workplace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<{ ok: boolean; id?: number; error?: string; formatted?: string }>;
}

export async function removeWorkplace(id: number) {
  await apiFetch(`/api/workplace/${id}`, { method: "DELETE" });
}

export async function precomputeTransit(wpId: number, district?: string) {
  const r = await apiFetch("/api/transit/precompute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wpId, district }),
  });
  return r.json() as Promise<{ ok: boolean; centers?: number; hit?: number; miss?: number; fail?: number; error?: string }>;
}

export async function fetchImpact(communityId: number, year: number) {
  const r = await apiFetch(`/api/house/impact?community_id=${communityId}&year=${year}`);
  return r.json() as Promise<Impact>;
}

export async function fetchNearbySchools(communityId: number) {
  const r = await apiFetch(`/api/house/schools/${communityId}`);
  return r.json() as Promise<{ rows: NearSchool[] }>;
}

export async function exactTransit(communityId: number, wpId: number) {
  const r = await apiFetch("/api/house/exact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ community_id: communityId, wpId }),
  });
  return r.json() as Promise<{ ok: boolean; min?: number; max?: number; distance_m?: number; source?: string | null; cached?: boolean; error?: string }>;
}

/* ---------------- AI 选房 ---------------- */

/** 一条通勤要求：到某个工作地点 ≤ maxMin 分钟（多条要同时满足）。 */
export type AiCommute = { wpId: number | null; maxMin: number | null };

/** 一条学区要求：某学段的梯队档 + 半径。小学、初中可以各要一条。 */
export type AiSchoolReq = { stage: string; tier: string; maxKm: number | null };

/** 交给后端的条件。数字字段留 null 表示不限；brief 是用户那句大白话。 */
export type AiCond = {
  district?: string;
  bizcircles?: string[];
  priceMin?: number | null;
  priceMax?: number | null;
  buildYearMin?: number | null;
  commutes?: AiCommute[];
  schools?: AiSchoolReq[];
  /** 旧字段：只带一条通勤/学区时后端仍认 */
  wpId?: number | null;
  maxMin?: number | null;
  schoolStage?: string;
  schoolTier?: string;
  maxKm?: number | null;
  brief?: string;
  topN?: number;
};

export type AiSchoolHit = { stage: string; name: string; tier: string | null; km: number };

/** 候选：字段对齐 Community，另附本地打分与 AI 解读。 */
export type AiCandidate = Community & {
  transit: Transit[];
  /** 每个受约束的工作地点一条：命中分钟 vs 上限 */
  commute: { wp: number; label: string; maxMin: number | null; min: number | null; max: number | null; source: string | null }[];
  /** 每条学区要求各给一所（小学、初中可能都有） */
  schools: AiSchoolHit[];
  school: AiSchoolHit | null;
  score: number;
  scoreParts: string[];
};

export type AiPick = {
  id: number;
  rank: number;
  verdict: string;
  reason: string;
  risk: string;
};

export type AiPickResp = {
  ok: boolean;
  conditions: AiCond;
  pool: {
    scanned: number;
    matched: number;
    shortlist: number;
    droppedByCommute: number;
    droppedBySchool: number;
  };
  filters: { k: string; v: string }[];
  /** 条件里点名了但库里没有的工作地点等，直接告诉用户哪里没生效 */
  warnings: string[];
  candidates: AiCandidate[];
  workplaces: { id: number; label: string; place: string; address: string | null; maxMin: number | null }[];
  workplace: { id: number; label: string; place: string } | null;
  ai: { summary: string; picks: AiPick[]; model: string; ms: number } | null;
  aiError: string | null;
  elapsed: number;
  /** ok:false 时的原因（筛库失败等） */
  error?: string;
};

export async function aiPick(body: AiCond): Promise<AiPickResp> {
  const r = await apiFetch("/api/ai/pick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

/** 一句话 → 结构化条件（只做抽取，不查库） */
export async function aiParse(brief: string) {
  const r = await apiFetch("/api/ai/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief }),
  });
  return r.json() as Promise<{ ok: boolean; parsed?: AiCond & { note?: string }; error?: string; model?: string; ms?: number }>;
}

export async function aiConfig() {
  const r = await apiFetch("/api/ai/config");
  return r.json() as Promise<{ enabled: boolean; model: string; note: string }>;
}

/* ---------------- 商圈清单 ---------------- */

/** 全部商圈（含那 16 个小区全无坐标、算不出中心点的），列表筛选下拉用。n 是该商圈的小区数。 */
export type BizCircle = { district: string; bizcircle: string; n: number };

export async function fetchBizcircles() {
  const r = await apiFetch("/api/bizcircles");
  return r.json() as Promise<BizCircle[]>;
}

/* ---------------- 地图模式 ---------------- */

/** 商圈面与聚合价。坐标一律是 GCJ-02（后端已从 BD-09 转换），poly 是 [lng,lat] 环。 */
export type MapBiz = {
  key: string;
  district: string;
  bizcircle: string;
  n: number;            // 有坐标的小区数
  priced: number;       // 其中有挂牌价的
  median: number | null;
  p25: number | null;
  p75: number | null;
  lng: number;
  lat: number;
  bucket: boolean;      // 站点的兜底桶（「大兴周边」这类），不参与着色
  tier: number;         // 0=不适用 1..5 由低到高
  poly: [number, number][];
};

export type MapComm = {
  id: number; name: string; d: string; b: string;
  lng: number; lat: number; p: number | null; y: number | null;
};

export type MapData = {
  generatedAt: string;
  bbox: [number, number, number, number];
  cuts: number[];
  districts: Record<string, [number, number][]>;
  biz: MapBiz[];
  comms: MapComm[];
};

export async function fetchMapData(district?: string): Promise<MapData> {
  const q = district ? `?district=${encodeURIComponent(district)}` : "";
  const r = await apiFetch(`/api/map/data${q}`);
  if (!r.ok) throw new Error("map data failed");
  return r.json();
}

/* 小区悬浮卡片：价格 + 到各工作地的通勤（后端按天缓存，首次现算，可能等几秒） */
export type MapCommuteLeg = {
  wp: number;
  label: string;
  min: number | null;      // 最快方案，分钟
  max: number | null;      // 最快三个方案里的上限，分钟
  distance_m: number | null;
  line_text?: string | null;
  transfers?: number | null;
  walk_m?: number | null;
  cached?: boolean;
  error?: string;
};

export type MapCommute = {
  id: number;
  name: string;
  district: string;
  bizcircle: string;
  price: number | null;
  price_tx: number | null;
  build_year: number | null;
  online: number | null;
  note?: string;
  commutes: MapCommuteLeg[];
};

export async function fetchMapCommute(id: number): Promise<MapCommute> {
  const r = await apiFetch(`/api/map/commute/${id}`);
  if (!r.ok) throw new Error("commute failed");
  return r.json();
}
