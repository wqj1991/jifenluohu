#!/usr/bin/env node
// 房产数据抓取 CLI（Firecrawl 通道 + 本机直连通道）
//
//   node scripts/fc/run.mjs probe
//   node scripts/fc/run.mjs probe --site 5i5j --district daxing
//   node scripts/fc/run.mjs fetch --site anjuke --district tongzhou --pages 1-10
//   node scripts/fc/run.mjs fetch --site lianjia --cookie-file data/lianjia.cookie --pages 1-20
//   node scripts/fc/run.mjs login --site lianjia          # 需 API key，Firecrawl 浏览器人工登录
//
// 通道：
//   direct    —— 本机出口（实测经公司 Zscaler 代理，境内 IP），传输层用 curl
//                （Node undici 的 TLS 指纹会被 wswaf 直接 RST，curl 不会）
//   firecrawl —— Firecrawl 云端出口（实测 4 个代理档位全部落在 US/JP，无 CN 出口），
//                四家中文房产站一律被拦
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Firecrawl, dumpRaw } from "./firecrawl.mjs";
import { SITES, DISTRICTS, normalizeRows, BIZCIRCLES, LIANJIA_SORTS } from "./providers.mjs";
import { detectBlock, summarize } from "./guard.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "probe";
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);
const range = (s, dflt) => {
  if (!s) return dflt;
  const m = /^(\d+)-(\d+)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(s);
  return Number.isFinite(n) ? [n, n] : dflt;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fc = new Firecrawl();
console.log(`[firecrawl] mode=${fc.mode}`);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 直连通道 Cookie：浏览器 DevTools / Cookie-Editor 导出，
// 支持一行 "k=v; k2=v2"，也支持 JSON 数组 [{name,value}]
function loadCookie(file) {
  if (!file) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw.startsWith("[")) {
    return JSON.parse(raw)
      .filter((c) => c.name)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
  return raw.replace(/^Cookie:\s*/i, "").replace(/\s*\n\s*/g, "; ");
}

const USER_COOKIE = loadCookie(flag("cookie-file", null));
console.log(`[cookie] ${USER_COOKIE ? USER_COOKIE.length + " 字节已载入" : "未提供（匿名直连）"}\n`);

/**
 * 用 curl 发请求（绕开 undici TLS 指纹）。
 * 本机 curl 是 Schannel 版，对 wswaf 站点会间歇报
 *   `curl: (35) schannel: failed to receive handshake, SSL/TLS connection failed`
 * 属握手抖动而非永久失败 —— 固定重试 3 次，退避 800ms。
 */
function curlOnce(url, { referer, cookie, jar, ua, timeout = 30 } = {}) {
  const args = [
    "-sS",
    "-m",
    String(timeout),
    "-L",
    "--compressed",
    "--http1.1",
    "--tlsv1.2",
    "-A",
    ua || UA,
    "-H",
    "Accept-Language: zh-CN,zh;q=0.9",
    "-H",
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-w",
    "\n__STATUS__%{http_code}\n__URL__%{url_effective}",
  ];
  if (referer) args.push("-e", referer);
  // -c/-b 用 jar 文件跨请求保活（wswaf 会同时下发 HMF_CI 等 cookie）
  if (jar) args.push("-c", jar, "-b", jar);
  const ck = cookie ?? USER_COOKIE;
  if (ck) args.push("-b", ck);
  args.push(url);

  return new Promise((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "buffer" }, (err, out, errOut) => {
      if (err) {
        const msg = String(errOut || err.message).trim().slice(0, 200);
        const e = new Error(`curl: ${msg}`);
        e.transient = /\(35\)|\(52\)|\(56\)|\(28\)|\(7\)/.test(msg);
        return reject(e);
      }
      const text = Buffer.from(out).toString("utf8");
      const m = /\n__STATUS__(\d+)\n__URL__(\S*)\s*$/.exec(text);
      resolve({
        status: m ? Number(m[1]) : 0,
        url: m ? m[2] : url,
        text: m ? text.slice(0, m.index) : text,
      });
    });
  });
}

async function curlGet(url, opts = {}) {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      return await curlOnce(url, opts);
    } catch (e) {
      if (!e.transient || i === attempts - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

/**
 * wswaf 类 JS 挑战自动过关：
 * 挑战页尾部会写 document.cookie="C3VK=xxx; path=/; max-age=300"
 * 并把当前 URL 重新发给自己。抽出 cookie 值带上去重放一次即可。
 */
function extractChallengeCookie(html) {
  const m = /\.cookie\s*=\s*"([^"]+)"/.exec(html) || /document\.cookie\s*=\s*'([^']+)'/i.exec(html);
  if (!m) return null;
  const pair = m[1].split(";")[0].trim();
  return /^[A-Za-z0-9_]+=/.test(pair) ? pair : null;
}

const CHANNEL = flag("channel", null);
const useDirect = (s) => CHANNEL === "direct" || (CHANNEL !== "firecrawl" && s.directOk === true);

const extractTitle = (html) => /<title[^>]*>([\s\S]{0,120}?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";

/** 直连：请求 → 若命中挑战则解 cookie 重放 → 返回最终 html */
const JAR_DIR = process.env.FIRECRAWL_RAW_DIR || "D:/dsh/cache/tmp/fc";

async function directGrab(siteKey, url) {
  const s = SITES[siteKey];
  fs.mkdirSync(JAR_DIR, { recursive: true });
  const jar = path.join(JAR_DIR, `jar_${siteKey}.txt`);

  const r = await curlGet(url, { referer: s.directReferer, jar, ua: s.ua });
  let verdict = detectBlock({ markdown: r.text, metadata: { statusCode: r.status, url: r.url, title: extractTitle(r.text) } });

  if (verdict.kind === "waf-challenge") {
    const ck = extractChallengeCookie(r.text);
    if (ck) {
      await sleep(500);
      const r2 = await curlGet(url, { referer: url, cookie: ck, jar });
      const v2 = detectBlock({ markdown: r2.text, metadata: { statusCode: r2.status, url: r2.url, title: extractTitle(r2.text) } });
      const p2 = s.parseHtml ? s.parseHtml(r2.text, null) : [];
      if (p2.length || !v2.blocked) {
        return { text: r2.text, status: r2.status, url: r2.url, verdict: p2.length ? { blocked: false, kind: null, evidence: `挑战已解 ${ck}` } : v2, solved: ck };
      }
      // 挑战过了但仍在登录墙 / 别处：把第二次结果原样返回，别丢信息
      return { text: r2.text, status: r2.status, url: r2.url, verdict: v2, solved: ck + " (未过关)" };
    }
  }
  return { text: r.text, status: r.status, url: r.url, verdict, solved: null };
}

async function grabOne(siteKey, url) {
  const s = SITES[siteKey];

  if (useDirect(s)) {
    const g = await directGrab(siteKey, url);
    const parsed = s.parseHtml ? s.parseHtml(g.text, null) : [];
    const verdict = parsed.length ? { blocked: false, kind: null, evidence: `解析 ${parsed.length} 条` } : g.verdict;
    return { parsed, verdict, status: g.status, len: g.text.length, finalUrl: g.url, raw: g.text, channel: "direct", solved: g.solved };
  }

  const doc = await fc.scrape(url, {
    formats: ["markdown"],
    onlyMainContent: true,
    location: { country: "CN", languages: ["zh-CN"] },
    profile: s.profile ? { name: s.profile, saveChanges: false } : undefined,
    maxAge: 0,
  });
  const verdict = detectBlock(doc);
  const parsed = verdict.blocked || !s.parse ? [] : s.parse(doc.markdown);
  return {
    parsed,
    verdict: parsed.length || !verdict.blocked ? { blocked: false, kind: null, evidence: `解析 ${parsed.length} 条` } : verdict,
    status: doc.metadata?.statusCode,
    len: doc.markdown.length,
    finalUrl: doc.metadata?.url,
    raw: doc.raw,
    channel: "firecrawl",
  };
}

// ---------------------------------------------------------------- probe
async function probe() {
  const sites = flag("site") ? [flag("site")] : Object.keys(SITES);
  const district = flag("district", "tongzhou");
  const rows = [];

  for (const key of sites) {
    const s = SITES[key];
    const url = s.listingUrl({ district, page: 1 });
    try {
      const r = await grabOne(key, url);
      const rawFile = dumpRaw(
        `probe_${key}_${district}`,
        typeof r.raw === "string" ? { url: r.finalUrl, solved: r.solved ?? null, html: r.raw.slice(0, 400_000) } : r.raw
      );
      rows.push({ site: key, url, status: r.status, len: r.len, verdict: r.verdict, parsed: r.parsed.length, channel: r.channel, solved: r.solved ?? null, raw: rawFile });
      if (r.channel === "firecrawl") await sleep(1200);
    } catch (e) {
      rows.push({
        site: key,
        url,
        status: e.status ?? "-",
        len: 0,
        verdict: { blocked: true, kind: "request-failed", evidence: String(e.message).split("\n")[0].slice(0, 90) },
        parsed: 0,
      });
    }
    const last = rows.at(-1);
    const tag = last.verdict.blocked ? "✗ " + last.verdict.kind : "✓ " + last.parsed + " 条";
    process.stdout.write(`  ${key} [${last.channel ?? "-"}]${last.solved ? " 挑战已解" : ""} … ${tag}\n`);
  }

  console.log("\n" + summarize(rows));
  console.log(`\ncredits: ${fc.stats.credits} / calls: ${fc.stats.calls}`);
  fs.mkdirSync("data", { recursive: true });
  const out = path.join("data", `fc_probe_${district}.json`);
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), district, rows }, null, 2));
  console.log(`→ ${out}`);
}

// ---------------------------------------------------------------- fetch
async function fetchList() {
  const siteKey = flag("site", "anjuke");
  const district = flag("district", "tongzhou");
  const [p1, p2] = range(flag("pages"), [1, 5]);
  const s = SITES[siteKey];
  if (!s) throw new Error(`未知站点 ${siteKey}，可选：${Object.keys(SITES).join(", ")}`);
  if (!DISTRICTS[district]) throw new Error(`未知区 ${district}，可选：${Object.keys(DISTRICTS).join(", ")}`);

  const all = [];
  const byId = new Map();
  const report = [];
  const baseDelay = Number(flag("delay", 0)) || 0;
  const cooldown = Number(flag("cooldown", 45)) || 45;
  const maxRetry = Number(flag("retry", 2)) || 0;

  // 拿到「本轮要抓的 URL 清单」：
  //   --biz  → 商圈 × 排序（绕开被 RST 的深分页，每个商圈取默认/价升/价降三份首页）
  //   默认    → 区级翻页 --pages a-b
  const tasks = [];
  if (has("biz")) {
    const circles = BIZCIRCLES[district] ?? [];
    if (!circles.length) throw new Error(`没有 ${district} 的商圈清单，先去 /xiaoqu/${district}/ 的筛选栏抄 slug`);
    for (const b of circles) {
      for (const sort of LIANJIA_SORTS) {
        tasks.push({
          page: tasks.length + 1,
          label: `${b.name}${sort.tag}`,
          url: `https://bj.lianjia.com/xiaoqu/${b.slug}/${sort.path}`,
        });
      }
    }
    console.log(`[biz] ${circles.length} 个商圈 × ${LIANJIA_SORTS.length} 种排序 = ${tasks.length} 个列表页`);
  } else {
    for (let p = p1; p <= p2; p++) tasks.push({ page: p, label: `p${p}`, url: s.listingUrl({ district, page: p }) });
  }

  for (const task of tasks) {
    const page = task.page;
    const url = task.url;
    let done = false;
    for (let attempt = 0; attempt <= maxRetry && !done; attempt++) {
      try {
        const r = await grabOne(siteKey, url);
        // 链家有几个商圈 slug 在别的区同名：guloudajie 实际返回的是昌平的鼓楼大街，
        // 列表页会把外区小区整页混进来。按 district_raw 硬过滤，宁可少不可脏。
        const wantDistrict = DISTRICTS[district].name;
        const norm = normalizeRows(
          r.parsed.map((x) => ({ ...x, district: x.district ?? wantDistrict })),
          { district, site: siteKey }
        ).filter((x) => !x.district_raw || x.district_raw.includes(wantDistrict));
        const tag = attempt ? ` (重试${attempt})` : "";
        report.push({ page, url, channel: r.channel, status: r.status, len: r.len, got: norm.length, blocked: r.verdict.blocked, kind: r.verdict.kind ?? null, attempt });

        // 链家/贝壳的 geetest 是频率触发，冷却后大概率恢复；登录墙才是真断头
        const retriable = r.verdict.kind === "geetest-captcha" || r.verdict.kind === "empty-body";
        if (r.verdict.blocked && retriable && attempt < maxRetry) {
          dumpRaw(`blocked_${siteKey}_${district}_p${page}_a${attempt}`, r.raw);
          process.stdout.write(`p${page} ✗ ${r.verdict.kind}${tag} → 冷却 ${cooldown}s 后重试\n`);
          await sleep(cooldown * 1000);
          continue;
        }

        let fresh = 0;
        for (const row of norm) {
          const prev = byId.get(row.id);
          if (!prev) {
            byId.set(row.id, row);
            all.push(row);
            fresh++;
          } else if (prev.price == null && row.price != null) {
            Object.assign(prev, row);
          }
        }
        process.stdout.write(`p${page} ${r.verdict.blocked ? "✗ " + r.verdict.kind : "✓"} ${norm.length} 条（新增 ${fresh}）${tag}\n`);
        done = true;
        if (r.verdict.blocked) {
          dumpRaw(`blocked_${siteKey}_${district}_p${page}`, r.raw);
          break;
        }
        if (!has("biz") && norm.length === 0 && page > p1) break;
        // m.5i5j 超出末页会「回卷」到第 1 页（200 + 正常列表），不是 404 也不是空页：
        // 整页零新增即视为到底，否则会白翻到 p100 并把全量重复拉一遍。
        if (!has("biz") && norm.length > 0 && fresh === 0 && page > p1) {
          process.stdout.write(`p${page} 无新增小区 → 判定已回卷/到底，停止翻页\n`);
          break;
        }
        // 直连通道按真人节奏，翻太快链家直接上 geetest
        const gap = baseDelay || (r.channel === "firecrawl" ? 1500 : 4500 + Math.random() * 3000);
        await sleep(gap);
      } catch (e) {
        report.push({ page, url, error: String(e.message).split("\n")[0], attempt });
        process.stdout.write(`p${page} 失败: ${String(e.message).split("\n")[0]}\n`);
        if (attempt >= maxRetry) {
          done = true;
          break;
        }
        await sleep(cooldown * 1000);
      }
    }
    if (!done) break;
  }

  fs.mkdirSync("data", { recursive: true });
  const out = path.join("data", `fc_${siteKey}_${district}.json`);

  // 与上次结果合并：链家有概率性 geetest，单次跑不满，必须能断点续抓
  let carried = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(out, "utf8"));
    for (const row of Array.isArray(prev.rows) ? prev.rows : []) {
      if (!row?.id) continue;
      const cur = byId.get(row.id);
      if (!cur) {
        byId.set(row.id, row);
        all.push(row);
        carried++;
      } else if (cur.price == null && row.price != null) {
        Object.assign(cur, row);
      }
    }
  } catch {}

  fs.writeFileSync(
    out,
    JSON.stringify({ at: new Date().toISOString(), site: siteKey, district, count: all.length, report, rows: all }, null, 2)
  );
  console.log(`\n共 ${all.length} 条（去重后，本次新增 ${all.length - carried}，沿用旧档 ${carried}） → ${out}  (credits ${fc.stats.credits})`);
}

// ---------------------------------------------------------------- login
async function login() {
  const siteKey = flag("site", "lianjia");
  const s = SITES[siteKey];
  if (!s?.profile) throw new Error(`${siteKey} 未配置 profile`);
  if (fc.mode === "keyless") {
    console.log("[!] keyless 免费档不支持 interact/profile（实测 401 / 409），需要 FIRECRAWL_API_KEY。");
    console.log("    免费申请：https://firecrawl.dev/ → 1000 credits/月");
    console.log("    注意：Firecrawl 出口是海外 IP，即便登录成功，链家仍会按 IP 走 geetest ——");
    console.log("          登录态路线只对「本机住宅 IP」有意义，用 --cookie-file 走 direct 通道更实际。");
    process.exit(3);
  }

  const startUrl = { lianjia: "https://bj.lianjia.com/", ke: "https://bj.ke.com/", "5i5j": "https://bj.5i5j.com/user/login/" }[siteKey];
  const { scrapeId, doc } = await fc.openSession(startUrl, { profile: s.profile, country: "CN" });
  console.log(`scrapeId=${scrapeId}  落地: ${doc.metadata?.url}`);
  const live =
    doc.raw?.liveView?.interactiveLiveViewUrl ?? doc.raw?.interactiveLiveViewUrl ?? doc.raw?.data?.metadata?.interactiveLiveViewUrl;
  console.log(`\n在浏览器打开下面这个链接完成登录/过验证码：\n\n  ${live ?? "(未返回 interactiveLiveViewUrl)"}\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  await rl.question("登录完成后按回车，把 cookie 落盘到 profile…");
  rl.close();
  await fc.stopSession(scrapeId);
  console.log(`profile "${s.profile}" 已保存，之后 fetch 会自动复用。`);
}

const main = { probe, fetch: fetchList, login }[cmd];
if (!main) {
  console.error(`未知命令 ${cmd}；可用：probe | fetch | login`);
  process.exit(2);
}
main().catch((e) => {
  console.error(`\n[error] ${String(e.message).split("\n")[0]}`);
  if (e.status) console.error(`status=${e.status} code=${String(e.code ?? "-").split("\n")[0]}`);
  process.exit(1);
});
