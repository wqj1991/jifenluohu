#!/usr/bin/env node
// 每周自动刷新房价台账：抓取 → 导入 → 记日志。
//
//   node scripts/fc/weekly.mjs                  # 全量（安居客 + 我爱我家 + 贝壳 × 通州/大兴）
//   node scripts/fc/weekly.mjs --only 5i5j      # 只跑我爱我家
//   node scripts/fc/weekly.mjs --only anjuke,ke # 跑多个站点（逗号分隔）
//   node scripts/fc/weekly.mjs --district daxing
//   node scripts/fc/weekly.mjs --dry            # 只抓不导入
//   node scripts/fc/weekly.mjs --only anjuke --push
//       抓完不上本地库，改用 scripts/deploy.mjs --import 推到权威库
//       （线上 /opt/luohu/data/luohu.db 才是权威数据，本地库只是历史快照）
//
// 由 Windows 计划任务每周日 05:00 调用（见 scripts/fc/install-weekly-task.ps1），
// 也可以手动跑；日志落在 data/logs/fc-weekly-*.log，保留最近 26 周。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT); // 计划任务没有工作目录，脚本自带

const argv = process.argv.slice(2);
const flag = (name, dft = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dft;
};
const has = (name) => argv.includes(`--${name}`);

const NODE = process.execPath;
const DELAY = Number(flag("delay", 1200)) || 0;
const DRY = has("dry");
const PUSH = has("push");
const ONLY = flag("only", null);
// --only 支持逗号列表（ke,anjuke），单个值等价于旧行为
const ONLY_SET = ONLY ? new Set(String(ONLY).split(",").map((s) => s.trim()).filter(Boolean)) : null;
const DISTRICTS = String(flag("district", "tongzhou,daxing"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// 安居客 25 条/页、深页会回卷：通州实测 ~21 页取满，大兴按 30 页留余量
const JK_PAGES = { tongzhou: 55, daxing: 55 };

const LOG_DIR = path.join(ROOT, "data", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG = path.join(LOG_DIR, `fc-weekly-${stamp}.log`);

const log = (msg) => {
  const line = `${new Date().toISOString().slice(0, 19).replace("T", " ")}  ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n", "utf8");
};

/** 跑一个子进程，输出实时转进日志；超时强杀 */
function run(label, args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve) => {
    log(`▶ ${label}`);
    const child = spawn(NODE, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      // ke.mjs 没有 --delay 参数，从环境变量读间隔；保证不低于 3500ms
      env: { ...process.env, DELAY: String(Math.max(DELAY, 3500)) },
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const pipe = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) if (line.trim()) log(`   ${line}`);
    };
    child.stdout.on("data", pipe);
    child.stderr.on("data", pipe);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) log(`✖ ${label}：超过 ${Math.round(timeoutMs / 60000)} 分钟被终止`);
      else log(`${code === 0 ? "✔" : "✖"} ${label}：exit ${code}`);
      resolve({ label, code: killed ? 124 : code });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      log(`✖ ${label}：${e.message}`);
      resolve({ label, code: -1 });
    });
  });
}

const jobs = [];
const want = (site) => !ONLY_SET || ONLY_SET.has(site);

for (const d of DISTRICTS) {
  if (!want("anjuke")) continue;
  jobs.push({
    label: `抓取 安居客 ${d}`,
    args: ["scripts/fc/run.mjs", "fetch", "--site", "anjuke", "--district", d,
      "--pages", `1-${JK_PAGES[d] || 25}`, "--delay", String(DELAY)],
  });
}
for (const d of DISTRICTS) {
  if (!want("5i5j")) continue;
  jobs.push({
    label: `抓取 我爱我家 ${d}`,
    args: ["scripts/fc/run.mjs", "fetch", "--site", "5i5j", "--district", d,
      "--slices", "--delay", String(DELAY)],
  });
}
// 贝壳：区县首页 + 每个商圈首页各 30 条，不翻页（/pgN/ 恒定 302），
// 需要 data/lianjia.cookie 的登录态；间隔由 ke.mjs 自己的 DELAY 控制，最低 3500ms
for (const d of DISTRICTS) {
  if (!want("ke")) continue;
  jobs.push({
    label: `抓取 贝壳 ${d}（小区参考均价）`,
    args: ["scripts/fc/ke.mjs", "xiaoqu", d],
  });
}
if (!DRY) {
  for (const d of DISTRICTS) {
    if (PUSH) {
      // 推到权威库：本地库不是权威数据，走 deploy.mjs 的 1Panel 通道
      const files = [];
      if (want("anjuke") && fs.existsSync(path.join(ROOT, `data/fc_anjuke_${d}.json`))) {
        files.push(`data/fc_anjuke_${d}.json`);
      }
      if (want("5i5j") && fs.existsSync(path.join(ROOT, `data/fc_5i5j_${d}.json`))) {
        files.push(`data/fc_5i5j_${d}.json`);
      }
      if (want("ke") && fs.existsSync(path.join(ROOT, `data/ke_xiaoqu_${d}.json`))) {
        files.push(`data/ke_xiaoqu_${d}.json`);
      }
      if (!files.length) continue;
      jobs.push({
        label: `推送 ${d} 到权威库（${files.length} 个文件）`,
        args: ["scripts/deploy.mjs", "--import", ...files, "--create"],
      });
    } else {
      jobs.push({
        label: `导入 ${d}（含新建无坐标小区）`,
        args: ["scripts/import_prices.mjs", "--district", d, "--create"],
      });
    }
  }
}

/** 只留最近 26 周的日志 */
function pruneLogs() {
  const keep = 26;
  const files = fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("fc-weekly-") && f.endsWith(".log"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      fs.unlinkSync(path.join(LOG_DIR, f));
    } catch {}
  }
}

const started = Date.now();
log(`=== 房价周更开始 ${DRY ? "(dry)" : ""} · 区 ${DISTRICTS.join("/")} · 站点 ${ONLY || "全部"} · 间隔 ${DELAY}ms ===`);

const results = [];
for (const job of jobs) {
  // 抓取任务之间留点空隙，别把对方 IP 限流打满
  if (results.length) await new Promise((r) => setTimeout(r, 5000));
  results.push(await run(job.label, job.args));
}

const bad = results.filter((r) => r.code !== 0);
log(`=== 结束：${results.length - bad.length}/${results.length} 成功，耗时 ${Math.round((Date.now() - started) / 1000)}s ===`);
log(`日志：${path.relative(ROOT, LOG)}`);
pruneLogs();

if (bad.length) {
  log(`失败任务：${bad.map((b) => b.label).join("、")}`);
  process.exit(1);
}
