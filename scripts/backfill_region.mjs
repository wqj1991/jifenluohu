// 给 school_rank 回填区域：通州 / 大兴 / 经开（经开区独立招生单位，不与大兴混）
// 有 school_id 的按 school.addr 反推；手填校名（school_id 为空）的按下表指定
import { DatabaseSync } from "node:sqlite";
import { ensureMaintTables, regionOfAddr } from "../server/maint.mjs";

const db = new DatabaseSync("data/luohu.db");
ensureMaintTables(db); // 顺带补齐 region 列（幂等）

// school_id 为空的 22 条，逐条标区域（依据：校址所属行政区/功能区，见各自 note）
const MANUAL = {
  通州: ["北京五中通州分校", "北京五中通州校区", "首师大附中通州实验学校", "北京市私立树人学校", "北京市通州区华仁学校",
    "北京德闳学校", "北京中加学校", "北京市通州区东关小学", "北京市私立树人·瑞贝学校"],
  大兴: ["北师大实验中学大兴分校", "清华附中大兴学校", "大兴区实验学校", "北京一零一中大兴分校",
    "君谊中学", "北京市大兴区瀛海镇第二中心小学", "北京新世纪双语实验学校"],
  经开: ["人大附中北京经济技术开发区学校", "十一分", "中芯学校", "金融街润泽学校", "耀华亦庄"],
};

let byAddr = 0;
const upd = db.prepare("UPDATE school_rank SET region=? WHERE school_id=? AND (region IS NULL OR region='')");
for (const s of db.prepare("SELECT id, addr FROM school").all()) {
  const r = regionOfAddr(s.addr);
  if (r) byAddr += Number(upd.run(r, s.id).changes || 0);
}

let byName = 0;
const updName = db.prepare("UPDATE school_rank SET region=? WHERE school_name=? AND school_id IS NULL");
for (const [region, names] of Object.entries(MANUAL)) {
  for (const n of names) byName += Number(updName.run(region, n).changes || 0);
}

const left = db.prepare("SELECT COUNT(*) c FROM school_rank WHERE region IS NULL").get().c;
const dist = db.prepare("SELECT COALESCE(region,'未分区') r, COUNT(*) c FROM school_rank GROUP BY r ORDER BY c DESC").all();
console.log(`按地址回填 ${byAddr}｜按校名回填 ${byName}｜仍未分区 ${left}`);
console.log(dist.map((d) => `${d.r} ${d.c}`).join(" · "));
