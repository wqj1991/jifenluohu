import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 1Panel v1 API 的最小封装（服务器 47.95.238.28，SSH 22 外网被封）。
 * Key 读取顺序：环境变量 ONEPANEL_KEY > ~/.1panel_key
 */
export const BASE = "http://47.95.238.28:8090";
export const REMOTE = "/opt/luohu/";
export const NODE = "/root/.nvm/versions/node/v24.21.0/bin/node";

const KEY = process.env.ONEPANEL_KEY || (() => {
  const f = path.join(os.homedir(), ".1panel_key");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  throw new Error("缺少 1Panel API Key：设置 ONEPANEL_KEY 或写 ~/.1panel_key");
})();

export function auth(extra = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const token = crypto.createHash("md5").update("1panel" + KEY + ts).digest("hex");
  return { "1Panel-Token": token, "1Panel-Timestamp": ts, ...extra };
}

/** 注意：1Panel 的 upload 对部分子目录（如 /opt/luohu/scripts）会静默不落地，调用后要自己校验 */
export async function upload(localFile, remoteDir) {
  const buf = fs.readFileSync(localFile);
  const fd = new FormData();
  fd.append("path", remoteDir);
  fd.append("file", new Blob([buf]), path.basename(localFile));
  const r = await fetch(`${BASE}/api/v1/files/upload`, {
    method: "POST",
    headers: auth(),
    body: fd,
    signal: AbortSignal.timeout(600000),
  });
  const t = await r.text();
  if (!(r.status === 200 && t.includes('"code":200'))) throw new Error(`${localFile} -> ${remoteDir}: ${t.slice(0, 160)}`);
  return buf.length;
}

/** 通过 1Panel 计划任务（cronjob id 2）跑一段 shell，返回日志 */
export async function shell(cmd, timeout = 300000) {
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

/** 让服务器自己 VACUUM INTO 一份一致快照再下载，避免捞到 WAL 里的半成品 */
export async function pullSnapshot(dest) {
  const tmp = "/tmp/luohu-snapshot.db";
  await shell(
    `rm -f ${tmp} && ${NODE} -e "const {DatabaseSync}=require('node:sqlite');` +
      `const db=new DatabaseSync('/opt/luohu/data/luohu.db');db.prepare('VACUUM INTO ?').run('${tmp}');` +
      `db.close();console.log('snapshot',require('node:fs').statSync('${tmp}').size)"`,
  );
  const r = await fetch(`${BASE}/api/v1/files/download?path=${encodeURIComponent(tmp)}`, {
    headers: auth(),
    signal: AbortSignal.timeout(600000),
  });
  if (r.status !== 200) throw new Error(`download failed: ${r.status} ${(await r.text()).slice(0, 120)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  await shell(`rm -f ${tmp}`);
  return buf.length;
}
