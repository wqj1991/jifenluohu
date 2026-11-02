# 房产数据抓取调研：链家 / 贝壳 / 我爱我家 / 安居客 / 房天下

> 实测时间 2026-11-02，环境：Windows + 公司 Zscaler 代理出口，Node 24，curl 8.22 (Schannel)
> 代码：`scripts/fc/`（firecrawl.mjs / guard.mjs / providers.mjs / run.mjs）

---

## 0. 一句话结论

**Firecrawl 抓这四家不可行，本机 curl 直接抓也不可行——但原因不同，且本机这条路差一个登录态就能通。**

| 通道 | 链家 | 贝壳 | 我爱我家 | 安居客 | 房天下 |
|---|---|---|---|---|---|
| Firecrawl（境外 IP） | ✗ geetest | ✗ geetest | ✗ 登录墙 | ✗ 58 antibot | ✗ 404（xiaoqu 维度下线） |
| 本机 curl（境内 IP） | **△ 仅需登录 cookie** | **△ 仅需登录 cookie** | △ wswaf 已自动过关，仍落登录墙 | ✗ 58 antibot | ✗ 404 |
| creprice 中国房价行情 | — | — | — | — | 需逆向签名参数 |

△ = 拦截形态是「登录墙」而不是「验证码」，意味着**浏览器里登录一次、把 cookie 带给 curl 就能抓**。这是当前唯一现实的全量源。

---

## 1. 为什么 Firecrawl 不行：三个独立根因

### 1.1 出口 IP 全部在境外（决定性）

Firecrawl 官方支持 `location: { country: "CN" }`，但实测四个代理档位**没有任何中国大陆 IP**：

| 请求参数 | 实际出口 IP | 归属 | ASN |
|---|---|---|---|
| 默认 | 5.183.91.221 | US Virginia, Centreville | AS22773 Cox Communications |
| `location:{country:"CN"}` | 172.59.217.43 | **US North Carolina** | AS21928 T-Mobile USA |
| `location:CN` + `proxy:"basic"` | 185.95.102.133 | **JP Tokyo** | AS213541 WS Telecom |
| `proxy:"enhanced"` + `location:CN` | 172.56.33.83 | US Maryland | AS21928 T-Mobile USA |

`location=CN` 只是"就近选择机房"，不是"中国住宅 IP"。链家/贝壳/58 的风控第一层就是 IP 归属地 + IP 信誉，这一层过不去，后面所有参数调优都无意义。

### 1.2 keyless 免费档砍掉了所有有意义的端点

```
POST /v2/map       → 401  This endpoint is not supported by the keyless free tier.
POST /v2/scrape/{id}/interact → 409  Failed to initialize browser session from the original scrape context.
DELETE /v2/scrape/{id}/interact → 404  Browser session not found.
```

`interact` 是 Firecrawl 用来做「人工过验证码 + 保存登录态」的唯一手段（配合 `profile: {name, saveChanges}`），keyless 下完全不可用。**要抓链家，必须有 API key**（注册送 1000 credits，够跑约 1000 页）。

### 1.3 API 层 success 不等于页面正常

Firecrawl 对验证码页同样返回 `success: true`。链家 geetest 页的 `metadata.statusCode` 是 **200**，markdown 有 960 字（"人机验证 / Select in this order / 验证失败"）。不做二次判别会把验证码页当数据入库——`scripts/fc/guard.mjs` 就是干这个的。

---

## 2. 为什么本机 curl 有戏：拦截形态不同

同一批 URL，从本机境内 IP 打过去，待遇完全不同：

```
https://bj.lianjia.com/xiaoqu/            → 302  https://clogin.lianjia.com/login?service=...
https://m.lianjia.com/bj/xiaoqu/tongzhou/ → 302  https://hip.lianjia.com/captcha?...   ← 手机站反而是验证码
https://bj.ke.com/xiaoqu/tongzhou/        → 302  https://clogin.ke.com/login
https://bj.5i5j.com/xiaoqu/tongzhou/p1/   → 200  55662 字节 → 再跳 /user/login（登录墙）
https://m.anjuke.com/bj/community/tongzhou/p1/ → 200  720 字节跳转壳 → callback.58.com/antibot
https://m.fang.com/esf/bj/tongzhou/       → 404
```

**链家 PC 站对本机出口只要求登录，不给验证码。** 这是全局唯一的好消息：登录态 cookie 在链家一般能撑数月，一次导出可以长期复用。

### 2.1 顺带解决的坑：Node 的 TLS 指纹会被直接 RST

`fetch` / undici 打 `bj.5i5j.com`、`m.anjuke.com`：

```
Error: Client network socket disconnected before secure TLS connection was established  (ECONNRESET)
```

同一 URL 用 `curl` 就正常。判定为 TLS 指纹层拦截，因此 `run.mjs` 的传输层统一走 `execFile("curl", ...)` 而不是 Node fetch。

本机 curl 是 **Schannel** 版（8.22.0），对 wswaf 站点会间歇报：

```
curl: (35) schannel: failed to receive handshake, SSL/TLS connection failed
```

属握手抖动而非永久失败，已加重试（3 次，退避 800ms）+ `--http1.1 --tlsv1.2`。

### 2.2 我爱我家 wswaf 挑战可以纯 HTTP 自动过关

首次访问返回 1586 字节、无 `<title>` 的挑战页：

```html
<p id="zh">请求点击页面或移动鼠标以完成验证。</p>
...
window.open("/xiaoqu/tongzhou/p1/","_self");
window[_$daewqwskl[0]].cookie="C3VK=57fda1; path=/; max-age=300;";
```

正则抽出 `C3VK=xxx`，带上 cookie 重放一次即可，**不需要浏览器**：

- 过挑战前：1586 字节、`<title>` 缺失
- 过挑战后：**55662 字节**、有完整列表 HTML、但仍 302 → `/user/login`

代码在 `run.mjs` 的 `extractChallengeCookie()` + `directGrab()`，跑 `probe` 时显示「挑战已解」。

---

## 3. 现在到底从哪里抓：四条路，按性价比排序

### 路线 A（推荐）：ego-browser 驱动本机已登录浏览器

用你自己的 Chrome 打开 `bj.lianjia.com/xiaoqu/tongzhou/`，人工登录一次，之后由自动化翻页取 DOM。

优点：真实 TLS 指纹 + 真实 cookie + 真实浏览器环境，三个风控层一次性全过；不消耗任何 Firecrawl credit；链家登录态可长期复用。
成本：需要你登录一次；翻页要控制节奏（1 页/2-3 秒）。

### 路线 B：curl + 导出的 cookie（已写好，即刻可用）

```bash
# 1) 浏览器登录 bj.lianjia.com，F12 → Network → 任意请求 → Copy as cURL，或 Cookie-Editor 导出
# 2) 存成 data/lianjia.cookie（一行 "k=v; k2=v2" 或 JSON 数组 [{name,value}]）
node scripts/fc/run.mjs fetch --site lianjia --district tongzhou --pages 1-50 \
     --cookie-file data/lianjia.cookie
```

一页约 25-30 条，通州全部小区约 45-55 页。`parseLianjiaHtml()` 已实现，从 HTML 直取：小区名、`/xiaoqu/{id}/`、单价（`.totalPrice`）、在售套数（`N套在售`）、建成年（`YYYY年建`）、商圈（`.positionInfo` 第 2 个链接）。贝壳同构，换 `--site ke` 即可。

### 路线 B 实战结果（2026-11-02 已跑通，通州落地）

**结论：链家深分页 URL 被拉黑，但「商圈 × 排序」可以完全绕开。**

| URL 形态 | 实测结果 |
|---|---|
| `/xiaoqu/tongzhou/`、`/pg4/`、`/pg6/`、`/pg8/`… | 约一半 200 给 30 条，另一半 geetest |
| `/xiaoqu/tongzhou/pg2/`、`/pg3/`、`/pg5/`、`/pg7/` | **恒定失败**；6s 冷却与 45s 冷却两轮结果完全一致，说明是 URL 级确定性拦截而非频率触发 |
| 深分页 + query（`?from=list`、`?_t=1`、`?lianjia_uuid=`） | **直接连接重置**（bytes=0） |
| `/xiaoqu/{商圈}/pg2/` | 连接重置 |
| **`/xiaoqu/{商圈}/`** | **14/14 全部 200，30 条/页** |
| **`/xiaoqu/{商圈}/cro21/`** | 均价**升序**，与默认序只重叠 7/30 |
| **`/xiaoqu/{商圈}/cro22/`** | 均价**降序**，均价比默认序高 23% |
| `/cro23/`、`/cro24/` | 与默认序完全相同，无用 |

拿全一个区的办法不是翻页，是**切片**：

```bash
node scripts/fc/run.mjs fetch --site lianjia --district tongzhou --biz   --cookie-file data/lianjia.cookie --delay 4500
```

`--biz` 遍历 `BIZCIRCLES[tongzhou]` 的 14 个商圈 × 3 种排序 = 42 个列表页，全部是「首页」形态，**42/42 零失败**，通州去重拿到 558 个小区（链家该区约 900，商圈首页 + 两种价序覆盖 62%；剩余长尾只在深分页里，当前无解）。

两个必须避开的坑：

- **同名商圈**：`guloudajie` 是**昌平**的鼓楼大街，整页 30 条全是昌平小区。`run.mjs` 已按 `district_raw` 硬过滤，清掉 70 条外区污染（昌平 63、经开区 6、朝阳 1）。
- **解析切块**：不能用 `split(li)` 再 `slice(0, 8000)`——块切长了会把下一条的 `bizcircle` 串进来，切短了丢掉末尾价格区（曾导致 price 覆盖只有 73%、商圈数虚高到 73 个）。必须按下一个 `<li` 的位置切。

入库走项目既有的 `scripts/import_prices.mjs`（只补价、不新建小区，新小区缺坐标排不进选房结果）：

```bash
node scripts/import_prices.mjs --site lianjia --district tongzhou
# 链家 272 条匹配 → community_price 新增 257 行，与安居客价并存（不覆盖）
```

### 路线 C：creprice 中国房价行情（需逆向，但免登录）

`https://www.creprice.cn/city/bj.html` **带 Referer 时 200 / 17544 字节**，有完整北京房价页；不带 Referer 直接给验证码页。说明它的风控是 Referer 级，不是 IP 级。

- 小区维度入口存在：`/community/ranking.html?city=bj`、`/halist/bj.html`（后者参数不对会 fallback 到广州）
- 表格是 Vue 渲染，数据来自 `paramsphp` 里的 base64 签名参数：

```js
source: "eyJjaXR5IjoiYmoiLCJoYSI6InJhbmtpbmciLCJncHMiOm51bGwsImdwc25hbWUiOiIiLCJmbGFnIjoxLCJwcm9wdHlwZSI6MTEsInRpbWVUeXBlIjoicXVhcnRlciIsImRpc3RhbmNlIjoiIiwic2luY2V5ZWFyIjoxLCJ0eXBlIjoiZm9yc2FsZSIsInZlcnNpb24iOiIyLjAiLCJ0YXBUeXBlIjo3fQ=="
// 解码 = {"city":"bj","ha":"ranking","gps":null,"gpsname":"","flag":1,"proptype":11,
//         "timeType":"quarter","distance":"","sinceyear":1,"type":"forsale","version":"2.0","tapType":7}
moniSearchStr: {"ci":"bj","pt":11,"ty":"forsale","hacode":"ranking"}
mapSearchStr:  {"di":"all","halocation":null,"haid":null,"pt":11,"ty":"sale"}   // di = district
```

`mapSearchStr.di` 是区筛选位。把这三个参数改 city/区码重放，就能拿到区级小区榜单。工作量估算 1-2 小时。

### 路线 D：Firecrawl 用在没风控的源上

Firecrawl 的价值不在硬啃链家，在于抓**没有反爬的官方/研究类数据**：

- `zjw.beijing.gov.cn`（北京市住建委）→ 200 / 18112 字节，无风控
- 链家研究院 / 贝壳研究院公开报告（HTML + PDF，`formats: ["markdown"]` 直接出文本）
- 各区统计局年鉴、`creprice` 城市级指数页

这类页面 Firecrawl 一个 credit 一页，稳定且合规。

---

## 4. 代码用法

```bash
pnpm fc:probe                                  # 五站可抓性体检
pnpm fc:probe --site 5i5j --district daxing
pnpm fc:fetch --site lianjia --district tongzhou --pages 1-50 --cookie-file data/lianjia.cookie
pnpm fc:fetch --site anjuke --district tongzhou --pages 1-10   # direct 通道，走 curl
```

环境变量（`.env`）：

```
FIRECRAWL_API_KEY=fc-xxxxxxxx      # 不填则 keyless（只能单页 scrape，interact/map/crawl 全部不可用）
```

输出落 `data/fc_<site>_<district>.json`，字段对齐 `server/db.mjs:69-82` 的 `community` 表（`id / name / district / bizcircle / price / build_year / online / source`），可直接喂 `import_tx.mjs` 那套入库逻辑。

### guard.mjs 的判别规则（核心资产）

Firecrawl 和 curl 都可能"HTTP 200 + 验证码页"，所以每次抓取都要过一遍：

| kind | 匹配特征 |
|---|---|
| `geetest-captcha` | `hip.(lianjia\|ke).com/captcha`、`Select in this order`、`人机验证` |
| `login-wall` | `clogin.(lianjia\|ke).com`、`/user/checklogin`、`/user/login`、`扫码登录` |
| `antibot-58` | `callback.58.com/antibot`、`访问过于频繁`、`@@xxzlGatewayUrl` |
| `waf-challenge` | `移动鼠标以完成验证`、`C3VK=` |
| `jsl-521` | 加速乐 521/522 |
| `http-404` / `http-error` | `metadata.statusCode` 非 2xx/304 —— **必须先判这个**，否则 404 会被误判成"可抓" |

---

## 5. 与 luohu 项目的对接

现有 `community` 表字段与链家列表页可提供的字段几乎一一对应：

| 表字段 | 链家列表页来源 |
|---|---|
| `id` | `/xiaoqu/{id}/` 的 id |
| `name` | `.title a` 文本 |
| `price` | `.totalPrice`（元/㎡） |
| `online` | `N套在售` |
| `build_year` | `YYYY年建` |
| `bizcircle` | `.positionInfo` 第 2 个链接 |
| `district` | 抓取时传入的区 |
| `lng/lat` | 需进详情页（列表页没有），或用高德 POI 反查已有 `AMAP_KEY` |

注意：链家小区列表页**不含坐标**。两种补法：①链家详情页 SSR 里有 `resblockPosition`；②用已有的 `fetch_ajk_full.mjs` 那套高德 POI 方案按小区名反查。

---

## 6. 合规边界（自用口径）

本项目是个人购房决策工具，数据落本地 sqlite、不做二次分发。抓取节奏控制在 1 页/2-3 秒、单日不超过数百页，不冲击对方服务；不绕过付费墙、不抓取非公开数据。需要长期稳定数据时，优先考虑官方开放平台或商业数据接口，而不是加大对抗强度。
