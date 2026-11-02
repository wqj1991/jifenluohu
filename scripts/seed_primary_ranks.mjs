// 通州 20 所小学分档入库（幂等）
// 数据来源：家长整理清单（用户 2026-11-02 提供）+《通州区教育集团校名单》xschu 87842 + 名校办分校结构
// 注意：小学没有任何官方或第三方排名，这里的 tier 是「依据可核事实推出的档位」，verified=0
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/luohu.db");
const now = new Date().toISOString();
const YEAR = 2026;
const STAGE = "小学";
const METRIC = "综合";
const SRC = "家长清单 + 通州区教育集团名单（学小升初网 87842）+ 名校分校结构，推断档位";
const URL_GROUP = "https://www.xschu.com/zhengcezixun/87842.html";

// [school_id|null, 校名, 梯队, 集团归属, 依据/备注]
const rows = [
  [4575, "北京市史家小学通州分校", "一梯队", "未列入通州 12 集团（东城史家独立分校）", "东城史家小学办的分校，玉桥东小区；通州口碑最强的外来分校之一。代管大杜社校区(4936)"],
  [4864, "北京小学通州分校", "一梯队", "北京市第二中学通州校区教育集团", "西城北京小学分校，芙蓉园313号；集团内可通二中通州校区"],
  [3879, "北京第二实验小学通州分校", "一梯队", "未列入通州 12 集团", "西城实验二小分校，砖厂北里39号；独立办学"],
  [4813, "北京教育科学研究院通州区第一实验小学", "一梯队", "未列入通州 12 集团", "市级教科院直属实验校，梨园刘老村西；教研资源强"],
  [4429, "北京市通州区运河小学", "一梯队", "未见列入集团名单", "运河西大街246号，通州老牌第一梯队区属校；另有温榆/宋庄富豪校区(4928)"],
  [3829, "北京市通州区后南仓小学", "一梯队", "后南仓小学教育集团（龙头，新成立）", "新仓路53号；自有教育集团，含紫运、北苑两校区"],
  [4569, "北京市育才学校通州分校", "二梯队", "潞河中学教育集团（含其中学部）", "西城育才学校分校，梨园群芳中二街3号；小学+中学一体"],
  [4585, "北京市通州区官园小学", "二梯队", "首都师范大学附属中学通州校区教育集团", "新仓路29号；集团内可通首师附中通州（2026 统招全区第一）"],
  [3800, "北京市通州区中山街小学", "二梯队", "首师大附中通州校区教育集团", "新华西街16号；另有永乐店分校(4865)、永顺校区(4879)"],
  [4933, "北京市通州区贡院小学", "二梯队", "首师大附中通州校区教育集团", "新华大街西海子西路；另有徐辛庄校区(4577)"],
  [4026, "北京市通州区东方小学", "二梯队", "未列入通州 12 集团", "西顺城街甲32号，老城区属校"],
  [4571, "北京市通州区玉桥小学", "二梯队", "未列入通州 12 集团", "玉桥东路1号；玉桥中学在人大附中通州校区集团，小学本身未入列。另有乔庄东校区(4874)"],
  [4868, "北京市通州区芙蓉小学", "二梯队", "北京市第二中学通州校区教育集团", "通胡大街70号；另有焦王庄校区(4432)"],
  [4572, "北京市通州区北苑小学", "二梯队", "后南仓小学教育集团（北苑校区）", "北苑南路22号；与后南仓小学同法人、共享师资，档位可视为与本部同级"],
  [3884, "北京市通州区临河里小学", "三梯队", "未列入通州 12 集团", "临河里58号，梨园/临河里片区规模校，口碑中等"],
  [4422, "北京市通州区梨园镇中心小学", "三梯队", "未列入通州 12 集团", "群芳中一街；梨园镇中心校，非城区老牌"],
  [4003, "北京市通州区民族小学", "三梯队", "未列入通州 12 集团", "回民胡同47号，老城区属普通校"],
  [4872, "北京市通州区宋庄镇北寺庄小学", "三梯队", "未列入通州 12 集团", "宋庄镇北寺庄村，乡镇完小；同址另有新城职业学校宋庄校区(4938)"],
  [null, "北京市通州区东关小学", "三梯队", "未列入通州 12 集团", "东关一带老城区属校；在册学校表缺此校，school_id 待补"],
  [null, "北京市私立树人·瑞贝学校", "民办/国际", "民办", "通州宋庄民办校（树人学校体系）；在册学校表缺此校，school_id 待补"],
];

const exists = db.prepare("SELECT id FROM school_rank WHERE school_name=? AND year=? AND metric=? AND stage=?");
const ins = db.prepare(
  `INSERT INTO school_rank(school_id, school_name, stage, year, metric, tier, rank, score,
     source, source_url, verified, note, updated_at)
   VALUES(?,?,?,?,?,?,NULL,NULL,?,?,0,?,?)`
);
const upd = db.prepare("UPDATE school_rank SET school_id=?, tier=?, note=?, updated_at=? WHERE school_name=? AND year=? AND metric=? AND stage=?");

let added = 0;
let updated = 0;
for (const [sid, name, tier, grp, note] of rows) {
  const full = `集团：${grp}。${note}`;
  if (exists.get(name, YEAR, METRIC, STAGE)) {
    upd.run(sid, tier, full, now, name, YEAR, METRIC, STAGE);
    updated++;
  } else {
    ins.run(sid, name, STAGE, YEAR, METRIC, tier, SRC, URL_GROUP, full, now);
    added++;
  }
}

// 顺带补 4 所用户清单漏掉、但按任何口径都该在册的城区名校血统小学 —— 只登记在其他梯队，等用户定档
const extra = [
  [4424, "北京黄城根小学（通州校区）", "西城黄城根小学分校，潞城镇胡各庄村（原胡各庄小学）"],
  [4810, "北京市通州区潞河中学附属学校", "潞河中学教育集团直系附属校，梨园半壁店大街23号；另有次渠家园校区(4877)"],
  [4811, "北京市通州区教师研修中心实验学校", "北京学校教育集团，东关顾家坡1号；十二年一贯"],
  [4927, "北京市通州区南关小学", "东营后街9号，老城区属校"],
];
let extraAdded = 0;
for (const [sid, name, note] of extra) {
  if (exists.get(name, YEAR, METRIC, STAGE)) continue;
  ins.run(sid, name, STAGE, YEAR, METRIC, "其他梯队", SRC, URL_GROUP,
    `未在家长清单内，暂归其他梯队待定档。${note}`, now);
  extraAdded++;
}

// 修复：2026-11-02 首跑时 exists 未按 stage 隔离，误把小学档位写进了中学那条「育才学校通州分校」
db.prepare(
  `UPDATE school_rank SET school_id=5392, tier='二梯队',
     note='用户梯队表：二梯队（北京市育才学校通州分校，梨园群芳中二街3号，小学+中学一体）', updated_at=?
   WHERE school_name='北京市育才学校通州分校' AND year=? AND metric=? AND stage='中学'`
).run(now, YEAR, "综合");

const byTier = db.prepare(
  "SELECT COALESCE(tier,'未分档') t, COUNT(*) c FROM school_rank WHERE stage=? GROUP BY t ORDER BY c DESC"
).all(STAGE);
console.log(`小学新增 ${added}｜更新 ${updated}｜清单外补充 ${extraAdded}`);
console.log("小学梯队分布：", byTier.map((r) => `${r.t} ${r.c}`).join(" · "));
