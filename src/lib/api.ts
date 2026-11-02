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
  const r = await fetch(`/api/state?year=${year}&person=${person}`);
  if (!r.ok) throw new Error("state fetch failed");
  return r.json();
}

export async function fetchMeta() {
  const r = await fetch("/api/meta");
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
  const r = await fetch(`/api/communities?${q}`);
  return r.json() as Promise<{ total: number; rows: Community[] }>;
}

/* ---------------- 选房 ---------------- */

export type Transit = {
  wp: number; label: string;
  min: number | null; max: number | null;
  distance_m: number | null;
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
  const r = await fetch(`/api/house/rows?${q}`);
  return r.json() as Promise<{ total: number; rows: HouseRow[]; workplaces: Workplace[] }>;
}

export async function fetchWorkplaces(): Promise<Workplace[]> {
  const r = await fetch("/api/workplace");
  return r.json();
}

export async function addWorkplace(body: { person_id: number; label: string; address: string }) {
  const r = await fetch("/api/workplace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<{ ok: boolean; id?: number; error?: string; formatted?: string }>;
}

export async function removeWorkplace(id: number) {
  await fetch(`/api/workplace/${id}`, { method: "DELETE" });
}

export async function precomputeTransit(wpId: number, district?: string) {
  const r = await fetch("/api/transit/precompute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wpId, district }),
  });
  return r.json() as Promise<{ ok: boolean; centers?: number; hit?: number; miss?: number; fail?: number; error?: string }>;
}

export async function fetchImpact(communityId: number, year: number) {
  const r = await fetch(`/api/house/impact?community_id=${communityId}&year=${year}`);
  return r.json() as Promise<Impact>;
}

export async function fetchNearbySchools(communityId: number) {
  const r = await fetch(`/api/house/schools/${communityId}`);
  return r.json() as Promise<{ rows: NearSchool[] }>;
}

export async function exactTransit(communityId: number, wpId: number) {
  const r = await fetch("/api/house/exact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ community_id: communityId, wpId }),
  });
  return r.json() as Promise<{ ok: boolean; min?: number; max?: number; distance_m?: number; error?: string }>;
}
