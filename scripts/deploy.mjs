import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把代码推到 47.95.238.28（1Panel v1 API，SSH 22 被封）。
 *
 * 数据只有服务器那一份：本脚本**不会**把本地 data/luohu.db 传上去。
 * 需要本地看数据时用 --pull 把服务器上的库拉到 data/luohu.remote.db（只读用途）。
 *
 * 用法：
 *   node scripts/deploy.mjs            # 代码 + dist，重启服务
 *   node scripts/deploy.mjs --restart  # 仅重启服务
 *   node scripts/deploy.mjs --pull     # 只拉服务器数据库快照到本地
 *   node scripts/deploy.mjs --import data/fc_5i5j_daxing.json [--create] [--dry]
 *                                      # 抓取产物传到服务器并直接写权威库
 * key 读取顺序：环境变量 ONEPANEL_KEY > ~/.1panel_key
 */

const BASE = "http://47.95.238.28:8090";
const LOCAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = "/opt/luohu/";
const SERVICE = "luohu";
const PORT = 8766;

const KEY = process.env.ONEPANEL_KEY || (() => {
  const f = path.join(os.homedir(), ".1panel_key");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  throw new Error("缺少 1Panel API Key：设置 ONEPANEL_KEY 或写 ~/.1panel_key");
})();

function auth(extra = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const token = crypto.createHash("md5").update("1panel" + KEY + ts).digest("hex");
  return { "1Panel-Token": token, "1Panel-Timestamp": ts, ...extra };
}

async function upload(localFile, remoteDir) {
  const buf = fs.readFileSync(localFile);
  const fd = new FormData();
  fd.append("path", remoteDir);
  fd.append("file", new Blob([buf]), path.basename(localFile));
  const r = await fetch(`${BASE}/api/v1/files/upload`, {
    method: "POST",
    headers: auth(),
    body: fd,
    signal: AbortSignal.timeout(300000),
  });
  const t = await r.text();
  if (!(r.status === 200 && t.includes('"code":200'))) throw new Error(`${localFile} -> ${remoteDir}: ${t.slice(0, 160)}`);
  return buf.length;
}

/** 通过 1Panel 计划任务执行 shell（cronjob id 2 = deploy shell 槽位） */
async function shell(cmd, timeout = 180000) {
  const B = "===DEPLOY-BEGIN===", E = "===DEPLOY-END===";
  const script = `#!/bin/bash\nLOG=/tmp/luohu-deploy.log\necho "${B}" > $LOG\n{\n${cmd}\n} >> $LOG 2>&1\necho "${E} rc=$?" >> $LOG\n`;
  await fetch(`${BASE}/api/v1/cronjobs/update`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: 2, name: "luohu-deploy", type: "shell", spec: "0 0 1 1 *", script, retainCopies: 1 }),
  });
  await fetch(`${BASE}/api/v1/cronjobs/handle`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: 2 }),
  });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await new Promise((r) => setTimeout(r, 800));
    const r = await fetch(`${BASE}/api/v1/files/content`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "/tmp/luohu-deploy.log" }),
    });
    const c = (await r.json())?.data?.content ?? "";
    const i = c.indexOf(B), j = c.indexOf(E);
    if (i >= 0 && j > i) return c.slice(i + B.length, j).trim();
  }
  throw new Error("远程命令超时");
}

const argv = process.argv.slice(2);

/* ---------- 抓取产物导入服务器权威库 ---------- */
if (argv.includes("--import")) {
  const rest = argv.slice(argv.indexOf("--import") + 1);
  const inputs = rest.filter((a) => !a.startsWith("--"));
  const flags = rest.filter((a) => a.startsWith("--")).join(" ");
  if (!inputs.length) throw new Error("--import 后面要给 JSON 路径");
  await shell("mkdir -p /opt/luohu/data/incoming");
  const names = [];
  for (const f of inputs) {
    const p = path.resolve(LOCAL, f);
    if (!fs.existsSync(p)) throw new Error(`找不到 ${p}`);
    await upload(p, REMOTE + "data/incoming");
    const n = path.basename(p);
    names.push(n);
    console.log("UP  ", n, (fs.statSync(p).size / 1024).toFixed(0) + "KB");
  }
  // 逐文件导入（服务器上跑，写的是权威库 data/luohu.db）
  for (const n of names) {
    const r = await shell(
      `cd /opt/luohu && /root/.nvm/versions/node/v24.21.0/bin/node scripts/import_prices.mjs --file data/incoming/${n} ${flags}`,
    );
    console.log(`--- ${n} ---\n${r}`);
  }
  process.exit(0);
}

/* ---------- 只拉数据库快照 ---------- */
if (argv.includes("--pull")) {
  const out = path.join(LOCAL, "data", "luohu.remote.db");
  // 先在服务器上 VACUUM INTO 一份一致快照，避免直接捞 WAL 中的半成品
  await shell(`cd /opt/luohu && /root/.nvm/versions/node/v24.21.0/bin/node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/opt/luohu/data/luohu.db');
db.prepare('VACUUM INTO ?').run('/tmp/luohu-snapshot.db');
console.log('snapshot', require('node:fs').statSync('/tmp/luohu-snapshot.db').size);
"`);
  const r = await fetch(`${BASE}/api/v1/files/download?path=${encodeURIComponent("/tmp/luohu-snapshot.db")}`, {
    headers: auth(),
    signal: AbortSignal.timeout(300000),
  });
  if (r.status !== 200) throw new Error(`download failed: ${r.status} ${(await r.text()).slice(0, 120)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`pulled -> ${out} ${(buf.length / 1024 / 1024).toFixed(2)}MB`);
  await shell("rm -f /tmp/luohu-snapshot.db");
  process.exit(0);
}

if (argv.includes("--restart")) {
  console.log(await shell(`systemctl restart ${SERVICE} && sleep 3 && systemctl is-active ${SERVICE}`));
  process.exit(0);
}

const files = [
  "package.json",
  ".env",
  // 后端整个目录都推，避免新增模块忘记加清单导致线上 import 失败
  ...fs.readdirSync(path.join(LOCAL, "server")).filter((f) => f.endsWith(".mjs")).map((f) => `server/${f}`),
  "scripts/backup.mjs",
  "scripts/import_prices.mjs",
  "scripts/set_password.mjs",
  "scripts/gen_districts_geo.mjs",
  "data/geo/districts.json",
  ...fs.readdirSync(path.join(LOCAL, "dist/assets")).map((f) => `dist/assets/${f}`),
  "dist/index.html",
].filter((rel) => fs.existsSync(path.join(LOCAL, rel)));

let total = 0;
for (const rel of files) {
  const size = await upload(path.join(LOCAL, rel), REMOTE + path.posix.dirname(rel));
  total += size;
  console.log("OK  ", rel, (size / 1024).toFixed(0) + "KB");
}

// 1Panel 的 upload 对部分子目录会静默不落地，备份脚本用 base64 走 shell 兜底
{
  const src = fs.readFileSync(path.join(LOCAL, "scripts/backup.mjs"));
  const b64 = src.toString("base64");
  await shell(`mkdir -p /opt/luohu/scripts && echo ${b64} | base64 -d > /opt/luohu/scripts/backup.mjs && wc -c /opt/luohu/scripts/backup.mjs`);
}

const out = await shell(
  // 只装 boot 需要的东西：新增服务端依赖时自动补装（cron 里没有 npm，用绝对路径）
  `export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH; cd /opt/luohu && ` +
    `npm i --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund 2>&1 | tail -2; ` +
    `mkdir -p data/tiles; ` +
    `systemctl restart ${SERVICE}; sleep 3; systemctl is-active ${SERVICE}; ` +
    `curl -s -o /dev/null -w "local:%{http_code}\\n" http://127.0.0.1:${PORT}/api/meta; tail -3 /var/log/luohu.log`,
);
console.log(`uploaded ${files.length} files, ${(total / 1024 / 1024).toFixed(2)}MB`);
console.log(out);
