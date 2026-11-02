// 从安居客 HTML 中还原 window.__NUXT__（变量别名化的 IIFE），取出带坐标的小区数据
import fs from "node:fs";
import vm from "node:vm";

const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");

const idx = html.indexOf("window.__NUXT__=");
if (idx < 0) { console.error("no __NUXT__"); process.exit(1); }
let code = html.slice(idx + "window.__NUXT__=".length);
// 截到该语句结束（以 }(…); 形式收尾，取到首个 ";" 之后）
const end = code.indexOf(";</script>") >= 0 ? code.indexOf(";</script>") : code.indexOf(";");
code = code.slice(0, end + 1);

const sandbox = { window: {} };
vm.createContext(sandbox);
try {
  vm.runInContext("window.__NUXT__=" + code, sandbox, { timeout: 5000 });
} catch (e) {
  console.error("eval fail", e.message);
  process.exit(1);
}

const nuxt = sandbox.window.__NUXT__;
// 递归找包含 blng/lat 的对象
const out = [];
const seen = new Set();
function walk(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 12 || seen.has(o)) return;
  seen.add(o);
  if (o.blng !== undefined || (o.lat !== undefined && o.name)) {
    out.push(o);
    return;
  }
  for (const k of Object.keys(o)) walk(o[k], depth + 1);
}
walk(nuxt);

console.log(JSON.stringify({
  keys: Object.keys(nuxt || {}),
  found: out.length,
  sample: out[0] ? Object.keys(out[0]) : [],
  first: out[0] || null,
}, null, 1));
