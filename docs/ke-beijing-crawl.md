# 贝壳北京（大兴 / 通州）房价抓取方案

> 实测时间 2026-11-03，环境：Windows + 公司 Zscaler 代理（出口 136.226.228.101 香港），Node 24.18，curl 8.22
> 复用资产：`data/lianjia.cookie`（2026-11-02 导出的链家登录态）
> 产码：`scripts/fc/ke.mjs`（正式版）；`.tmp/ke/crawl.mjs` 为同期验证副本
> 产物：`data/ke_xiaoqu_daxing.json`、`data/ke_xiaoqu_tongzhou.json`、`data/ke_ershoufang_daxing.json`、`data/ke_ershoufang_tongzhou.json`

---

## 0. 一句话结论

**贝壳能抓，而且比链家好抓——关键是「一份 cookie + 放弃翻页、改用切片」。**

- 裸请求：`bj.ke.com/ershoufang/daxingqu/` → `302 clogin.ke.com/login`（登录墙）
- 带 `data/lianjia.cookie`：同一个 URL → `200 / 234 KB / 30 条`。**链家的 cookie 在 ke.com 上直接通用**（两个站共用 `lianjia_uuid` / `lianjia_ssid` / `lianjia_token` 体系），不需要单独登录贝壳。
- 分页 `/pg2/`、`/pg3/` → **恒定 302**，冷却无效，是 URL 级确定性拦截（与链家 2026-11-02 的结论一致）。
- 但 `/ershoufang/{商圈}/`、`/p1/`…`/p5/`、`/l1/`、`/co21/` **全部 200**。

所以拿全一个区的办法不是翻页，是 **区县 → 商圈 × 价格档 × 户型 × 排序** 的笛卡尔切片。

---

## 1. 实测结论表

| URL 形态 | 结果 |
| --- | --- |
| `bj.ke.com/ershoufang/`（裸 curl，无 cookie） | 200，30 条（唯一免登录入口） |
| `bj.ke.com/ershoufang/{区}/`（无 cookie） | 302 → `clogin.ke.com` |
| `bj.ke.com/ershoufang/{区}/`（带 cookie） | **200，30 条** |
| `bj.ke.com/xiaoqu/{区}/`（带 cookie） | **200，30 个小区** |
| `bj.ke.com/chengjiao/{区}/`（带 cookie） | **200，30 条，但成交价全部「暂无价格」** |
| `bj.ke.com/{any}/pg2/`、`/pg3/` | **302（拉黑）** |
| `bj.ke.com/{any}/pg1/` | 200（等价首页） |
| `/ershoufang/{商圈}/`（21+13 个） | **35/35 全 200** |
| `/ershoufang/{区}/p1/` `/p5/` `/l1/` `/co21/` | 全 200 |
| `m.ke.com/...`（手机站） | 302 → `hip.ke.com/captcha`（反而更严） |
| `beijing.ke.com` | **域名不存在**（DNS NXDOMAIN），北京站只有 `bj.ke.com` |

---

## 2. 域名与 slug 全表（实证自页面锚点，勿凭拼音猜）

北京站：`https://bj.ke.com`

### 2.1 区县 slug（17 个，全部带后缀，纯拼音一律 302）

| 区 | slug |
| --- | --- |
| 东城 | `dongchengqu3` |
| 西城 | `xichengqu3` |
| 朝阳 | `chaoyangqu5` |
| 海淀 | `haidianqu` |
| 丰台 | `fengtaiqu` |
| 石景山 | `shijingshanqu` |
| **通州** | **`tongzhouqu1`** |
| 昌平 | `changpingqu` |
| **大兴** | **`daxingqu`** |
| 经开区 | `beijingjingjijishukaifaqu` |
| 顺义 | `shunyiqu` |
| 房山 | `fangshanqu` |
| 门头沟 | `mentougouqu` |
| 平谷 | `pingguqu` |
| 怀柔 | `huairouqu` |
| 密云 | `miyunqu` |
| 延庆 | `yanqingqu` |

⚠️ 这是最容易踩的坑：`/ershoufang/daxing/` 和 `/ershoufang/tongzhou/` 都能解析但**不是这两个区的页面**，返回的是被重定向的登录墙或（去掉 cookie 时）静默回落的全北京列表。正确拼法必须带 `qu` 后缀和尾号。

### 2.2 大兴商圈（20 个，已按页面 `district` 字段确认属于大兴）

```
huangcunzhong 黄村中          huangcunhuochezhan 黄村火车站   gaomidian 高米店
zaoyuan 枣园                  jiugong1 旧宫                   xihongmen 西红门
yinghai 瀛海                  tiangongyuan 天宫院              tiangongyuannan 天宫院南
yihezhuang 义和庄             guanyinsi 观音寺                kejiyuanqu 科技园区
yizhuang1 亦庄                yizhuanghexiqu 亦庄河西区        yizhuangkaifaquqita1 亦庄开发区其它
daxingjichangkonggang 大兴机场空港                              daxingxinjichang 大兴新机场
daxingxinjichangyangfangbieshuqu 大兴新机场洋房别墅区          nanzhongzhoujichangshangwuqu 南中轴机场商务区
daxingqita11 大兴其它
```

### 2.3 通州商圈（13 个）

```
beiguan 北关        tongzhoubeiyuan 通州北苑   guoyuan1 果园      jiukeshu12 九棵树(家乐福)
liyuan 梨园         linheli 临河里              yuqiao 玉桥        luyuan 潞苑
wuyihuayuan 武夷花园  wanda14 万达               qiaozhuang 乔庄    majuqiao1 马驹桥
tongzhouqita11 通州其它
```

⚠️ 区县页的商圈导航里会混进**外区串场商圈**：大兴页里出现 `heyi 和义`、`wanyuan1 万源`、`xingong 新宫`、`shibalidian1 十八里店`（丰台/朝阳）；通州页里出现 `dougezhuang 豆各庄`、`guanzhuang 管庄`、`shuangqiao 双桥`（朝阳）、`shoudoujichang1 首都机场`（顺义）。抓取时必须按页面的 `district` 字段硬过滤，否则均价会被拉偏。本次已过滤，但仍有 2 条「和义/万源」因为贝壳把它们归到了大兴大区，属平台口径，保留。

---

## 3. 鉴权：一份 cookie 打通两站

`data/lianjia.cookie` 是 Cookie-Editor 导出的 JSON 数组（24 条），关键字段：

```
lianjia_uuid  lianjia_ssid  lianjia_token  lianjia_token_secure
login_ucid    security_ticket  select_city=110000  ftkrc_  lfrc_
```

转成 curl 头：

```bash
node -e 'const a=require("./data/lianjia.cookie");console.log(a.map(x=>x.name+"="+x.value).join("; "))'
```

- 域是 `.lianjia.com`，但 **ke.com 认同一套同名 cookie**，直接拿去请求 `bj.ke.com` 就是登录态。
- 有效期按 `expirationDate` 看，`lianjia_uuid` 到 2028 年；登录 token 通常数月，过期重导一次即可。
- 不要带 `Referer: https://bj.lianjia.com/` 去请求 ke.com，会被判跨站；用 `Referer: https://bj.ke.com/`。

---

## 4. 每类页面的字段与选择器（实测命中率 30/30）

### 4.1 小区列表 `/xiaoqu/{区|商圈}/` —— **最接近「房价」的一页**

切块：`<li class="clear xiaoquListItem`

| 字段 | 选择器 / 正则 |
| --- | --- |
| 小区 id | `data-id="(\d+)"`（= `resblock_id`，详情页 `https://bj.ke.com/xiaoqu/{id}/`） |
| 小区名 | `<a class="maidian-detail"[^>]*title="([^"]*)"` |
| **参考均价** | `<div class="xiaoquListItemPrice"><div class="totalPrice"><span>30266</span>元/m²` |
| 均价口径 | `<div class="priceDesc">7月二手房参考均价</div>` ← **月份不统一，见 §7** |
| 在售套数 | `class="totalSellCount"...><span>2</span>套` |
| 区 / 商圈 | `.district` 文本 / `.bizcircle` 文本 |
| 建成年 | `(\d{4})年`（在 `positionInfo` 尾部，格式 `/板楼 /&nbsp;2001年`） |
| 30 天成交 | `(\d+)天成交(\d+)套` |

### 4.2 二手房列表 `/ershoufang/{区|商圈}/`

切块：`<li class="clear"`

| 字段 | 选择器 |
| --- | --- |
| 房源 id / url | `href="https://bj.ke.com/ershoufang/(\d+)\.html"` |
| 标题 | `<div class="title"><a ...>兴丰家园 2室1厅 95.09平米</a>` |
| 楼层/建成/户型/面积/朝向 | `<div class="houseInfo">([\s\S]*?)</div>` → `低楼层 (共15层) \| 2016年 \| 2室1厅 \| 91.27平米 \| 南 北` |
| **总价（万）** | `<div class="totalPrice totalPrice2"><i></i><span class=""> 409</span><i>万</i>` |
| **单价（元/㎡）** | `<div class="unitPrice"><span>44,813元/平</span>` |
| 关注/发布时间 | `<div class="followInfo">57人关注 / 4月前发布</div>` |

⚠️ `totalPrice` 的 `<span>` 带 `class=""`，正则必须写 `<span[^>]*>`，写 `<span>` 会 0 命中（本次已修正）。

### 4.3 成交页 `/chengjiao/{区}/` —— **能抓，但价格是空的**

结构完整（`ul.listContent > li.VIEWDATA`，`div.title` / `div.houseInfo` / `div.dealDate` / `div.totalPrice` / `div.unitPrice` / `div.dealHouseInfo` / `div.dealCycleeInfo`），但：

```
实测 30/30 条成交记录的 totalPrice 与 unitPrice 均为「暂无价格 / 暂无单价」
链家 bj.lianjia.com/chengjiao/daxingqu/ 同样 30/30「暂无价格」
```

**结论：贝壳/链家已全面隐藏成交价，成交页只剩「什么时候、哪个小区、多大面积、什么楼层」这类无名额信息，对价格分析无用。** 需要真实成交价只能走：网签公示（住建委）、或商业数据接口。

---

## 5. 已跑通的数据

```bash
# 小区均价（21 页 / 14 页，零封禁）
DELAY=3000 node .tmp/ke/crawl.mjs xiaoqu daxing      # → data/ke_xiaoqu_daxing.json
DELAY=3000 node .tmp/ke/crawl.mjs xiaoqu tongzhou    # → data/ke_xiaoqu_tongzhou.json
```

| 区 | 页数 | 成功 | 小区数 | 有均价 | P25 | 中位 | P75 | 区间 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 大兴 | 21 | 21/21 | **429** | 351 | 23,550 | **29,149** | 36,593 | 12,406 – 98,696 |
| 通州 | 14 | 14/14 | **383** | 344 | 26,019 | **29,511** | 35,257 | 15,491 – 66,641 |

（单位 元/㎡，2026-11-03 抓取；大兴含别墅拉高上限：亲爱的villa 98,696、紫禁壹号院南院 98,358；通州上限 66,641）

商圈覆盖密度：大兴除 `科技园区(2)`、`天宫院南(4)`、`大兴机场空港(8)` 外均 ≥12 条；通州 13 个商圈全部 23-30 条。**贝壳单商圈首页 30 条基本就等于该商圈全量小区**，比链家「558/900 覆盖 62%」更好。

### 5.1 二手房挂牌（同期同批）

```bash
DELAY=3000 node scripts/fc/ke.mjs ershoufang daxing     # → data/ke_ershoufang_daxing.json
DELAY=3000 node scripts/fc/ke.mjs ershoufang tongzhou   # → data/ke_ershoufang_tongzhou.json
```

| 区 | 页数 | 挂牌数 | 单价 P25 | 单价中位 | 单价 P75 | 总价中位 | 面积中位 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 大兴 | 21/21 | **551** | 19,838 | **26,014** | 33,546 | 228 万 | 90.07 ㎡ |
| 通州 | 14/14 | **390** | — | **29,147** | — | 279 万 | 94.57 ㎡ |

### 5.2 商圈价格梯度（小区参考均价中位，元/㎡）

**大兴**（从低到高）：大兴机场空港 13,969 · 大兴新机场洋房别墅区 15,639 · 南中轴机场商务区 17,304 · 大兴新机场 20,738 · 观音寺 21,063 · 义和庄 23,526 · 黄村火车站 25,895 · 枣园 27,028 · 大兴其它 28,172 · 天宫院 30,058 · 西红门 31,014 · 旧宫 31,144 · 黄村中 31,906 · 瀛海 32,456 · 高米店 36,381 · 亦庄河西区 41,763 · **亦庄 42,856**

**通州**（从低到高）：乔庄 25,483 · 通州北苑 27,149 · 马驹桥 27,154 · 北关 27,198 · 通州其它 27,676 · 梨园 27,755 · 果园 29,108 · 玉桥 30,237 · 潞苑 30,341 · 万达 30,424 · 九棵树 31,684 · 武夷花园 34,641 · **临河里 34,803**

> 注意两个口径不要混：**小区参考均价**（贝壳按小区整体估的，含大小户型）通常**高于**同商圈**在售房源的挂牌单价中位**。例如大兴科技园区小区均价 25,725 而房源单价中位 46,281——因为该商圈在售的 30 条恰好全是次新大户型；天宫院南同理（小区 30,239 vs 房源 69 万总价的中位来自别墅）。做「贵不贵」判断时以**同一口径内比较**为准。

---

## 6. 反爬要点

| 层 | 现象 | 对策 |
| --- | --- | --- |
| IP 归属 | 境外 IP 一律登录墙/验证码 | 本机 Zscaler 出口是香港，靠 cookie 过；纯抓不登录则必须国内 IP |
| 登录态 | 无 cookie → `302 clogin.ke.com` | 复用 `data/lianjia.cookie` |
| URL 级封禁 | `/pg2/`、`/pg3/` 恒定 302，冷却无效 | 不翻页，改切片 |
| 频率 | 本次 3.0s/页，35 页零封禁；链家经验值 4.5s | 3-5s/页；单日控制在数百页 |
| TLS 指纹 | Node `fetch` 打 58/安居客被 RST，curl 正常 | 传输层统一 `execFile("curl")`，不用 undici |
| 缓存 | 小区均价 `priceDesc` 显示 3月/7月/9月/10月 混杂 | 落库时把 `price_desc` 一起存，别当成同一时点 |

---

## 7. 已知限制

1. **成交价拿不到**（见 §4.3），贝壳、链家都一样。
2. **参考均价不是当日价**：`priceDesc` 实测出现「3月/7月/9月/10月二手房参考均价」四种口径，说明贝壳对不同小区按不同批次刷新。做时间序列时必须带 `price_desc`，否则会误判成涨价。
3. **78 个大兴小区 / 39 个通州小区无均价**（新盘、无成交、或别墅类），不要填 0。
4. **单页 30 条封顶**：商圈内小区 >30 个时会截断（如黄村中 30 条可能已满）。补法：加 `/p1/`…`/p5/` 价格档或 `/co21/`、`/co22/` 排序切片再并集去重（本次未做，大兴/通州暂未触顶，但黄村中/高米店/梨园/北关这几个 30 条满页的商圈建议补切片）。
5. 手机站 `m.ke.com` 风控更严（直接验证码），不要用。

---

## 8. 落库对接

字段与 `community_price` 表对齐（`server/db.mjs:69-82`）：

| 表字段 | 贝壳来源 |
| --- | --- |
| `community_id` | 需按名字匹配已有 `community`（贝壳 `resblock_id` 与链家 `resblock_id` 同源，可直接用） |
| `price` | `xiaoquListItemPrice .totalPrice span` |
| `source` | `ke` |
| `district` | 抓取时传入（大兴区 / 通州区） |
| `bizcircle` | `.bizcircle` 文本 |
| `build_year` | `(\d{4})年` |
| `online` | `.totalSellCount` |

```bash
node scripts/import_prices.mjs --file data/ke_xiaoqu_daxing.json,data/ke_xiaoqu_tongzhou.json --create
```

只导入 `ke_xiaoqu_*`。**`ke_ershoufang_*` 故意不导入**：那是房源级单价，一个小区会命中多条、且只代表当前在售的几套户型，写进 `community_price`（PK 是 `(community_id, source)`）会互相覆盖并把口径搅乱。房源数据留在 `data/` 里做挂牌结构分析，不进台账。

贝壳特有的两个映射：

| 字段 | 处理 |
| --- | --- |
| `sell_count` | → `online`（二手房页用 `online`，小区页叫 `sell_count`，导入器两个都认） |
| `price_desc` | 原文进 `note`；月份解析成 `ym` |

`ym` 的推法：`price_desc` 只写「10月二手房参考均价」，没有年份，按抓取日补年（月份晚于抓取月就算上一年）。实测这批 695 条的口径分布：**2026-10 有 643 条**，其余 3月/6月/7月/9月/12月各 1-2 条 —— 贝壳对不同小区按不同批次刷新，这个字段不能省。

### 8.1 已入库结果（2026-11-03）

| | 匹配 | 新源 | 覆盖 | 新建无坐标小区 | 无价跳过 |
| --- | --- | --- | --- | --- | --- |
| 大兴 | 350 | 328 | 22 | 41 | 78 |
| 通州 | 345 | 322 | 23 | 1 | 38 |
| 合计 | **695** | 650 | 45 | 42 | 117 |

落库后：线上权威库 `community_price` 中 `source='ke'` 共 **650** 条；有价小区 2,466，多源小区 837（原先 670）。本地 `data/luohu.db` 同步一致。导入前已备份 `data/luohu.db.bak-pre-ke`。

新建的 42 个小区 id 取 `-resblock_id`（负数），`lng/lat` 为空 —— 选房与地图查询都带 `lng IS NOT NULL`，所以它们不会混进结果，等补到坐标再自动转正。

匹配质量：`name` 精确 514 + `name+biz` 9 = 523 条可靠；`name-only` 61 + `name+biz-any` 46 是同名多候选按商圈规则收敛；`fuzzy` 23 条模糊。未匹配 0。

---

## 9. 周更定时任务

`scripts/fc/weekly.mjs` 现在含三步：抓取 → 导入 → 记日志。

```bash
node scripts/fc/weekly.mjs --only anjuke,ke --push   # 计划任务用的就是这条
node scripts/fc/weekly.mjs --only ke --dry           # 只抓不导
```

- `--only` 支持逗号列表（本次新增，原来只能单值）
- 贝壳抓取固定用 `DELAY >= 3500ms`（`ke.mjs` 从环境变量读，没有 `--delay`），一个区 21 页约 1 分钟，两区约 4 分钟
- `--push` 时把 `data/ke_xiaoqu_{daxing,tongzhou}.json` 一并交给 `scripts/deploy.mjs --import`，写服务器上的权威库

Windows 计划任务（`scripts/fc/install-weekly-task.ps1`）：

```
任务名     luohu-price-weekly
触发       每周日 05:00
命令       C:\nvm4w\nodejs\node.exe "D:\repos\luohu\scripts\fc\weekly.mjs" --only anjuke,ke --push
```

重新注册：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fc/install-weekly-task.ps1
```

默认参数已改为 `-Time 05:00`、`-ScriptArgs "--only anjuke,ke --push"`。当前注册结果是 `LogonType: Interactive`（登录状态才跑）；用**管理员权限**的 PowerShell 再跑一次会升级成 S4U，锁屏/未登录也能跑。

分工：5i5j 由服务器自己跑（crontab）；anjuke 和 ke 必须本地跑 —— anjuke 是被 CDN 风控挡了服务器 IP，ke 是需要登录 cookie + 公司代理。
