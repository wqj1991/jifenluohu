// 贝壳（bj.ke.com）切片抓取：用法 node scripts/fc/ke.mjs <xiaoqu|ershoufang> <daxing|tongzhou>
// 结论依据：分页 /pgN/ 一律 302，但 商圈 / 价格档 / 户型 / 排序 全部 200
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DELAY = Number(process.env.DELAY || 3500);

const cookieArr = JSON.parse(fs.readFileSync(path.join(ROOT, "data/lianjia.cookie"), "utf8"));
const COOKIE = cookieArr.map((c) => `${c.name}=${c.value}`).join("; ");

async function grab(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const { stdout } = await exec(
        "curl",
        [
          "-s", "--compressed", "-m", "30",
          "-A", UA,
          "-H", `Cookie: ${COOKIE}`,
          "-H", "Accept-Language: zh-CN,zh;q=0.9",
          "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "-H", "Referer: https://bj.ke.com/",
          "-w", "\n@@STATUS:%{http_code}",
          url,
        ],
        { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }
      );
      const m = stdout.match(/\n@@STATUS:(\d+)$/);
      const status = m ? Number(m[1]) : 0;
      const html = stdout.slice(0, m ? m.index : undefined);
      return { status, html };
    } catch (e) {
      if (i === 2) return { status: -1, html: "", err: String(e).slice(0, 200) };
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

const clean = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// ---------- 小区列表页解析 ----------
export function parseXiaoqu(html, district) {
  const out = [];
  const parts = html.split(/<li class="[^"]*xiaoquListItem/).slice(1);
  for (const p of parts) {
    const id = (p.match(/data-id="(\d+)"/) || [])[1];
    const name = clean((p.match(/<a class="maidian-detail"[^>]*title="([^"]*)"/) || [])[1]);
    const price = (p.match(/class="totalPrice"><span>([\d.]+)<\/span>/) || [])[1];
    const priceDesc = clean((p.match(/class="priceDesc">([^<]*)</) || [])[1]);
    const sell = (p.match(/class="totalSellCount"[^>]*><span>(\d+)<\/span>/) || [])[1];
    const districtRaw = clean((p.match(/class="district"[^>]*>([^<]*)</) || [])[1]);
    const biz = clean((p.match(/class="bizcircle"[^>]*>([^<]*)</) || [])[1]);
    const year = (p.match(/(\d{4})年/) || [])[1];
    const deal30 = (p.match(/(\d+)天成交\d+套/) || [])[0];
    if (!id || !name) continue;
    out.push({
      id, name, district,
      district_raw: districtRaw || null,
      bizcircle: biz || null,
      price: price ? Number(price) : null,
      price_desc: priceDesc || null,
      sell_count: sell ? Number(sell) : null,
      build_year: year ? Number(year) : null,
      deal30: deal30 || null,
      url: `https://bj.ke.com/xiaoqu/${id}/`,
      source: "ke",
    });
  }
  return out;
}

// ---------- 二手房列表页解析 ----------
export function parseErshou(html, district, ctxBiz = null) {
  const out = [];
  const parts = html.split(/<li class="clear"/).slice(1);
  for (const p of parts) {
    const url = (p.match(/href="(https:\/\/bj\.ke\.com\/ershoufang\/(\d+)\.html)"/) || [])[1];
    const id = (p.match(/href="https:\/\/bj\.ke\.com\/ershoufang\/(\d+)\.html"/) || [])[1];
    const title = clean((p.match(/<div class="title">\s*<a[^>]*>([^<]*)</) || [])[1]);
    const houseInfo = clean((p.match(/<div class="houseInfo">([\s\S]*?)<\/div>/) || [])[1]);
    const pos = clean((p.match(/<div class="positionInfo">([\s\S]*?)<\/div>/) || [])[1]);
    const community = clean((p.match(/<div class="positionInfo">[\s\S]*?<a[^>]*>([^<]*)<\/a>/) || [])[1]);
    const total = (p.match(/class="totalPrice[^"]*"[\s\S]*?<span[^>]*>\s*([\d.]+)\s*<\/span>/) || [])[1];
    const unit = (p.match(/class="unitPrice"[^>]*>[\s\S]*?<span>([\d,]+)元\/平/) || [])[1];
    const follow = clean((p.match(/<div class="followInfo">([\s\S]*?)<\/div>/) || [])[1]);
    if (!id) continue;
    const m2 = houseInfo.match(/([\d.]+)平米/);
    const rooms = houseInfo.match(/(\d)室(\d)厅/);
    out.push({
      id, district, title,
      community: community || pos.split(/\s+/)[0] || null,
      bizcircle: ctxBiz || null,
      layout: rooms ? `${rooms[1]}室${rooms[2]}厅` : null,
      area: m2 ? Number(m2[1]) : null,
      total_price: total ? Number(total) : null,
      unit_price: unit ? Number(unit.replace(/,/g, "")) : null,
      house_info: houseInfo || null,
      follow: follow || null,
      url, source: "ke",
    });
  }
  return out;
}

// ---------- 主流程 ----------
const DISTRICTS = {
  daxing: {
    slug: "daxingqu",
    name: "大兴区",
    biz: ["huangcunzhong", "huangcunhuochezhan", "gaomidian", "zaoyuan", "jiugong1", "xihongmen", "yinghai", "tiangongyuan", "tiangongyuannan", "yihezhuang", "guanyinsi", "kejiyuanqu", "yizhuang1", "yizhuanghexiqu", "yizhuangkaifaquqita1", "daxingjichangkonggang", "daxingxinjichang", "daxingxinjichangyangfangbieshuqu", "nanzhongzhoujichangshangwuqu", "daxingqita11"],
  },
  tongzhou: {
    slug: "tongzhouqu1",
    name: "通州区",
    biz: ["beiguan", "tongzhoubeiyuan", "guoyuan1", "jiukeshu12", "liyuan", "linheli", "yuqiao", "luyuan", "wuyihuayuan", "wanda14", "qiaozhuang", "majuqiao1", "tongzhouqita11"],
  },
};

const BIZ_NAMES = {
  huangcunzhong: "黄村中", huangcunhuochezhan: "黄村火车站", gaomidian: "高米店", zaoyuan: "枣园",
  jiugong1: "旧宫", xihongmen: "西红门", yinghai: "瀛海", tiangongyuan: "天宫院",
  tiangongyuannan: "天宫院南", yihezhuang: "义和庄", guanyinsi: "观音寺", kejiyuanqu: "科技园区",
  yizhuang1: "亦庄", yizhuanghexiqu: "亦庄河西区", yizhuangkaifaquqita1: "亦庄开发区其它",
  daxingjichangkonggang: "大兴机场空港", daxingxinjichang: "大兴新机场",
  daxingxinjichangyangfangbieshuqu: "大兴新机场洋房别墅区",
  nanzhongzhoujichangshangwuqu: "南中轴机场商务区", daxingqita11: "大兴其它",
  beiguan: "北关", tongzhoubeiyuan: "通州北苑", guoyuan1: "果园", jiukeshu12: "九棵树",
  liyuan: "梨园", linheli: "临河里", yuqiao: "玉桥", luyuan: "潞苑", wuyihuayuan: "武夷花园",
  wanda14: "万达", qiaozhuang: "乔庄", majuqiao1: "马驹桥", tongzhouqita11: "通州其它",
};

const mode = process.argv[2] || "xiaoqu"; // xiaoqu | ershoufang
const which = process.argv[3] || "daxing";
const cfg = DISTRICTS[which];

const log = [];
const rows = [];
const seen = new Set();
let pages = 0, ok = 0, blocked = 0;

// 第一页用区县页，剩下按商圈切片
const targets = [
  `https://bj.ke.com/${mode}/${cfg.slug}/`,
  ...cfg.biz.map((b) => `https://bj.ke.com/${mode}/${b}/`),
];

for (const url of targets) {
  const { status, html, err } = await grab(url);
  pages++;
  if (status !== 200) {
    blocked++;
    log.push({ url, status, err: err || null });
    await new Promise((r) => setTimeout(r, DELAY));
    continue;
  }
  let ctxBiz = null;
  for (const [slug, nm] of Object.entries(BIZ_NAMES)) if (url.includes(`/${slug}/`)) ctxBiz = nm;
  const parsed = mode === "xiaoqu" ? parseXiaoqu(html, cfg.name) : parseErshou(html, cfg.name, ctxBiz);
  let added = 0;
  for (const r of parsed) {
    // 硬过滤外区污染：小区页看 district_raw，房源页看 id 前缀无法判定，交给后续
    if (mode === "xiaoqu" && r.district_raw && !/大兴|通州|经济技术开发/.test(r.district_raw)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push(r);
    added++;
  }
  ok++;
  console.log(`[${pages}/${targets.length}] ${status} +${added} (total ${rows.length})  ${url}`);
  await new Promise((r) => setTimeout(r, DELAY));
}

const outFile = path.join(ROOT, `data/ke_${mode}_${which}.json`);
fs.writeFileSync(outFile, JSON.stringify(rows, null, 1), "utf8");
console.log(JSON.stringify({ mode, which, pages, ok, blocked, rows: rows.length, outFile, failures: log }, null, 1));
