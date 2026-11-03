# 部署与数据

## 一份数据（服务器为准）

线上实例 `/opt/luohu` 里的 `data/luohu.db` 是**唯一权威数据**。本地的 `data/luohu.db` 已于 2026-11-03 删除，仓库里不再保留任何 `.db` 文件。

- 本地开发默认连线上：`pnpm dev` → Vite 把 `/api` 反代到 `https://luohu.allen1991.cc.cd`
- 想跑本地 API：`pnpm dev:local`（`vite --mode localapi` 读 `.env.localapi` 里的 `LUOHU_API=http://127.0.0.1:8787`）。此时没有本地库，`server/db.mjs` 会新建一个**只有表结构的空库**并打印提示，别拿它当正式数据
- 需要在本地看线上数据：`pnpm db:pull` → `data/luohu.remote.db`（服务器先 `VACUUM INTO` 出一致快照再下载，只读用途）；要可写副本就 `cp data/luohu.remote.db data/luohu.db`，或直接 `LUOHU_DB=data/luohu.remote.db`
- 本地灌了新数据要推上去：`pnpm db:push`（见下，需要先有上面那个本地副本）

## 推数据（db:push）

`node scripts/push_db.mjs [--dry] [--no-pull]`

1. 先拉服务器快照，作为「服务器优先」的依据
2. 以本地 `data/luohu.db` 为底 `VACUUM INTO` 出 `data/luohu.merge.db`
3. **服务器优先的表**整表覆盖回合并库：`auth_user`、`auth_session`、`setting`、`person`、`education`、`employment`、`residence`、`honor`、`tax_record`、`price_point`、`workplace`（线上填的档案、登录态不会被本地旧快照盖掉）
4. 其余表（community / community_price / school / school_rank / community_route / transit_cache …）用本地最新数据
5. 上传到 `/opt/luohu/data/luohu.merge.db`，校验大小后：停 `luohu` → 旧库留 `luohu.db.bak-<时间戳>`（保留 3 份）→ 换库 → 起服务 → `PRAGMA integrity_check`

注意：拉快照到换库之间（约 1 分钟）线上新写入会丢；要绝对稳妥就先停服务再拉快照。

## 部署

```bash
pnpm build                 # 前端产物
node scripts/deploy.mjs    # 代码 + dist + 重启 luohu.service
node scripts/deploy.mjs --restart
node scripts/deploy.mjs --pull
```

抓取产物（data/fc_*.json 等在本地生成）要落到权威库，走 `--import`，别在本地导：

```bash
node scripts/deploy.mjs --import data/fc_5i5j_daxing.json            # 只补价格
node scripts/deploy.mjs --import data/fc_5i5j_daxing.json --create   # 允许新建无坐标小区
node scripts/deploy.mjs --import data/a.json data/b.json --dry       # 多文件预演
```

服务器：47.95.238.28，SSH 22 外网封，全部走 1Panel v1 API（Key 在 `~/.1panel_key` 或 `ONEPANEL_KEY`）。
线上入口：Cloudflare Tunnel `junjun` → `luohu.allen1991.cc.cd` → `127.0.0.1:8766`。

已知坑：`files/save` 新建文件会报「目标路径不存在」；`files/upload` 对 `/opt/luohu/scripts` 这类子目录会静默不落地，小文件用 base64 + shell 写入最稳；`/etc/systemd/system` 不在 1Panel 可写白名单，unit 文件同样走 shell 落盘。

## 定时抓取（房价周更）

权威库在服务器，抓取分两地跑，谁也不覆盖谁：

```bash
# 服务器 crontab（root），每周日 03:00；flock 防重叠，日志追加
0 3 * * 0 cd /opt/luohu && /usr/bin/flock -n /tmp/luohu-weekly.lock \
  /root/.nvm/versions/node/v24.21.0/bin/node scripts/fc/weekly.mjs \
  --only 5i5j --delay 1200 >> /opt/luohu/data/logs/cron-weekly.log 2>&1
```

我爱我家在服务器侧完全正常（probe 200 / 285KB / 40 条；连抓三页稳定 316KB、每页 52 个 `xq_gz`），抓完直接写 `/opt/luohu/data/luohu.db`，实测 4/4 成功、133 秒。

安居客放不上服务器：58 的 CDN 对云厂商 IP 段做了风险标记，`m.anjuke.com` 一律返回约 5KB 的「安全验证」页、`c-li-item` 计数为 0；Android UA、微信 UA、带/去 Referer、伪造 `X-Forwarded-For` 五个变体全灭（5332 / 5349 / 957 / 957 / 957 字节），首次 probe 偶尔能过、之后必然触发。所以安居客留本机，同样是每周自动跑：

```bash
# 本机 Windows 计划任务 luohu-price-weekly，每周日 00:00
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fc/install-weekly-task.ps1 -Time 00:00
# 等价于：node scripts/fc/weekly.mjs --only anjuke --push
```

`--push` 不上本地库，改用 `scripts/deploy.mjs --import data/fc_anjuke_<区>.json --create` 走 1Panel 通道写权威库；本地 JSON 只是缓存与重跑材料。本机 00:00、服务器 03:00，错开三小时避免两边同时写库。非管理员注册的任务是 Interactive 登录类型：锁屏会跑，注销或关机不跑；要无人值守跑就在管理员 PowerShell 里执行同一条命令（自动升 S4U）。

排障要点：
- `scripts/fc/` 目录在服务器上原本不存在，`run.mjs` 依赖同目录的 `firecrawl.mjs`，漏传会 `ERR_MODULE_NOT_FOUND`。
- 1Panel 的 `cronjobs/search` 恒返回空数组（`create` 却回 200），确认是否落地看系统 `crontab -l`；cronjob id=2 被 `deploy.mjs` 当远程执行槽占用（`cronjobs/update` 写脚本 + `cronjobs/handle` 触发），别拿它当常规定时任务。
- `curl -w %{size_download}` 在 `--compressed` 下报的是压缩后字节，判断是否被拦要看解压后文件大小或页面里 `c-li-item` / `xq_gz` 的计数。

## 备份

`scripts/backup.mjs`：`VACUUM INTO` 出一致快照，保留最近 14 份，落在 `/opt/luohu/backups/`。
systemd timer `luohu-backup.timer` 每天 03:30 跑一次（`luohu-backup.service`），日志 `/var/log/luohu-backup.log`。

手动：`systemctl start luohu-backup.service`

## 账号

单人账号存 `auth_user`（id=1），scrypt 加盐，会话表 `auth_session`（cookie `luohu_sid`，30 天）。
首次部署时按 `LUOHU_USER` / `LUOHU_PASSWORD` 建号，改密码：`node scripts/set_password.mjs`（本地对目标库执行）。
