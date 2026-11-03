// 幼儿园分档入库（幂等）
// 数据来源（官方原件已存 data/kindergarten/）：
//   经开 · 北京经济技术开发区幼儿园名录及基本情况（社会事业局，2025-06，28 所）
//   大兴 · 2026年大兴区幼儿园名单公示（区教委，2026-05-28，187 所）
//   通州 · 通州区幼儿园园所公示信息（区教委，2026-06-08，教办园/集体+部队/民办普惠/民办非普 4 份 PDF）
// 分档口径：官方只出「合格/不合格」，没有分档，所以梯队是本地推断，逐条写进 note。
//   tier 依据 = 办园性质 → 集团化（是否总园/分园）→ 收费定位 → 建园背景
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const db = new DatabaseSync("data/luohu.db");
const now = new Date().toISOString().replace("T", " ").slice(0, 19);
const STAGE = "幼儿园";
const METRIC = "综合";

const KFQ_URL = "https://kfqgw.beijing.gov.cn/zwgkkfq/tzgg/202506/t20250605_4106550.html";
const DX_URL = "https://www.bjdx.gov.cn/bjsdxqrmzf/zwfw/zdly/jyly/jyxx/2342590/index.html";
const TZ_URL = "https://www.bjtzh.gov.cn/bjtz/tspd/tzjy/jygs/index.shtml";

const kfq = JSON.parse(readFileSync("data/kindergarten/kfq2025.json", "utf8"));
const dx = JSON.parse(readFileSync("data/kindergarten/dx2026.json", "utf8"));
const tz = JSON.parse(readFileSync("data/kindergarten/tz2026.json", "utf8"));

/* ---------- 大兴一梯队：区级数字总园 + 镇中心园总园 + 高校附属 ---------- */
const DX_TIER1 = new Set([
  "北京市大兴区第一幼儿园",
  "北京市大兴区第二幼儿园",
  "北京市大兴区第三幼儿园",
  "北京市大兴区第四幼儿园",
  "北京市大兴区第五幼儿园",
  "北京市大兴区第六幼儿园",
  "北京市大兴区第七幼儿园",
  "北京市大兴区第八幼儿园",
  "北京市大兴区第九幼儿园",
  "北京市大兴区第十幼儿园",
  "北京市大兴区第十一幼儿园",
  "北京市大兴区第十二幼儿园",
  "北京市大兴区民族幼儿园",
  "北京市大兴区黄村镇第一中心幼儿园",
  "北京市大兴区旧宫镇第一中心幼儿园",
  "北京市大兴区瀛海镇第一中心幼儿园",
  "北京市大兴区西红门兴海幼儿园",
  "首都师范大学学前教育学院附属幼儿园",
]);

/* ---------- 大兴口碑普惠民办（二梯队）---------- */
const DX_PUHHUI_TIER2 = new Set([
  "北京市大兴区十一建华实验幼儿园",
  "北京市大兴区幸福泉翡翠城幼儿园",
  "北京市大兴区清城启航幼儿园",
  "北京市大兴区琴岛金钰幼儿园",
  "北京市大兴区德津公学幼儿园",
  "北京市大兴区伽悦然幼儿园",
  "北京市大兴区楷妍幼儿园",
  "北京市大兴区快乐时光幼儿园",
  "北京市大兴区瀚林幼儿园",
  "北京市大兴区高新幼儿园",
  "北京市大兴区新启蒙幼儿园",
  "北京市大兴区瑞海英才幼儿园",
  "北京市大兴区爱育培优幼儿园",
  "北京市大兴区御园幼儿园",
  "北京市大兴区菁苗首座幼儿园",
  "北京市大兴区燕宝幼儿园",
]);

const num = (s) => {
  const m = String(s || "").match(/^\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/* ---------- 分档 ---------- */
function tierKfq(r) {
  const fee = num(r.fee_edu);
  if (r.kind === "公办") return ["一梯队", "公办园（财政投入、保教费 600 元/月）"];
  if (r.kind === "普惠性民办幼儿园") return ["二梯队", "普惠民办（保教费 900 元/月上限）"];
  if (fee != null && fee < 6000) return ["三梯队", `中端非普惠民办（保教费 ${fee} 元/月）`];
  return ["民办/国际", `高端非普惠民办（保教费 ${fee ?? "?"} 元/月）`];
}

function tierDx(r) {
  if (r.kind === "村办园") return ["其他梯队", "村办园，保障型学位"];
  if (r.kind === "部队园") return ["其他梯队", "部队办园，仅限内部招生"];
  if (r.kind === "非普惠性民办园") return ["民办/国际", "非普惠民办，市场化收费"];
  if (r.kind === "普惠性民办园")
    return DX_PUHHUI_TIER2.has(r.name) ? ["二梯队", "普惠民办，口碑/办学史较好"] : ["三梯队", "普惠民办，一般保障型"];
  // 教育部门办
  if (DX_TIER1.has(r.name)) return ["一梯队", "区级数字总园/镇中心园总园/高校附属"];
  if (r.name.includes("分园")) return ["二梯队", "总园分园，管理与教研口径随总园"];
  return ["二梯队", "教育部门办普通园（非数字系列总园）"];
}


/* ---------- 通州：有官方督导评估等级（合格 / B 等级 / C 等级），可作硬指标 ---------- */
const TZ_BRANCH = /分园|分部|校区|教学点|（[^）]*园）|（[^）]*部）/;
/* 市级名校在副中心办的分部/校区：名头压过分部属性，仍算一梯队 */
const TZ_TOP = /北京一幼海晟|北京市第一幼儿园|北海幼儿园|北京市第五幼儿园|北京第一实验学校|六一幼儿院|北京市六一/;
function tierTz(r) {
  const g = r.grade || "";
  if (r.nature === "部队办") return ["其他梯队", "部队办园，主要面向内部招生"];
  if (r.nature === "教育部门办") {
    if (TZ_TOP.test(r.name)) return ["一梯队", `市级名校在副中心办园（督导评估：${g || "未标"}），教研与师资随本部`];
    if (TZ_BRANCH.test(r.name)) return ["二梯队", `教办园分园/分部（督导评估：${g || "未标"}），管理随总园`];
    return ["一梯队", `教育部门办园（教办园，督导评估：${g || "未标"}），财政投入、保教费 ${r.fee_bj ?? "?"} 元/月`];
  }
  if (r.nature === "集体办") {
    if (TZ_BRANCH.test(r.name)) return ["二梯队", `集体办园分园（督导评估：${g || "未标"}）`];
    return ["一梯队", `镇/村集体办中心园（公办普惠，督导评估：${g || "未标"}）`];
  }
  if (r.nature === "民办普惠") {
    if (g === "A等级" || g === "B等级") return ["二梯队", `普惠民办且督导评估 ${g}（保教费 ${r.fee_bj ?? "?"} 元/月）`];
    return ["三梯队", `普惠民办，督导评估 ${g || "未标"}（保教费 ${r.fee_bj ?? "?"} 元/月）`];
  }
  return ["民办/国际", "非普惠民办（市场化定价，含营利性公司办园）"];
}

/* ---------- 组装 ---------- */
const rows = [];

for (const r of kfq) {
  const [tier, why] = tierKfq(r);
  const toks = String(r.fee_extra || "").split(" ").filter(Boolean);
  const tuoFee = r.tuoban && toks.length > 1 ? toks[toks.length - 1] : "";
  const rest = tuoFee ? toks.slice(0, -1).join(" ") : toks.join(" ");
  const tuoText = r.tuoban ? `开设托班（${tuoFee || "?"} 元/月）` : "未开托班";
  rows.push({
    name: r.name,
    region: "经开",
    year: 2025,
    tier,
    source: "北京经济技术开发区幼儿园名录及基本情况（社会事业局，2025-06）｜官方名录；梯队为本地推断",
    source_url: KFQ_URL,
    note: `性质：${r.kind}；地址：${r.addr}；咨询电话：${r.tel}；保教费：${r.fee_edu} 元/月；伙食/代办：${rest || "—"}；${tuoText}。分档依据：${why}`,
  });
}

for (const r of dx) {
  const [tier, why] = tierDx(r);
  rows.push({
    name: r.name,
    region: "大兴",
    year: 2026,
    tier,
    source: "2026年大兴区幼儿园名单公示（大兴区教委，2026-05-28）｜官方名单；梯队为本地推断",
    source_url: DX_URL,
    note: `性质：${r.kind}；镇街：${r.town}；地址：${r.addr}；咨询电话：${r.tel}。分档依据：${why}`,
  });
}

for (const r of tz) {
  const [tier, why] = tierTz(r);
  const fee = r.fee_bj ? `保教费：${r.fee_bj} 元/月` : "保教费：市场调节价";
  const meal = r.fee_meal ? `；餐费：${r.fee_meal} 元/天` : "";
  const ty = r.fee_tuoyu ? `；托育服务费：${r.fee_tuoyu} 元/月` : "";
  const cls = r.classes ? `；办园规模：${r.classes} 个教学班` : "";
  rows.push({
    name: r.name,
    region: "通州",
    year: 2026,
    tier,
    source: "通州区幼儿园园所公示信息（通州区教委，2026-06-08）｜官方公示；梯队为本地推断",
    source_url: TZ_URL,
    note: `性质：${r.nature}；乡镇街道：${r.street || "—"}；地址：${r.addr}；咨询电话：${r.tel || "—"}；${fee}${meal}${ty}${cls}；督导评估：${r.grade || "未标"}。分档依据：${why}`,
  });
}

/* ---------- 写 school_rank ---------- */
const exists = db.prepare("SELECT id FROM school_rank WHERE school_name=? AND year=? AND metric=? AND stage=?");
const ins = db.prepare(
  `INSERT INTO school_rank(school_id, school_name, stage, region, year, metric, tier, rank, score,
     source, source_url, verified, note, updated_at)
   VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?,0,?,?)`
);
const upd = db.prepare(
  `UPDATE school_rank SET region=?, tier=?, source=?, source_url=?, note=?, updated_at=?
    WHERE school_name=? AND year=? AND metric=? AND stage=?`
);

let added = 0;
let updated = 0;
for (const r of rows) {
  const hit = exists.get(r.name, r.year, METRIC, STAGE);
  if (hit) {
    upd.run(r.region, r.tier, r.source, r.source_url, r.note, now, r.name, r.year, METRIC, STAGE);
    updated++;
  } else {
    ins.run(null, r.name, STAGE, r.region, r.year, METRIC, r.tier, r.source, r.source_url, r.note, now);
    added++;
  }
}

/* ---------- 同步 school 在册表，让台账里的校名联想能选中 ---------- */
const sExists = db.prepare("SELECT id FROM school WHERE name=? AND stage=?");
const sIns = db.prepare("INSERT INTO school(place_id,name,stage,addr,lng,lat,region_id) VALUES(NULL,?,?,?,NULL,NULL,NULL)");
let sAdded = 0;
for (const r of rows) {
  if (sExists.get(r.name, STAGE)) continue;
  const addr = (r.note.match(/地址：([^；]+)/) || [])[1] || null;
  sIns.run(r.name, STAGE, addr);
  sAdded++;
}

const byTier = db
  .prepare("SELECT region, tier, COUNT(*) c FROM school_rank WHERE stage=? GROUP BY region, tier ORDER BY region, CASE tier WHEN '一梯队' THEN 1 WHEN '二梯队' THEN 2 WHEN '三梯队' THEN 3 WHEN '民办/国际' THEN 4 ELSE 5 END")
  .all(STAGE);
console.log(`幼儿园：新增 ${added}｜更新 ${updated}｜school 在册补 ${sAdded}`);
for (const r of byTier) console.log(`  ${r.region} ${r.tier} ${r.c}`);
console.log("合计", db.prepare("SELECT COUNT(*) c FROM school_rank WHERE stage=?").get(STAGE).c);
