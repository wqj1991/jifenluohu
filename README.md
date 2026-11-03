# 积分落户 · 选房决策台

把「北京积分落户还差多少分」和「通州 / 大兴（含经开区）买哪套房」放进同一个决策面的单人自用工具。

- **能不能落**：以 2027 年为申报年，按 9 项积分指标算出与预测分数线的差额，并给出最划算的补分动作。
- **落到哪**：在通州、大兴范围内按通勤（高德早高峰实测）与学区（区教委划片 + 初中梯队）并排比较房源。

产品定义、硬约束与数据源实测结论见 [PRODUCT.md](PRODUCT.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vite + React 19 + TypeScript + Tailwind v4 |
| 后端 | Fastify 5（本地进程） |
| 存储 | SQLite（Node 内置 `node:sqlite`）；权威库在服务器 `/opt/luohu/data/luohu.db`，本地不保留库文件 |
| 抓取 | 安居客移动站（免登录）、链家（需登录 cookie）、高德 POI / 路径规划、Firecrawl |

## 快速开始

```bash
pnpm install
pnpm dev                    # http://localhost:5273，/api 代理到线上实例（数据只有那一份）
pnpm dev:local              # 本地起 API：.env.local 里 LUOHU_API=http://127.0.0.1:8787，先 pnpm seed
```

`pnpm dev` 走 vite 代理，代理层会把 Origin 改写成后端自己的 origin——后端有同源校验，不改这一步所有 POST 都会 403「跨站请求被拒绝」。出网要走公司代理时，代理会自动复用 `HTTP(S)_PROXY`。

## 登录

除了登录页要用的静态资源，`/api/*` 全部要登录后才能访问（本地跑的副本也一样）。

- 首个账号是 `admin`，密码取 `LUOHU_PASSWORD`（空库时写入 sqlite，只存 scrypt 加盐摘要）；不设就随机生成并打印在启动日志里 —— 仓库是公开的，源码里不放现役密码。
- 会话是 30 天的 HttpOnly `luohu_sid` cookie，库里只存 token 的 sha256；连续输错 6 次锁 5 分钟，跨站 POST 直接 403。
- 忘了密码：`pnpm auth:reset -- --user admin --password '新密码'`（不带参数则交互输入，不回显），旧会话立刻失效。
- 反向代理后面跑时确认透传 `X-Forwarded-Proto`，否则 cookie 不会带 `Secure`（`app` 已开 `trustProxy`）；Host 被改写时也认 `X-Forwarded-Host`。

## 脚本

```bash
pnpm build            # tsc -b && vite build
pnpm prices:import --all          # 导入 data/fc_*.json、data/ajk_full_*.json 的房价
pnpm fc:probe                     # Firecrawl 抓取探针
pnpm fc:fetch                     # 抓取房价（安居客等免登录源）
pnpm fc:fetch-biz --district tongzhou   # 按「商圈 × 排序」抓链家（需 data/lianjia.cookie）
pnpm fc:login                     # 链家登录态采集
node scripts/seed_kindergarten_ranks.mjs   # 幼儿园分档入库（经开 28 + 大兴 187，官方名录见 data/kindergarten/）
```

## 目录

```
src/            前端（App / Profile 积分 / HouseHunt 选房 / maint 维护页）
server/         Fastify 路由与 sqlite 访问（db / engine / house / prices / route / maint）
scripts/        抓取与导入（fc/ Firecrawl 流程、安居客/高德 python 脚本、seed 脚本）
data/           抓取产物与 sqlite（*.db、*.cookie 不入库）
docs/           数据源踩坑记录
```

## 数据与证据口径

- 政策数字只认官方文件（京政办发〔2020〕9 号、京人社开发发〔2020〕8 号），未核实项标灰，不填猜测值。
- 房价多源并存：`community_price` 每「小区 × 来源」一行，`community` 只存中位数与区间，不取平均。
- 房价、学校排名、中考成绩、容积率、物业费均无可靠来源时留空，不编造。
- 幼儿园：性质/地址/电话/收费取自官方名录（经开区社会事业局 2025-06、大兴区教委 2026-05，原件存 `data/kindergarten/`）；区级督导只出「合格」，官方不分档，`tier` 为本地推断值，逐条写进 `note`，`verified` 保持 0。

## 不入库

`.env`（高德 Key）、`data/*.db*`、`data/lianjia.cookie`、`data/cookies-*.json` 已在 `.gitignore` 中排除。
