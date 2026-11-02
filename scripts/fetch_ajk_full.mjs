// 抓安居客移动站小区列表：DOM 取价格，__NUXT__ 取经纬度/地址/物业类型
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const RAW = "D:/dsh/cache/tmp/ajk_raw";
const OUT = "D:/allen/luohu/data";
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://m.anjuke.com/bj/" } });
  return r.ok ? await r.text() : "";
}

function nuxtItems(html) {
  const idx = html.indexOf("window.__NUXT__=");
  if (idx < 0) return [];
  let code = html.slice(idx + "window.__NUXT__=".length);
  const cut = code.indexOf("</script>");
  code = cut >= 0 ? code.slice(0, cut) : code.slice(0, 400000);
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  try { vm.runInContext("window.__NUXT__=" + code, sandbox, { timeout: 5000 }); }
  catch { return []; }
  const out = [];
  const seen = new Set();
  (function walk(o, d = 0) {
    if (!o || typeof o !== "object" || d > 12 || seen.has(o)) return;
    seen.add(o);
    if (o.id && o.name && (o.blng !== undefined || o.lng !== undefined)) { out.push(o); return; }
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(sandbox.window.__NUXT__);
  return out;
}

function domPrices(html) {
  const map = new Map();
  const re = /<a href="https:\/\/m\.anjuke\.com\/bj\/community\/(\d+)\/" class="c-li-item"[^]*?<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const block = m[0];
    const price = block.match(/class="price"[^>]*>(\d+)/);
    const online = block.match(/class="onlineNum"[^>]*>(\d+)/);
    map.set(id, { price: price ? Number(price[1]) : null, online: online ? Number(online[1]) : null });
  }
  return map;
}

async function crawl(slug, district) {
  const seen = new Map();
  for (let p = 1; p <= 50; p++) {
    const url = p === 1
      ? `https://m.anjuke.com/bj/community/${slug}/`
      : `https://m.anjuke.com/bj/community/${slug}/p${p}/`;
    const html = await get(url);
    if (!html) { console.error("empty page", p); break; }
    fs.writeFileSync(path.join(RAW, `${slug}_p${p}.html`), html);
    const nx = nuxtItems(html);
    const pr = domPrices(html);
    let added = 0;
    for (const o of nx) {
      if (seen.has(o.id)) continue;
      const p2 = pr.get(o.id) || {};
      seen.set(o.id, {
        id: Number(o.id),
        name: o.name,
        district, area: o.areaName,
        bizcircle: o.tradingAreaName || "",
        address: o.address || "",
        lng: Number(o.blng || o.lng) || null,
        lat: Number(o.blat || o.lat) || null,
        price: p2.price ?? null,
        online: p2.online ?? null,
        build_year: o.completionTime ? Number(String(o.completionTime).slice(0, 4)) || null : null,
        build_type: o.buildTypeStr || "",
        property_type: (o.propertyTypes || []).join("/"),
        tags: (o.tags || []).join("|"),
      });
      added++;
    }
    console.error(`${district} p${p} +${added} total ${seen.size}`);
    if (added === 0) break;
    await sleep(1200);
  }
  return [...seen.values()];
}

const all = {};
for (const [slug, d] of [["tongzhou", "通州"], ["daxing", "大兴"]]) {
  const rows = await crawl(slug, d);
  all[slug] = rows;
  fs.writeFileSync(path.join(OUT, `ajk_full_${slug}.json`), JSON.stringify(rows, null, 1));
  console.error(`saved ${slug}: ${rows.length}`);
}
console.log(JSON.stringify({ tongzhou: all.tongzhou?.length, daxing: all.daxing?.length,
  with_coord: (all.tongzhou || []).concat(all.daxing || []).filter((r) => r.lng).length }));
