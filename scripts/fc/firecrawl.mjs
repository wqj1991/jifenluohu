// Firecrawl v2 客户端：keyless 或 API key
// 文档要点（2026-11 实测）：1 credit/次 scrape；json/question/highlights 各 +4；
// 代理档位 proxy: basic | enhanced | auto（stealth 已废弃，传了会被忽略）；
// location.country 决定出口地区，默认 US；maxAge 默认 2 天缓存，0 = 强制新鲜。
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.FIRECRAWL_BASE || "https://api.firecrawl.dev/v2";
export const RAW_DIR = process.env.FIRECRAWL_RAW_DIR || "D:/dsh/cache/tmp/fc";

export class FirecrawlError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "FirecrawlError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Firecrawl {
  #key;
  #timeoutMs;
  stats = { calls: 0, credits: 0, failed: 0, byEndpoint: {} };

  constructor({ apiKey = process.env.FIRECRAWL_API_KEY, timeoutMs = 180_000 } = {}) {
    this.#key = apiKey && String(apiKey).trim() ? String(apiKey).trim() : null;
    this.#timeoutMs = timeoutMs;
  }

  get mode() {
    return this.#key ? "key" : "keyless";
  }

  #note(endpoint, credits, failed = false) {
    this.stats.calls++;
    this.stats.credits += credits;
    if (failed) this.stats.failed++;
    const b = (this.stats.byEndpoint[endpoint] ||= { calls: 0, credits: 0 });
    b.calls++;
    b.credits += credits;
  }

  async #req(method, p, body, { retries = 3, timeoutMs } = {}) {
    const endpoint = `${method} ${p.split("?")[0]}`;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.#timeoutMs);
      try {
        const headers = { "Content-Type": "application/json" };
        if (this.#key) headers.Authorization = `Bearer ${this.#key}`;
        const r = await fetch(`${BASE}${p}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await r.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          throw new FirecrawlError(`非 JSON 响应 (${r.status})`, { status: r.status, body: text.slice(0, 500) });
        }

        // 429 / 5xx 退避重试；402 是余额，重试没意义
        if (r.status === 429 || r.status >= 500) {
          lastErr = new FirecrawlError(`HTTP ${r.status}`, { status: r.status, code: json.error, body: json });
          if (attempt < retries) {
            await sleep(1500 * 2 ** attempt + Math.random() * 500);
            continue;
          }
          this.#note(endpoint, 0, true);
          throw lastErr;
        }
        if (!r.ok) {
          this.#note(endpoint, 0, true);
          throw new FirecrawlError(json.error || `HTTP ${r.status}`, {
            status: r.status,
            code: json.code || json.error,
            body: json,
          });
        }
        this.#note(endpoint, json.creditsUsed ?? json.data?.metadata?.creditsUsed ?? 1);
        return json;
      } catch (e) {
        lastErr = e;
        if (e instanceof FirecrawlError && e.status && e.status !== 429 && e.status < 500) throw e;
        if (attempt >= retries) {
          this.#note(endpoint, 0, true);
          throw e;
        }
        await sleep(1500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /** POST /scrape —— 单页抓取。opts 直接透传 Firecrawl 参数。 */
  async scrape(url, opts = {}) {
    const body = {
      url,
      formats: opts.formats ?? ["markdown"],
      onlyMainContent: opts.onlyMainContent ?? true,
      timeout: opts.timeout ?? 90_000,
      ...opts,
    };
    const j = await this.#req("POST", "/scrape", body, { retries: opts.retries ?? 3 });
    const d = j.data || {};
    return {
      ok: !!j.success,
      error: j.error ?? null,
      markdown: d.markdown ?? "",
      html: d.html ?? d.rawHtml ?? "",
      links: d.links ?? [],
      json: d.json ?? null,
      metadata: d.metadata ?? {},
      credits: j.creditsUsed ?? 1,
      raw: j,
    };
  }

  /** POST /batch/scrape + 轮询 GET /batch/scrape/{id} */
  async batchScrape(urls, opts = {}, { pollMs = 3000, timeoutMs = 900_000 } = {}) {
    const body = {
      urls,
      formats: opts.formats ?? ["markdown"],
      onlyMainContent: opts.onlyMainContent ?? true,
      maxConcurrency: opts.maxConcurrency,
      ignoreInvalidURLs: true,
      ...opts,
    };
    delete body.urls;
    const sub = await this.#req("POST", "/batch/scrape", { urls, ...body });
    const id = sub.id;
    if (!id) throw new FirecrawlError("batch scrape 未返回 job id", { body: sub });
    return this.#poll(`/batch/scrape/${id}`, { pollMs, timeoutMs });
  }

  /** POST /crawl + 轮询 */
  async crawl(url, opts = {}, { pollMs = 4000, timeoutMs = 1_800_000 } = {}) {
    const sub = await this.#req("POST", "/crawl", { url, ...opts });
    const id = sub.id;
    if (!id) throw new FirecrawlError("crawl 未返回 job id", { body: sub });
    return this.#poll(`/crawl/${id}`, { pollMs, timeoutMs });
  }

  /** POST /map —— 只要 URL 清单，极快且便宜，用来发现可选抓路径 */
  async map(url, opts = {}) {
    const j = await this.#req("POST", "/map", { url, ...opts });
    return { links: j.links ?? [], credits: j.creditsUsed ?? 1, raw: j };
  }

  /** POST /search —— 拿搜索结果（可用 scrapeOptions 让每条结果带正文） */
  async search(query, opts = {}) {
    const j = await this.#req("POST", "/search", { query, limit: 10, ...opts });
    return { results: j.data?.web ?? j.data ?? [], credits: j.creditsUsed ?? 1, raw: j };
  }

  async #poll(p, { pollMs, timeoutMs }) {
    const started = Date.now();
    let skip = 0;
    const docs = [];
    for (;;) {
      const j = await this.#req("GET", `${p}${p.includes("?") ? "&" : "?"}skip=${skip}`, undefined, { retries: 2 });
      const batch = j.data ?? [];
      for (const d of batch) docs.push(this.#normalizeDoc(d));
      if (j.status === "completed" || j.status === "failed") {
        return { status: j.status, total: j.total ?? docs.length, completed: j.completed ?? docs.length, docs, credits: j.creditsUsed ?? 0 };
      }
      if (j.next) {
        const m = /skip=(\d+)/.exec(j.next);
        skip = m ? Number(m[1]) : skip + batch.length;
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        return { status: "timeout", total: j.total ?? docs.length, completed: j.completed ?? docs.length, docs, credits: j.creditsUsed ?? 0 };
      }
      await sleep(pollMs);
    }
  }

  #normalizeDoc(d) {
    return {
      ok: !!(d.metadata?.statusCode >= 200 && d.metadata?.statusCode < 400),
      markdown: d.markdown ?? "",
      html: d.html ?? d.rawHtml ?? "",
      links: d.links ?? [],
      metadata: d.metadata ?? {},
    };
  }

  // ---------- 登录态 / 交互 ----------

  /**
   * 开一个带持久 profile 的会话并返回 scrapeId。
   * 后续 interact 复用同一浏览器，登录态在 stop() 时落盘。
   */
  async openSession(url, { profile, country = "CN", formats = ["markdown"] } = {}) {
    const r = await this.scrape(url, {
      formats,
      onlyMainContent: true,
      location: country ? { country, languages: ["zh-CN"] } : undefined,
      profile: profile ? { name: profile, saveChanges: true } : undefined,
      maxAge: 0,
    });
    const scrapeId = r.metadata?.scrapeId;
    if (!scrapeId) throw new FirecrawlError("scrape 未返回 scrapeId", { body: r.raw });
    return { scrapeId, doc: r };
  }

  /** POST /scrape/{id}/interact —— prompt 或 Playwright 代码 */
  async interact(scrapeId, { prompt, code, language = "node", timeout = 60 } = {}) {
    const body = { timeout };
    if (prompt) body.prompt = prompt;
    if (code) {
      body.code = code;
      body.language = language;
    }
    return this.#req("POST", `/scrape/${scrapeId}/interact`, body, { retries: 1, timeoutMs: (timeout + 30) * 1000 });
  }

  /** DELETE /scrape/{id}/interact —— 停止会话（writable profile 在这一步写盘） */
  async stopSession(scrapeId) {
    return this.#req("DELETE", `/scrape/${scrapeId}/interact`, undefined, { retries: 1 });
  }
}

/** 原始响应落盘，供解析器校准（不占仓库） */
export function dumpRaw(name, payload) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const f = path.join(RAW_DIR, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(payload, null, 2));
  return f;
}
