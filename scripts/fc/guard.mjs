// 反爬拦截识别：把「验证码页 / 登录墙 / 空正文」和「真数据」分开。
// 这是本抓取层最重要的一件东西——Firecrawl 对 302 到验证页的请求
// 同样返回 success:true + statusCode:200，不判别就会把验证码页当数据入库。

export const SIGNATURES = [
  {
    kind: "geetest-captcha",
    vendor: "lianjia/ke (hip.*)",
    re: /hip\.(lianjia|ke)\.com\/captcha|Select in this order|人机验证|验证失败/i,
  },
  {
    kind: "login-wall",
    vendor: "lianjia/ke (clogin.*)",
    re: /clogin\.(lianjia|ke)\.com|\/user\/checklogin|\/user\/login|title\s*[:=]\s*["']?登录/i,
  },
  {
    kind: "login-wall",
    vendor: "5i5j",
    re: /\/user\/login\/\?preUrl=|扫码登录|短信登录|密码登录/i,
  },
  {
    kind: "antibot-58",
    vendor: "58/anjuke (callback.58.com)",
    // @@xxzlGatewayUrl 是安居客/58 的跳转壳：720 字节空 body + window.location.assign(verifycode)
    re: /callback\.58\.com\/antibot|@@xxzlGatewayUrl|cloud_anjuke_xiaoqu|访问过于频繁|请输入验证码/i,
  },
  {
    kind: "jsl-521",
    vendor: "加速乐",
    re: /__jsl_clearance|加速乐|请稍候.*正在验证/i,
  },
  {
    kind: "cloudflare",
    vendor: "Cloudflare",
    re: /Just a moment|cf_chl_opt|Checking your browser|Enable JavaScript and cookies/i,
  },
  {
    kind: "waf-challenge",
    vendor: "wswaf / 通用（可自动过关）",
    // 我爱我家 wswaf 挑战页：无 <title>，正文只有「请求点击页面或移动鼠标以完成验证」，
    // 末尾 JS 里明文写着 document.cookie="C3VK=xxx" 和 window.open(原URL)
    re: /wswaf|安全验证|滑动验证|拖动滑块|移动鼠标以完成验证|move mouse for authentication|C3VK=/i,
  },
];

/**
 * @returns {{blocked:boolean, kind:string|null, vendor:string|null, evidence:string|null, severity:"ok"|"warn"|"fatal"}}
 */
export function detectBlock(doc) {
  const md = doc?.markdown ?? "";
  const meta = doc?.metadata ?? {};
  const hay = `${md}\n${meta.title ?? ""}\n${meta.url ?? ""}`;

  // HTTP 层先判：4xx/5xx 一定不是有效数据
  const code = Number(meta.statusCode ?? 0);
  if (code && (code >= 400 || code < 200)) {
    return {
      blocked: true,
      kind: code === 404 ? "http-404" : code === 521 || code === 522 ? "jsl-521" : "http-error",
      vendor: null,
      evidence: `HTTP ${code}`,
      severity: "fatal",
    };
  }

  for (const s of SIGNATURES) {
    const m = s.re.exec(hay);
    if (m) {
      return { blocked: true, kind: s.kind, vendor: s.vendor, evidence: m[0].slice(0, 80), severity: "fatal" };
    }
  }

  // 正文过短 + 非目标域 → 大概率被重定向到空壳页
  if (md.trim().length < 120) {
    return {
      blocked: true,
      kind: "empty-body",
      vendor: null,
      evidence: `正文仅 ${md.trim().length} 字符，title=${meta.title ?? "?"}`,
      severity: "fatal",
    };
  }

  // 重定向到别的域（登录/验证都在这条路上）
  const src = meta.sourceURL || "";
  const fin = meta.url || "";
  if (src && fin) {
    try {
      const a = new URL(src).host.replace(/^m\./, "");
      const b = new URL(fin).host.replace(/^m\./, "");
      if (a !== b) {
        return { blocked: true, kind: "redirect-offsite", vendor: b, evidence: `${src} → ${fin}`, severity: "warn" };
      }
    } catch {
      /* ignore */
    }
  }

  return { blocked: false, kind: null, vendor: null, evidence: null, severity: "ok" };
}

/** 给一批探测结果打汇总表（run.mjs probe 用） */
export function summarize(rows) {
  const w = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  const head = `${w("站点", 12)}${w("URL", 52)}${w("HTTP", 6)}${w("正文", 8)}${w("判定", 22)}证据`;
  const lines = rows.map((r) => {
    const flag = r.verdict.blocked ? `✗ ${r.verdict.kind}` : "✓ 可抓";
    return `${w(r.site, 12)}${w(r.url, 52)}${w(r.status ?? "-", 6)}${w(r.len, 8)}${w(flag, 22)}${r.verdict.evidence ?? ""}`;
  });
  return [head, "-".repeat(head.length), ...lines].join("\n");
}
