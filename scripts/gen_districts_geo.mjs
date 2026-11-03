// 把高德 district 接口取到的通州/大兴行政边界固化进仓库，供地图模式绘制区界与区外遮罩。
// 数据源：https://restapi.amap.com/v3/config/district?keywords=110112|110115&extensions=all
// 输出：data/geo/districts.json（GCJ-02，Douglas-Peucker 简化后的外环）
// 用法：node scripts/gen_districts_geo.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "geo");
const CODES = { 通州: "110112", 大兴: "110115" };
const TOL = 0.0008; // 度，约 70 米

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* 没有 .env 就用环境变量里的 AMAP_KEY */
}

// 垂距：点到线段的距离平方（度，够用）
function d2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (!len) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = d2(points[k], points[i], points[j]);
      if (d > best) { best = d; bi = k; }
    }
    if (bi >= 0 && best > tol2) {
      keep[bi] = 1;
      stack.push([i, bi], [bi, j]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const key = process.env.AMAP_KEY;
if (!key) throw new Error("缺少 AMAP_KEY（.env 或环境变量）");

const out = { note: "GCJ-02，Douglas-Peucker 简化（tol=0.0008）；回环请带 fill-rule: evenodd", districts: {} };

// 注意：一次传多个 adcode（`110112|110115`）高德会返回空，必须逐个查
for (const [name, code] of Object.entries(CODES)) {
  const url = `https://restapi.amap.com/v3/config/district?keywords=${code}&subdistrict=0&extensions=all&key=${key}`;
  const json = await (await fetch(url)).json();
  if (json.status !== "1") throw new Error(`高德返回 ${json.status}: ${json.info}`);
  const d = (json.districts || []).find((x) => String(x.adcode) === code) || (json.districts || [])[0];
  if (!d) throw new Error(`${name}(${code}) 查不到区界`);

  const ring = String(d.polyline || "").split("|")[0];
  if (!ring) throw new Error(`${name}(${code}) 没有 polyline`);
  const pts = ring.split(";").map((pair) => pair.split(",").map(Number));
  const simp = simplify(pts, TOL);
  out.districts[name] = simp.map(([lng, lat]) => [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
  console.log(`${name}: ${pts.length} -> ${simp.length}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, "districts.json");
fs.writeFileSync(file, JSON.stringify(out));
console.log("wrote", file, (fs.statSync(file).size / 1024).toFixed(1) + " KB");
