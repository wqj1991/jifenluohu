export type Me = { authenticated: boolean; username: string | null; setup: boolean };

export type AuthResult = { ok: boolean; error?: string; setup?: boolean; username?: string };

async function call(path: string, body?: unknown): Promise<AuthResult> {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d: any = {};
  try { d = await r.json(); } catch { d = {}; }
  if (!r.ok) return { ok: false, error: d?.error || `HTTP ${r.status}`, setup: d?.setup };
  return { ok: true, ...d };
}

export async function whoami(): Promise<Me> {
  const r = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as Me;
}

export const login = (username: string, password: string) =>
  call("/api/auth/login", { username, password });

export const setupAccount = (username: string, password: string, confirm: string) =>
  call("/api/auth/setup", { username, password, confirm });

export const logout = () => call("/api/auth/logout", {});

export const changePassword = (current: string, next: string, confirm: string) =>
  call("/api/auth/password", { current, next, confirm });
