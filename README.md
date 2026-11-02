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
| 存储 | SQLite（Node 内置 `node:sqlite`，落在 `data/luohu.db`） |
| 抓取 | 安居客移动站（免登录）、链家（需登录 cookie）、高德 POI / 路径规划、Firecrawl |

## 快速开始

```bash
pnpm install
cp .env.example .env        # 填入高德 Web 服务 Key
pnpm seed                   # 初始化 sqlite 与基础字典
pnpm dev                    # 前端 http://localhost:5173 + 后端 8787
```

单独起进程：`pnpm dev:web`、`pnpm dev:api`。

## 脚本

```bash
pnpm build            # tsc -b && vite build
pnpm prices:import --all          # 导入 data/fc_*.json、data/ajk_full_*.json 的房价
pnpm fc:probe                     # Firecrawl 抓取探针
pnpm fc:fetch                     # 抓取房价（安居客等免登录源）
pnpm fc:fetch-biz --district tongzhou   # 按「商圈 × 排序」抓链家（需 data/lianjia.cookie）
pnpm fc:login                     # 链家登录态采集
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

## 不入库

`.env`（高德 Key）、`data/*.db*`、`data/lianjia.cookie`、`data/cookies-*.json` 已在 `.gitignore` 中排除。
