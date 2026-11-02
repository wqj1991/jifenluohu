// 大兴 10 所小学分档入库（幂等）
// 来源：家长清单（用户 2026-11-02）+《大兴区教育集团校名单》xschu 87845 + 名校办分校结构 + 大兴 2026 高中统招线
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/luohu.db");
const now = new Date().toISOString();
const YEAR = 2026;
const STAGE = "小学";
const METRIC = "综合";
const SRC = "家长清单 + 大兴区教育集团名单（学小升初网 87845）+ 名校分校结构，推断档位";
const URL_GROUP = "https://www.xschu.com/zhengcezixun/87845.html";

// [school_id|null, 校名, 梯队, 集团归属, 依据/备注]
const rows = [
  [4912, "北京小学大兴分校", "一梯队", "大兴一中教育集团成员 + 清城小学教育集团龙头", "西城北京小学分校，黄村镇兴业路（清城）；双集团身份，另有亦庄学校(4030)为清城集团成员"],
  [3838, "北京景山学校大兴实验学校", "一梯队", "兴华教育集团", "东城景山学校办，双高路1号；九年一贯，本校有中学部(5560)可直升"],
  [4950, "首都师范大学附属中学大兴北校区", "一梯队", "未见列入大兴集团名单（名单只列了南校区）", "首师附中直系校区，黄村镇兴和街10号；小学(4950)+中学(5668)同址，一贯制。集团名单口径缺北校区"],
  [4615, "北京师范大学附属大兴实验学校（北京师范大学大兴附属小学）", "一梯队", "未列入大兴集团名单", "北师大附属实验学校小学部，黄村镇香园路香海园小区；一贯制"],
  [4915, "北京市大兴区第二小学", "一梯队", "兴华教育集团成员 + 大兴二小教育集团龙头", "黄村镇永华北里；大兴老牌区属第一，自有教育集团（含黄村镇二中心、青云店一/二中心）"],
  [4610, "北京市大兴区第九小学", "二梯队", "未列入大兴集团名单", "黄村镇清源西里小区；老牌区属校，口碑中上但无中学出口"],
  [4957, "北京市大兴区滨河小学", "二梯队", "北京第四实验学校教育集团（龙头=北师大实验中学大兴分校）", "滨河西里；集团龙头 2026 大兴统招第一（483分/区排175），有明确升学通道"],
  [4454, "北京市大兴区团河小学", "三梯队", "未列入大兴集团名单", "团河苑小区；黄村外围普通完小"],
  [null, "北京市大兴区瀛海镇第二中心小学", "三梯队", "未列入大兴集团名单", "瀛海镇乡镇中心校；在册只有第一中心小学(4602)，第二中心缺条目，school_id 待补"],
  [null, "北京新世纪双语实验学校", "民办/国际", "民办", "大兴民办校；在册无此校（3846 是西城新世纪实验小学，非本校），school_id 待补"],
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

const byTier = db.prepare(
  "SELECT COALESCE(tier,'未分档') t, COUNT(*) c FROM school_rank WHERE stage=? GROUP BY t"
).all(STAGE);
console.log(`小学新增 ${added}｜更新 ${updated}`);
console.log("小学梯队分布：", byTier.map((r) => `${r.t} ${r.c}`).join(" · "));
