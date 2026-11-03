/** 所有前端数据请求走这里：401 时广播一次「登录态丢了」，由 App 切回登录页 */
export const AUTH_LOST = "luohu:auth-lost";

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(input, { credentials: "same-origin", ...init });
  if (r.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_LOST));
  }
  return r;
}
