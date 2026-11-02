// 把「家长整理的通州/大兴初中梯队表」录入 school_rank（2026 口径，未核实）
// 规则：只录初中（stage=中学）；表内学校按梯队；表外在册学校统一归「其他梯队」。
// 幂等：按 (school_name, year, metric) 判重，已存在则跳过。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "..", "data", "luohu.db");
const db = new DatabaseSync(DB);
const cols = db.prepare("PRAGMA table_info(school_rank)").all().map((c) => c.name);
if (!cols.includes("tier")) db.exec("ALTER TABLE school_rank ADD COLUMN tier TEXT");

const YEAR = 2026;
const STAGE = "中学";
const METRIC = "综合";
const SRC = "家长整理梯队表（本地录入，非官方）";
const URL_TZ = "https://www.xschu.com/zhengcezixun/83428.html";
const URL_DX = "https://www.xschu.com/zhengcezixun/82822.html";

// [在册 id | null, 写入校名, 梯队, 备注, 来源链接]
const rows = [
  // ── 通州 ──
  [5159, "北京市通州区潞河中学", "一梯队", "含于家务校区", URL_TZ],
  [5153, "北京市通州区运河中学初中部", "一梯队", "高中部单列；家长表中与潞河同档，但 2025 统招区排在 1000–2000 段，与潞河(792)、人大附通州(737)有断层", URL_TZ],
  [5460, "人大附中通州校区", "一梯队", "2025 统招区排 737（平均 1064）", URL_TZ],
  [5217, "首都师范大学附属中学（通州校区）", "二梯队", "家长另标注为「强加工校」，称 2026 中考前 500 名占全区约 10.4%；学区网口径也列二梯度", URL_TZ],
  [5646, "北京市第二中学通州校区", "二梯队", "", URL_TZ],
  [5696, "北京理工大学附属中学通州校区", "二梯队", "家长表中列二梯队，但 2025 统招位次落在兜底段——梯度是热度，不是录取位次", URL_TZ],
  [5392, "北京市育才学校通州分校", "二梯队", "", URL_TZ],
  [5459, "北京市通州区第二中学", "二梯队", "", URL_TZ],
  [5690, "北京市通州区玉桥中学", "三梯队", "", URL_TZ],
  [5393, "北京市通州区第四中学", "三梯队", "", URL_TZ],
  [5454, "北京市通州区第六中学", "三梯队", "", URL_TZ],
  [5456, "北京市通州区梨园学校", "三梯队", "家长表写「梨园中学」", URL_TZ],
  [5645, "北京市通州区张家湾中学", "三梯队", "", URL_TZ],
  [5695, "北京市通州区永乐店中学", "三梯队", "", URL_TZ],
  [5107, "北京市十一学校通州实验学校", "三梯队", "家长表写「十一实验」，即宋庄中学（校址宋庄镇政府路18号）", URL_TZ],
  [null, "北京五中通州分校", "三梯队", "在册学校表未收录，需补坐标", URL_TZ],
  [null, "北京市私立树人学校", "民办/国际", "民办，在册表未收录", URL_TZ],
  [null, "北京中加学校", "民办/国际", "民办，在册表未收录", URL_TZ],
  [null, "北京市通州区华仁学校", "民办/国际", "民办，在册表未收录", URL_TZ],
  [null, "北京德闳学校", "民办/国际", "民办，在册表未收录", URL_TZ],

  // ── 大兴（含经开区） ──
  [5140, "北京市大兴区第一中学", "一梯队", "北校区(5131)未单列", URL_DX],
  [5047, "北京市大兴区兴华中学", "一梯队", "仰山校区(5666)未单列", URL_DX],
  [5431, "北京亦庄实验中学", "一梯队", "经开区学籍；2025 统招 457 分/区排 285，一本率约 96%", URL_DX],
  [5430, "北京市大兴区第二中学（北京师范大学大兴附属中学）", "二梯队", "家长表写「北师大大兴附中」", URL_DX],
  [5563, "首都师范大学大兴附属中学", "二梯队", "另有首师附中大兴南校区(5567)、北校区(5568)，未单列", URL_DX],
  [5564, "北京市大兴区第三中学(高中部)", "二梯队", "", URL_DX],
  [5320, "北京建筑大学附属中学", "二梯队", "即原大兴五中，2026 已改名", URL_DX],
  [5427, "北京市大兴区第七中学（西校区）", "二梯队", "东校区(5557)未单列", URL_DX],
  [5562, "北京市大兴区永华实验学校", "三梯队", "", URL_DX],
  [5560, "北京景山学校大兴实验学校", "三梯队", "", URL_DX],
  [5167, "北京市大兴区兴海学校", "三梯队", "", URL_DX],
  [5057, "北京市大兴区德茂中学", "三梯队", "", URL_DX],
  [null, "人大附中北京经济技术开发区学校", "二梯队", "家长表写「人大附经开学校」；在册表未收录", URL_DX],
  [null, "十一分", "二梯队", "家长表原样写「十一分」，指哪一所待确认（疑为十一学校经开区分校）", URL_DX],
  [null, "清华附中大兴学校", "三梯队", "在册表未收录", URL_DX],
  [null, "大兴区实验学校", "三梯队", "校名待确认（疑为国家教育行政学院附属实验学校 5561 或北京第二实验小学大兴实验学校）", URL_DX],
  [null, "君谊中学", "民办/国际", "民办，在册表未收录", URL_DX],
  [null, "中芯学校", "民办/国际", "民办，在册表未收录", URL_DX],
  [null, "金融街润泽学校", "民办/国际", "民办，在册表未收录", URL_DX],
  [null, "耀华亦庄", "民办/国际", "民办，在册表未收录", URL_DX],
];

const insert = db.prepare(
  `INSERT INTO school_rank(school_id, school_name, stage, year, metric, tier, rank, score,
     source, source_url, verified, note, updated_at)
   VALUES(?,?,?,?,?,?,NULL,NULL,?,?,0,?,?)`
);
const exists = db.prepare("SELECT id FROM school_rank WHERE school_name=? AND year=? AND metric=?");
const now = new Date().toISOString().replace("T", " ").slice(0, 19);

let added = 0, skipped = 0;
const mappedIds = new Set();
for (const [sid, name, tier, note, url] of rows) {
  if (sid) mappedIds.add(sid);
  if (exists.get(name, YEAR, METRIC)) { skipped++; continue; }
  insert.run(sid, name, STAGE, YEAR, METRIC, tier, SRC, url, note || null, now);
  added++;
}

// ── 表外在册初中 → 其他梯队 ──
const inRegion = db
  .prepare(
    `SELECT id, name, addr FROM school
      WHERE stage='中学'
        AND (addr LIKE '%通州区%' OR addr LIKE '%大兴区%' OR addr LIKE '%经济技术开发区%')`
  )
  .all();
const skipName = /职业|培智|研修|国际部|音乐|特殊教育/;
let others = 0;
for (const s of inRegion) {
  if (mappedIds.has(s.id)) continue;
  if (skipName.test(s.name)) continue;
  if (exists.get(s.name, YEAR, METRIC)) continue;
  const url = s.addr.includes("通州区") ? URL_TZ : URL_DX;
  insert.run(s.id, s.name, STAGE, YEAR, METRIC, "其他梯队", SRC, url, "未列入家长梯队表，暂归其他梯队", now);
  others++;
}

// ── 通州高中 2026 统招录取（学小升初网 87997，2026-08-06）──
// 与初中那批用 metric 区分：这里 metric=区排名，rank=区排、score=录取分
const HS_METRIC = "区排名";
const SRC_HS = "北京小升初网 中考各校录取分数线+区排名（2027 参考）";
const URL_HS = "https://www.xschu.com/zhengcezixun/87997.html";
const URL_HS_DX = "https://www.xschu.com/zhengcezixun/88011.html";
const hs = [
  [5217, "首都师范大学附属中学（通州校区）", "一梯队", 665, 470, "2026 统招 470 分/区排 665，通州统招最高；2025 为 470/541（位次前移 124）"],
  [5460, "人大附中通州校区", "一梯队", 948, 465, "2026 统招 465/948；2025 为 466/737（位次后移 211）"],
  [5153, "北京市通州区运河中学初中部", "一梯队", 1263, 460, "2026 统招 460/1263；2025 为 458/1190"],
  [null, "首师大附中通州实验学校", "二梯队", 1791, 453, "2026 首次有统招数据 453/1791，在册学校表未收录；与「首师附中通州校区」是两所校"],
  [null, "北京五中通州校区", "三梯队", 2480, 444, "2026 统招 444/2480；2025 为 434/2649（位次前移 169）"],
  // ── 大兴高中 2026 统招录取（学小升初网 88011，2026-08-07）──
  [null, "北师大实验中学大兴分校", "一梯队", 175, 483, "2026 统招 483 分/区排 175，大兴统招第一；2025 为 475/151"],
  [null, "清华附中大兴学校", "二梯队", 829, 467, "2026 统招 467/829；2025 为 464/757。在册学校表未收录"],
  [null, "北京一零一中大兴分校", "二梯队", 829, 467, "2026 统招 467/829（与清华附中大兴并列）；2025 为 463/809。在册表未收录"],
];
let hsAdded = 0;
for (const [sid, name, tier, rank, score, note] of hs) {
  if (exists.get(name, YEAR, HS_METRIC)) continue;
  const url = name.includes("大兴") ? URL_HS_DX : URL_HS;
  db.prepare(
    `INSERT INTO school_rank(school_id, school_name, stage, year, metric, tier, rank, score,
       source, source_url, verified, note, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)`
  ).run(sid, name, STAGE, YEAR, HS_METRIC, tier, rank, score, SRC_HS, url, note, now);
  hsAdded++;
}

// ── 用新高中的数据回填梯队行的备注 ──
const patchNote = db.prepare("UPDATE school_rank SET note=?, updated_at=? WHERE school_name=? AND year=? AND metric=?");
const patches = [
  ["首都师范大学附属中学（通州校区）", "家长标注「强加工校、前 500 名占全区约 10.4%」，2026 统招 470 分/区排 665 位列通州第一，数据支持该说法；学区网仍列二梯度属滞后"],
  ["人大附中通州校区", "2026 统招 465/948，2025 466/737，位次后移 211"],
  ["北京市通州区运河中学初中部", "高中部单列；2026 统招 460/1263，低于首师附通州(665)与人大附通州(948)，但与潞河同为老牌"],
  ["北京市通州区第二中学", "2025 校额到校 166 个名额（11 所高中），属全区最大一档，反映毕业生盘子大"],
];
for (const [name, note] of patches) patchNote.run(note, now, name, YEAR, METRIC);

const byTier = db
  .prepare("SELECT tier, COUNT(*) c FROM school_rank WHERE year=? AND stage=? GROUP BY tier ORDER BY c DESC")
  .all(YEAR, STAGE);
console.log(`表内新增 ${added}｜跳过重复 ${skipped}｜其他梯队新增 ${others}｜高中统招新增 ${hsAdded}`);

console.log("梯队分布：", byTier.map((r) => `${r.tier} ${r.c}`).join(" · "));
