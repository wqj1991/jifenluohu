import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NODE, REMOTE, pullSnapshot, shell, upload } from "./lib/1panel.mjs";

/**
 * 把本地 data/luohu.db 的**数据**推到服务器权威库。
 *
 * 只推数据，不推服务器上更新的东西：用户填的档案（education/employment/residence/
 * honor/tax_record/price_point）、setting、账号与会话（auth_user/auth_session）一律以
 * 服务器为准，合并时覆盖回本地新建的库里；其余（community / community_price /
 * school / school_rank / community_route / transit_cache …）用本地最新数据。
 *
 * 流程：拉服务器快照 → 生成 data/luohu.merge.db → 上传 → 停服务换库（旧库留 .bak）→ 起服务校验
 * 用法：node scripts/push_db.mjs [--dry] [--no-pull]
 */

const LOCAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(LOCAL, "data", "luohu.db");
const SNAP = path.join(LOCAL, "data", "luohu.remote.db");
const MERGED = path.join(LOCAL, "data", "luohu.merge.db");

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");

/* 服务器优先的表：别人在线上填的数据不能被我本地快照盖掉 */
const SERVER_WINS = [
  "auth_user",
  "auth_session",
  "setting",
  "person",
  "education",
  "employment",
  "residence",
  "honor",
  "tax_record",
  "price_point",
  "workplace",
];

function counts(file) {
  const db = new DatabaseSync(file);
  const tabs = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const t of tabs) {
    try { out[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { out[t] = -1; }
  }
  db.close();
  return out;
}

function logDiff(title, a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  console.log(`\n${title}`);
  for (const k of keys) {
    if (a[k] === b[k]) continue;
    console.log(`  ${k.padEnd(22)} ${String(a[k] ?? "-").padStart(8)} -> ${String(b[k] ?? "-").padStart(8)}`);
  }
}

if (!fs.existsSync(SRC)) throw new Error(`找不到本地库 ${SRC}`);

/* 1. 服务器快照（拿它做“服务器优先”的表） */
if (!argv.includes("--no-pull")) {
  const n = await pullSnapshot(SNAP);
  console.log(`pulled server snapshot -> ${SNAP} ${(n / 1024 / 1024).toFixed(2)}MB`);
}

const before = counts(SNAP);
const localCounts = counts(SRC);

/* 2. 以本地库为底，VACUUM INTO 出干净的合并文件 */
fs.rmSync(MERGED, { force: true });
{
  const db = new DatabaseSync(SRC);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.prepare("VACUUM INTO ?").run(MERGED);
  db.close();
}
{
  const db = new DatabaseSync(MERGED);
  // 合并期先关外键（删父表再灌快照时子表引用会瞬时悬空），结束前做 foreign_key_check
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("ATTACH DATABASE ? AS srv").run(SNAP);
  for (const t of SERVER_WINS) {
    const exists = db.prepare("SELECT 1 FROM srv.sqlite_master WHERE type='table' AND name=?").get(t);
    if (!exists) continue;
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    const srvCols = db.prepare(`PRAGMA srv.table_info("${t}")`).all().map((c) => c.name);
    const shared = cols.filter((c) => srvCols.includes(c));
    const list = shared.map((c) => `"${c}"`).join(", ");
    db.exec(`DELETE FROM main."${t}"`);
    db.exec(`INSERT INTO main."${t}" (${list}) SELECT ${list} FROM srv."${t}"`);
  }
  db.exec("DETACH DATABASE srv");
  const check = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length) console.log(`合并库 foreign_key_check 发现 ${fk.length} 条悬空引用`);
  db.close();
  console.log(`merged integrity=${check}`);
  if (check !== "ok") throw new Error("合并库 integrity_check 失败");
}

const after = counts(MERGED);
logDiff("合并后（服务器快照 -> 新库）", before, after);
const dropped = Object.keys(after).filter((k) => (localCounts[k] ?? 0) > 0 && after[k] === 0);
if (dropped.length) throw new Error(`这些表会被清空，中止：${dropped.join(",")}`);

console.log(`\nmerge file: ${MERGED} ${(fs.statSync(MERGED).size / 1024 / 1024).toFixed(2)}MB`);
if (dry) {
  console.log("[dry] 未上传");
  process.exit(0);
}

/* 3. 上传 + 换库 */
const size = await upload(MERGED, REMOTE + "data");
console.log(`uploaded ${(size / 1024 / 1024).toFixed(2)}MB -> ${REMOTE}data/luohu.merge.db`);

const remoteSize = await shell(`stat -c %s /opt/luohu/data/luohu.merge.db`);
if (Number(remoteSize.trim()) !== size) throw new Error(`上传大小不符（远端 ${remoteSize} vs 本地 ${size}）`);

const out = await shell(`
set -e
cd /opt/luohu/data
TS=$(date +%Y%m%d-%H%M%S)
systemctl stop luohu
cp -a luohu.db luohu.db.bak-$TS
rm -f luohu.db-wal luohu.db-shm
mv -f luohu.merge.db luohu.db
ls -lt luohu.db.bak-* | tail -n +4 | awk '{print $9}' | xargs -r rm -f
systemctl start luohu
sleep 3
systemctl is-active luohu
${NODE} -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/opt/luohu/data/luohu.db');
console.log('integrity', db.prepare('PRAGMA integrity_check').get().integrity_check);
for (const t of ['community','community_price','school','school_rank','community_route','person','education','employment','residence','auth_user'])
  console.log(t, db.prepare('SELECT COUNT(*) c FROM '+t).get().c);
db.close();
"
ls -la /opt/luohu/data/luohu.db
`);
console.log(out);
console.log(await shell(`curl -s -o /dev/null -w "public-meta:%{http_code}\\n" http://127.0.0.1:8766/api/meta; tail -3 /var/log/luohu.log`));
