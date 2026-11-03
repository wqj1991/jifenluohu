import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * 服务器上跑的每日备份：VACUUM INTO 出一份一致快照，保留最近 KEEP 份。
 * 用法：node scripts/backup.mjs [保留份数]
 */
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const DB = process.env.LUOHU_DB || path.join(ROOT, "data", "luohu.db");
const DIR = process.env.LUOHU_BACKUP_DIR || path.join(ROOT, "backups");
const KEEP = Number(process.argv[2] || process.env.LUOHU_BACKUP_KEEP || 14);

fs.mkdirSync(DIR, { recursive: true });
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const out = path.join(DIR, `luohu-${stamp}.db`);

const db = new DatabaseSync(DB);
db.prepare("VACUUM INTO ?").run(out);
const check = db.prepare("PRAGMA integrity_check").get();
const count = db.prepare("SELECT COUNT(*) c FROM community").get().c;
db.close();

const size = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
console.log(`backup -> ${out} ${size}MB integrity=${check.integrity_check} communities=${count}`);

const files = fs
  .readdirSync(DIR)
  .filter((f) => /^luohu-\d{8}-\d{6}\.db$/.test(f))
  .sort();
for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
  fs.unlinkSync(path.join(DIR, f));
  console.log("pruned", f);
}
console.log(`kept ${Math.min(files.length, KEEP)} backup(s)`);
