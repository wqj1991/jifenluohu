import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 一键把本地代码推到 47.95.238.28（1Panel v1 API，SSH 22 被封）。
 * 用法：
 *   node scripts/deploy.mjs            # 代码 + dist，不上传数据库
 *   node scripts/deploy.mjs --db       # 额外把本地 data/luohu.db 覆盖到服务器（会重启服务）
 *   node scripts/deploy.mjs --restart  # 仅重启服务
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
const wantDb = argv.includes("--db");
const onlyRestart = argv.includes("--restart");
let total = 0;

if (onlyRestart) {
  console.log(await shell(`systemctl restart ${SERVICE} && sleep 3 && systemctl is-active ${SERVICE}`));
  process.exit(0);
}

const files = [
  "package.json",
  ".env",
  "server/index.mjs",
  "server/db.mjs",
  "server/engine.mjs",
  "server/house.mjs",
  "server/maint.mjs",
  "server/prices.mjs",
  "server/route.mjs",
  "server/seed.mjs",
  ...fs.readdirSync(path.join(LOCAL, "dist/assets")).map((f) => `dist/assets/${f}`),
  "dist/index.html",
];
if (wantDb) files.push("data/luohu.db");

if (wantDb) {
  // 先把本地 WAL 合并进主库，否则复制过去会丢最近写入
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(LOCAL, "data/luohu.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

for (const rel of files) {
  const size = await upload(path.join(LOCAL, rel), REMOTE + path.posix.dirname(rel));
  total += size;
  console.log("OK  ", rel, (size / 1024).toFixed(0) + "KB");
}

const out = await shell(
  `systemctl restart ${SERVICE}; sleep 3; systemctl is-active ${SERVICE}; ` +
    `curl -s -o /dev/null -w "local:%{http_code}\\n" http://127.0.0.1:${PORT}/api/meta; tail -3 /var/log/luohu.log`,
);
console.log(`uploaded ${files.length} files, ${(total / 1024 / 1024).toFixed(2)}MB`);
console.log(out);
