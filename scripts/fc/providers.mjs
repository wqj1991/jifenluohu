// 房产站点适配器：URL 模板、抓取通道、解析器
// 通道（2026-11 实测）：
//   firecrawl —— Firecrawl 云端出口，实测全部落在 US/JP，链家/贝壳/我爱我家/安居客 一律被拦
//   direct    —— 本机出口（住宅 IP）+ 可选登录 Cookie；链家/贝壳 只吃登录墙，带 Cookie 可直取
export const DISTRICTS = {
  // m5i5j：移动站区级路径 slug，必须带 "qu" 后缀（tongzhouqu）。
  // 实测 /bj/xiaoqu/tongzhou/ 不会 404，而是静默回落成「全北京推荐」列表：
  // 200 + 有数据 + 区域全混，是最容易误采的坑。
  tongzhou: { name: "通州", pinyin: "tongzhou", m5i5j: "tongzhouqu" },
  daxing: { name: "大兴", pinyin: "daxing", m5i5j: "daxingqu" },
};

const num = (s) => {
  const n = Number(String(s ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const NAME_BLACKLIST = /^(更多|查看|全部|详情|地图|小区|二手房|租房|登录|注册|首页|下一页|上一页|\d+)$/;

// ---------- markdown 解析（Firecrawl 通道） ----------
/** 按「小区链接块」切分 markdown，兼容链家 / 贝壳 / 我爱我家 */
function parseByLinks(md, { idRe, baseUrl, source }) {
  const rows = [];
  const linkRe = new RegExp(`\\[([^\\]]{2,40})\\]\\((${idRe})\\)`, "g");
  const hits = [...md.matchAll(linkRe)];
  for (let i = 0; i < hits.length; i++) {
    const [, name, href] = hits[i];
    if (NAME_BLACKLIST.test(name.trim())) continue;
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : Math.min(md.length, start + 900);
    const block = md.slice(start, end);
    const idMatch = new RegExp(idRe).exec(href);
    if (!idMatch) continue;
    rows.push({
      id: idMatch[1],
      name: name.trim(),
      price: num(/(\d{3,6})\s*元\s*\/?\s*[平㎡]/.exec(block)?.[1]),
      online: num(/(\d{1,5})\s*套在售/.exec(block)?.[1]),
      build_year: num(/((?:19|20)\d{2})\s*年建/.exec(block)?.[1]),
      bizcircle: null,
      url: href.startsWith("http") ? href : new URL(href, baseUrl).toString(),
      source,
    });
  }
  return rows;
}

// ---------- HTML 解析（本机直连通道） ----------
/**
 * 链家 / 贝壳 PC 列表：<li class="xiaoquListItem"> 块，每块内有
 *   .title a[href=/xiaoqu/ID/] 名字
 *   .totalPrice 挂牌均价      N套在售      YYYY年建
 */
/**
 * 链家/贝壳小区列表页（2026-11 版结构）：
 *   <div class="title"><a href=".../xiaoqu/{id}/">小区名</a></div>
 *   <div class="houseInfo">共621个户型 | 30天成交0套 | 14套正在出租</div>
 *   <div class="positionInfo">
 *     <a class="district">通州区</a> <a class="bizcircle">万达</a>
 *     /塔楼/板楼/塔板结合 / 2012-2016年
 *   </div>
 *   <div class="totalPrice"><span>54999</span>元/m<sup>2</sup></div>
 *   <div class="priceDesc">10月二手房参考均价</div>
 *   <div class="totalSellCount"><span>44</span>套</div>
 * 旧版是「N套在售 / YYYY年建」文案，一并留着兜底。
 */
function parseLianjiaHtml(html, baseUrl, source) {
  const rows = [];
  // 按 <li class="xiaoquListItem"> 的起始位置切块，块边界 = 下一个 li。
  // 不能用 split + 固定长度：块切长了会把下一条的 bizcircle/price 串进来，
  // 切短了会丢掉末尾的价格区（曾导致 price 只有 73%、商圈数虚高到 73 个）。
  const starts = [];
  {
    const rx = /<li[^>]*class="[^"]*xiaoquListItem[^"]*"/gi;
    let mm;
    while ((mm = rx.exec(html))) starts.push(mm.index);
  }
  const blocks = starts.map((s, i) => {
    if (i + 1 < starts.length) return html.slice(s, starts[i + 1]);
    const end = html.indexOf("</ul>", s);
    return html.slice(s, end > s ? end : Math.min(html.length, s + 12000));
  });
  for (const block of blocks) {
    const a =
      /<div class="title">\s*<a[^>]+href="([^"]*\/xiaoqu\/(\d{5,})\/?)"[^>]*>([^<]{2,40})<\/a>/i.exec(block) ??
      /<a[^>]+href="([^"]*\/xiaoqu\/(\d{5,})\/?)"[^>]*>([^<]{2,40})<\/a>/i.exec(block);
    if (!a) continue;
    const name = a[3].trim();
    if (NAME_BLACKLIST.test(name)) continue;

    const pos = /class="positionInfo"[\s\S]{0,600}?<\/div>/i.exec(block)?.[0] ?? "";
    // 建成年：2026 版是「2012-2016年」（区间取起始年），旧版是「2012年建」
    const yearRange = /((?:19|20)\d{2})\s*(?:-\s*((?:19|20)\d{2}))?\s*年/.exec(pos);
    const buildYear =
      num(yearRange?.[1]) ?? num(/((?:19|20)\d{2})\s*年建/.exec(block)?.[1]);

    rows.push({
      id: a[2],
      name,
      price:
        num(/class="totalPrice"[^>]*>\s*<span>\s*(\d{3,6})\s*</i.exec(block)?.[1]) ??
        num(/class="totalPrice"[^>]*>[\s\S]{0,120}?>(\d{3,6})</.exec(block)?.[1]) ??
        num(/(\d{3,6})\s*元\s*\/\s*[㎡平]/.exec(block)?.[1]),
      // 2026 版：在售套数在 .totalSellCount；旧版是「N套在售」
      online:
        num(/class="totalSellCount"[^>]*>\s*<span>\s*(\d{1,5})\s*</i.exec(block)?.[1]) ??
        num(/(\d{1,5})\s*套在售/.exec(block)?.[1]),
      build_year: buildYear,
      bizcircle:
        /class="bizcircle"[^>]*>([^<]{2,12})</i.exec(block)?.[1]?.trim() ??
        [...pos.matchAll(/<a[^>]*>([^<]{2,12})<\/a>/g)].map((m) => m[1].trim())[1] ??
        null,
      district_raw: /class="district"[^>]*>([^<]{2,10})</i.exec(block)?.[1]?.trim() ?? null,
      price_desc: /class="priceDesc"[^>]*>\s*([^<]{2,30}?)\s*</i.exec(block)?.[1] ?? null,
      build_type: (() => {
        const hits = [...pos.matchAll(/(塔板结合|塔楼|板楼|平房|别墅|四合院)/g)].map((m) => m[1]);
        return hits.length ? [...new Set(hits)].join("/") : null;
      })(),
      huxing_cnt: num(/共\s*(\d{1,5})\s*个户型/.exec(block)?.[1]),
      tx_30d: num(/30天成交\s*(\d{1,5})\s*套/.exec(block)?.[1]),
      rent_cnt: num(/(\d{1,5})\s*套正在出租/.exec(block)?.[1]),
      url: new URL(a[1], baseUrl).toString(),
      source,
    });
  }
  return rows;
}

/**
 * 我爱我家小区列表（移动站 m.5i5j.com，2026-11 实测结构，免登录）：
 *   <div class="list_con">
 *     <div class="img_left"><img src=... alt="康泽佳苑南区"></div>
 *     <div class="xqimg_con">
 *       <div class="xq_gz" data-name="康泽佳苑南区" data-id="339005" data-price="22564.15" ...></div>
 *       <h2>康泽佳苑南区</h2>
 *       <p class="ting">通州潞苑 <!--注释-->
 *             / 约2013年建成  / 板楼,塔楼</p>
 *       <p class="sp_hui">在售<span class="sp_hei">91</span>套 <span class="dian_1">/</span>在租<span class="sp_hei">21</span>套</p>
 *       <p class="pricepm"><span><b>22564.15</b>元/㎡</span></p>
 *     </div>
 *     <div class="tz_a" data-href="https://m.5i5j.com/bj/xiaoqu/451976.html">
 *
 * 要点：
 *   1) 名字/id/价格以 xq_gz 的 data-* 为准（DOM 里还有隐藏的 .can_kao 参考价，别按顺序抓第一个 <b>）；
 *   2) ting 里「区域+商圈」之间**没有分隔符**（"通州潞苑"、"通州九棵树(家乐福)"），
 *      只能拿区名前缀切：命中已知区名就切，切不出就把整串留在 bizcircle；
 *   3) 注释节点里混着「建成年代优化」「楼型」等字样，先剥注释再解析。
 */
function parse5i5jHtml(html, baseUrl, source, districtName = null) {
  const rows = [];
  const KNOWN_DISTRICTS = ["通州", "大兴", "朝阳", "海淀", "丰台", "石景山", "东城", "西城", "昌平", "房山", "顺义", "门头沟", "怀柔", "密云", "平谷", "延庆"];
  // 按 <li> 切块：data-href 写在 li 开头、list_con 在其后。
  // 若按 list_con 切，href 会被切入下一条的块里 —— 实测导致 id 与小区名整体错位一格
  // （珠江逸景家园拿到金隅自由筑的 id），且不会报错，只能靠比对详情页 title 才发现。
  const lis = String(html).match(/<li[^>]*>[\s\S]*?<\/li>/gi) ?? [];
  const items = lis.filter((b) => b.includes('class="list_con"'));
  for (const chunk of items) {
    const block = chunk.slice(0, 4000);
    const gz = /<div class="xq_gz[^"]*"([^>]*)>/i.exec(block)?.[1] ?? "";
    const attr = (k) => new RegExp(`${k}="([^"]*)"`).exec(gz)?.[1] ?? null;
    const name = (attr("data-name") ?? /<h2>([^<]{2,40})<\/h2>/i.exec(block)?.[1] ?? "").trim();
    if (!name || NAME_BLACKLIST.test(name)) continue;
    const href =
      /data-href="([^"]*\/xiaoqu\/(\d{4,})\.html)"/i.exec(block) ??
      /href="([^"]*\/xiaoqu\/(\d{4,})\.html)"/i.exec(block);
    // id 以详情页 URL 里的为准：xq_gz 的 data-id 是站内关注用的另一套 id
    // （样本里 data-id=339005 而详情页是 451976），拿它拼 URL 会全部 404。
    const id = href?.[2] ?? /communityid_var"\s*:\s*"?(\d+)/.exec(block)?.[1] ?? attr("data-id") ?? null;
    if (!id) continue;

    const ting = (/<p class="ting">([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const parts = ting.split("/").map((x) => x.trim()).filter(Boolean);
    const areaRaw = parts[0] ?? "";
    let districtRaw = null;
    let bizcircle = areaRaw || null;
    for (const d of KNOWN_DISTRICTS) {
      if (areaRaw.startsWith(d)) {
        districtRaw = d;
        bizcircle = areaRaw.slice(d.length).trim() || null;
        break;
      }
    }

    rows.push({
      id: String(id),
      name,
      price: num(attr("data-price")) ?? num(/<b>([\d.]+)<\/b>\s*元\s*\/\s*[㎡平]/.exec(block)?.[1]),
      online: num(/在售\s*<span class="sp_hei">\s*(\d+)/i.exec(block)?.[1]) ?? num(/(\d{1,5})\s*套在售/.exec(block)?.[1]),
      rent_cnt: num(/在租\s*<span class="sp_hei">\s*(\d+)/i.exec(block)?.[1]),
      build_year: num(/约?\s*((?:19|20)\d{2})\s*年建成/.exec(ting)?.[1]) ?? num(/((?:19|20)\d{2})\s*年建/.exec(block)?.[1]),
      build_type: parts.find((p) => /^(板楼|塔楼|板塔结合|平房|别墅|四合院)/.test(p)) ?? null,
      bizcircle,
      district_raw: districtRaw ?? districtName,
      url: href ? new URL(href[1], baseUrl).toString() : `https://m.5i5j.com/bj/xiaoqu/${id}.html`,
      source,
    });
  }
  return rows;
}

/** 通用兜底：直接扫 /xiaoqu/ID 链接，抓到的只有 id+name */
function parseAnyXiaoquHtml(html, baseUrl, source) {
  const rows = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]*\/xiaoqu\/(\d{4,})\/?(?:\.html)?)"[^>]*>([^<]{2,40})<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const name = m[3].trim();
    if (NAME_BLACKLIST.test(name) || seen.has(m[2])) continue;
    seen.add(m[2]);
    rows.push({ id: m[2], name, price: null, online: null, build_year: null, bizcircle: null, url: new URL(m[1], baseUrl).toString(), source });
  }
  return rows;
}

/**
 * 链家小区页的排序维度。
 * 2026-11 实测：/xiaoqu/{商圈}/pg2/ 这类深分页 URL 被链家直接 RST（连接重置，
 * 换 cookie、加 query、换 IP 都无效），但排序后缀仍然可用，且返回的是不同的
 * 前 30 条。所以「拿全一个商圈」的办法是：默认序 + 价格升序 + 价格降序，
 * 各取第一页，三份并起来能覆盖绝大多数商圈的全部小区。
 * cro23 / cro24 实测与默认序完全相同，不必抓。
 */
export const LIANJIA_SORTS = [
  { tag: "", path: "" },
  { tag: "·价升", path: "cro21/" },
  { tag: "·价降", path: "cro22/" },
];

/**
 * 商圈（bizcircle）slug —— 从 /xiaoqu/{区}/ 筛选栏的字母索引里抄下来的。
 * 有了它就能绕开深分页：每个商圈首页都稳定 200，深页则 100% 被重置。
 * 大兴的 slug 之后补（同一个字母索引块里取）。
 */
export const BIZCIRCLES = {
  tongzhou: [
    { slug: "beiguan", name: "北关" },
    { slug: "guloudajie", name: "鼓楼大街" },
    { slug: "guoyuan1", name: "果园" },
    { slug: "jiukeshu12", name: "九棵树" },
    { slug: "linheli", name: "临河里" },
    { slug: "liyuan", name: "梨园" },
    { slug: "luyuan", name: "潞苑" },
    { slug: "majuqiao1", name: "马驹桥" },
    { slug: "qiaozhuang", name: "乔庄" },
    { slug: "tongzhoubeiyuan", name: "通州北苑" },
    { slug: "tongzhouqita11", name: "通州其它" },
    { slug: "wanda14", name: "万达" },
    { slug: "wuyihuayuan", name: "武夷花园" },
    { slug: "yuqiao", name: "玉桥" },
  ],
  daxing: [],
};

export const SITES = {
  // ---------- 链家 ----------
  lianjia: {
    label: "链家",
    access: "both",
    directOk: true,
    directRisk: "匿名：302 clogin.lianjia.com（登录墙，不是验证码）；带登录 Cookie 可直取列表",
    access_firecrawl: "firecrawl+profile",
    risk: "Firecrawl 出口为海外 IP → hip.lianjia.com geetest 人机验证",
    profile: "lianjia",
    listingUrl: ({ district, page = 1 }) =>
      page <= 1 ? `https://bj.lianjia.com/xiaoqu/${district}/` : `https://bj.lianjia.com/xiaoqu/${district}/pg${page}/`,
    detailUrl: (id) => `https://bj.lianjia.com/xiaoqu/${id}/`,
    parse: (md) => parseByLinks(md, { idRe: "\\/xiaoqu\\/(\\d{5,})\\/?", baseUrl: "https://bj.lianjia.com", source: "lianjia" }),
    parseHtml: (html) => {
      const rows = parseLianjiaHtml(html, "https://bj.lianjia.com", "lianjia");
      return rows.length ? rows : parseAnyXiaoquHtml(html, "https://bj.lianjia.com", "lianjia");
    },
    pageParam: "pg",
  },

  // ---------- 贝壳 ----------
  ke: {
    label: "贝壳",
    access: "both",
    directOk: true,
    directRisk: "匿名：302 clogin.ke.com（登录墙）；带登录 Cookie 可直取",
    access_firecrawl: "firecrawl+profile",
    risk: "Firecrawl 出口为海外 IP → hip.ke.com geetest",
    profile: "ke",
    listingUrl: ({ district, page = 1 }) =>
      page <= 1 ? `https://bj.ke.com/xiaoqu/${district}/` : `https://bj.ke.com/xiaoqu/${district}/pg${page}/`,
    detailUrl: (id) => `https://bj.ke.com/xiaoqu/${id}/`,
    parse: (md) => parseByLinks(md, { idRe: "\\/xiaoqu\\/(\\d{5,})\\/?", baseUrl: "https://bj.ke.com", source: "ke" }),
    parseHtml: (html) => {
      const rows = parseLianjiaHtml(html, "https://bj.ke.com", "ke");
      return rows.length ? rows : parseAnyXiaoquHtml(html, "https://bj.ke.com", "ke");
    },
    pageParam: "pg",
  },

  // ---------- 我爱我家 ----------
  // 2026-11-02 实测：PC 站 bj.5i5j.com/xiaoqu/ 与 /ershoufang/ 已从「登录墙」升级为
  // 直接 403 Forbidden（无 title、1455 字节），带 Cookie 也未必过；而移动站
  // m.5i5j.com/bj/xiaoqu/<区slug>/p<N>/ **完全免登录**，SSR 每个小区一屏给全字段
  // （名字/id/挂牌均价/在售套数/在租套数/建成年/楼型/商圈）。
  // → 不需要账号、不需要 token、不需要 cookie。清单页每区 743 个（通州，2026-11-02）。
  // 坑：区 slug 必须带 qu（tongzhouqu），写 tongzhou 会 200 但回落成全北京推荐。
  "5i5j": {
    label: "我爱我家（移动站）",
    access: "both",
    directOk: true,
    directRisk:
      "移动站免登录直取（iPhone UA）；PC 站 bj.5i5j.com/xiaoqu 与 /ershoufang 均 403 Forbidden（1455 字节空壳）",
    risk: "Firecrawl 海外出口 → PC 站登录墙；移动站未测（不需要）",
    profile: "5i5j",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    listingUrl: ({ district, page = 1 }) => {
      const slug = DISTRICTS[district]?.m5i5j ?? district;
      return `https://m.5i5j.com/bj/xiaoqu/${slug}/p${page}/`;
    },
    detailUrl: (id) => `https://m.5i5j.com/bj/xiaoqu/${id}.html`,
    discoverUrl: () => "https://m.5i5j.com/bj/",
    parse: (md) => parseByLinks(md, { idRe: "\\/xiaoqu\\/(\\d{4,})\\.html", baseUrl: "https://m.5i5j.com", source: "5i5j" }),
    parseHtml: (html, district) => {
      const rows = parse5i5jHtml(html, "https://m.5i5j.com", "5i5j", DISTRICTS[district]?.name ?? null);
      return rows.length ? rows : parseAnyXiaoquHtml(html, "https://m.5i5j.com", "5i5j");
    },
    pageParam: "p",
  },

  // ---------- 安居客（移动站） ----------
  anjuke: {
    label: "安居客移动站",
    access: "both",
    directOk: true,
    directReferer: "https://m.anjuke.com/bj/community/",
    directRisk: "本机出口已被 58 标记：返回 720 字节 @@xxzlGatewayUrl 跳转壳 → callback.58.com/antibot/verifycode",
    risk: "Firecrawl 出口 US/JP → callback.58.com/antibot 直接拦截（出口 IP 被识别）",
    listingUrl: ({ district, page = 1 }) => `https://m.anjuke.com/bj/community/${district}/p${page}/`,
    detailUrl: (id) => `https://m.anjuke.com/bj/community/${id}/`,
    parseHtml(html, district) {
      const rows = [];
      const itemRe = /<a href="https:\/\/m\.anjuke\.com\/bj\/community\/(\d+)\/" class="c-li-item"[\s\S]*?<\/a>/g;
      for (const m of html.matchAll(itemRe)) {
        const id = m[1];
        const block = m[0];
        const name = /row-title ellipsis"[^>]*>([^<]{1,40})/.exec(block)?.[1]?.trim();
        if (!name) continue;
        const intro = /<div class="row-intro ellipsis"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
        const spans = [...intro.matchAll(/<span[^>]*>([^<]{1,30})<\/span>/g)].map((x) => x[1].trim()).filter(Boolean);
        rows.push({
          id,
          name,
          price: num(/class="price"[^>]*>(\d+)/.exec(block)?.[1]),
          online: num(/class="onlineNum"[^>]*>(\d+)/.exec(block)?.[1]),
          build_year: num(/class="year"[^>]*>(\d{4})/.exec(block)?.[1]),
          bizcircle: spans[1] ?? null,
          district: district ? DISTRICTS[district]?.name : null,
          url: `https://m.anjuke.com/bj/community/${id}/`,
          source: "anjuke",
        });
      }
      return rows;
    },
    parse: (md) => parseByLinks(md, { idRe: "\\/bj\\/community\\/(\\d+)\\/?", baseUrl: "https://m.anjuke.com", source: "anjuke" }),
    pageParam: "p",
  },

  // ---------- 房天下移动站 ----------
  fang: {
    label: "房天下移动站",
    access: "firecrawl",
    directOk: false,
    risk: "m.fang.com 的 /xiaoqu/ 维度已下线（302 到 /esf/bj/ 二手房列表，区级 /esf/bj/<区>/ = 404）；PC 站 521 + 加速乐",
    listingUrl: ({ district }) => `https://m.fang.com/esf/bj/${district}/`,
    parse: () => [], // 房源级数据，与 community 表不同构
    pageParam: null,
  },
};

/** 把解析结果补齐公共字段 */
export function normalizeRows(rows, { district, site }) {
  const d = DISTRICTS[district];
  return rows.map((r) => ({
    district: d?.name ?? r.district ?? null,
    bizcircle: r.bizcircle ?? null,
    build_year: r.build_year ?? null,
    online: r.online ?? null,
    price: r.price ?? null,
    ...r,
    source: r.source ?? site,
  }));
}
