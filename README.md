# TradeLedger

本地优先、单用户的**加密合约交易复盘台账**。界面沿用 Hugging / CNote 的仪表盘形态，
数据层与实现全部重写：Node.js 内置 `node:sqlite`，**零第三方依赖**。需要 Node.js 24+。

> 不做下单、不接交易权限、不做多租户。一份部署 = 一个用户，数据在自己手里。

## 快速开始

```bash
cd tradeledger
cp .env.example .env      # 填入 TRADELEDGER_PASSWORD
npm start                 # http://127.0.0.1:8790
npm run seed              # 生成 564 笔演示数据（首次启动会自动执行）
npm run reset             # 清空并重新生成演示数据
```

`.env` 由 `npm start` 自动读取（`--env-file-if-exists`）；也可以直接用环境变量覆盖。

访问密码来自 `TRADELEDGER_PASSWORD`；未设置时回退 `demo1234`（仅开发用，登录页会提示）。

```bash
# Windows PowerShell
$env:TRADELEDGER_PASSWORD="your-password"; npm start

# macOS / Linux
TRADELEDGER_PASSWORD=your-password npm start
```

其他环境变量见 `.env.example`：

| 变量 | 说明 |
|---|---|
| `TRADELEDGER_PASSWORD` | 访问密码（必填） |
| `TRADELEDGER_MASTER_KEY` | 凭据加密主密钥；64 位十六进制，或任意口令经 SHA-256 派生 |
| `SYNC_LOOKBACK_DAYS` | 首次同步回溯天数，默认 180 |
| `SYNC_BATCH_LIMIT` | 单批最多拉取条数，默认 1000 |
| `SYNC_WORKER_SECONDS` | 后台自动回溯间隔，默认 5 秒；0 = 关闭 |
| `SYNC_WINDOW_BUDGET` | 单批最多翻多少个 7 天窗口，默认 8 |
| `TRANSFER_REFRESH_HOURS` | 资金流水刷新间隔，默认 6 小时 |
| `SPOT_REFRESH_HOURS` | 现货成交刷新间隔，默认 1 小时 |
| `LIVE_REFRESH_SECONDS` | 余额/持仓/资金费率刷新间隔，默认 60 秒；0 = 关闭 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 访问交易所 API 的代理（自动走 CONNECT 隧道） |
| `PORT` / `HOST` / `DB_FILE` / `TZ` | 端口、监听地址、数据库路径、统计时区 |
| `BACKUP_DIR` | 本地快照目录，默认 `data/backups` |

未配置 `TRADELEDGER_MASTER_KEY` 时，首次运行会在数据库同目录生成 `data/master.key`。
**迁移时请把数据库和 master.key 一起带走**，否则已保存的 API 凭据无法解密。

如果本机无法直连交易所，程序会自动探测 `127.0.0.1:7890 / 7897 / 10809 / 1080`
上的本地代理（Clash/V2Ray 常见端口）；也可以显式设置 `HTTPS_PROXY`，或用
`TRADELEDGER_AUTO_PROXY=0` 关闭自动探测。添加账户时的验证请求最长 12 秒，失败会在页面上给出原因。

```bash
npm run sync              # CLI：把所有真实账户拉到没有更多历史
```

## 功能

- **仪表盘**：KPI、总盈亏/交易预期/回撤、多空拆分、按天/累计/回撤曲线、小时/星期分布、
  **周 × 小时盈亏热力图**、资金费与手续费、订单类型与仓位报告、标签报告、复盘覆盖率。
- **页面切换**：站内导航走局部更新（fetch + View Transition），不再整页刷新闪白；
  浏览器前进/后退、筛选表单同样生效，无 JS 时仍按普通链接工作。
- **侧栏结构**：复盘功能平铺；CSV 导入、交易所、标签、AI 模型收进「设置与数据」二级导航，
  设置区内部用标签页切换。
- **交易记录**：新增/编辑/删除、筛选、排序、分页、行内复盘笔记。
- **单笔详情**：把盈亏摊开——毛盈亏 = 净盈亏 − 手续费 − 资金费，并按开平仓价独立复算。
- **CSV 导入**：上传或粘贴，自动跳过标题/账户说明行、识别 UTF-8/UTF-16 与常见分隔符，
  按 OKX / Binance / Bybit / Bitget / Gate / Hyperliquid 的表头别名自动映射；
  支持「一行一笔已平仓交易」和「逐笔成交（FIFO 配对）」两种格式，可改列映射、预览、
  时区、费用符号与市场类型（合约 / 现货），按外部 ID 或业务指纹去重，记录导入审计；
  现货逐笔成交按 long-only FIFO 配对，不会生成开空交易。列映射可保存为模板。
- **交易所只读同步**：OKX / Binance / Bybit / Bitget / Gate.io / Hyperliquid。
  API Key 用 AES-256-GCM 加密存储；添加账户后**后台自动回溯历史**，带进度条，
  关掉页面也会继续，进程重启可断点续传。
  每个账户可选 90 天 / 180 天 / 1 年 / 2 年 / 10 年 / 全部可用；受交易所保留期限制，
  OKX / Bitget 约 3 个月、Gate 约 6 个月，Binance / Bybit / Hyperliquid 可更久。
  支持「重新回溯」，已有交易按去重保留。
- **资金流水**：充值、提现、内部划转统一时间线；随账户同步每 6 小时更新，
  可按账户、类型、币种、日期筛选，并显示总充值 / 总提现 / 净流入。
- **现货**：现货余额、持仓市值、long-only FIFO 成本基础与逐笔成交；
  现货成交按 FIFO 配对后进入交易记录（`market=spot`），仪表盘和交易记录可切换「全部 / 合约 / 现货」。
  OKX / Bybit / Hyperliquid 自动拉全量现货成交；Binance / Bitget / Gate 需要交易对（可留空按余额自动推导）。
- **完整备份与恢复**：`VACUUM INTO` 一致性快照，含笔记图片 BLOB；本地保留策略、
  WebDAV 自动上传（gzip + 可选 AES-256-GCM）、远端清单与保留份数；恢复走
  「暂存 → 重启替换」，并自动保留恢复前数据库。
- **实时持仓**：后台定时刷新余额、未实现盈亏、当前资金费率与下次结算时间；
  同一轮刷新也会更新现货余额、持仓市值与成本覆盖率。仪表盘面板每 30 秒读一次本地快照，可手动“立即刷新”。
- **资金费**：OKX 直接取仓位历史的 fundingFee；其余五家单独拉资金费流水，
  按币种+持仓时间匹配到交易，更新净盈亏。未匹配的资金费会在面板单独显示。
- **对账**：用开平仓价 × 数量独立复算毛盈亏，列出不一致与缺字段的交易。
- **盈亏日历**：月视图日盈亏、周/月汇总。
- **标签与笔记**：标签统计；笔记分五类——周期复盘、交易对档案、策略手册、现货备注、自由笔记。
  交易对档案会自动汇总该交易对上的逐笔复盘；现货持仓备注可在现货页直接编辑，并同步到笔记分类。
  笔记支持 Markdown 与图片上传（图片存本地 SQLite）。
- **现货复盘**：现货持仓备注 + 已实现现货交易的行内复盘；现货页可直接写，
  交易对档案和现货备注都会出现在笔记页。点进某个交易对有独立详情页：
  当前持仓、买入 / 卖出记录、FIFO 已实现交易（含持仓时长）、交易对档案与现货备注。
- **提示条**：页面顶部的成功 / 信息提示右上角有 × 可手动关闭，成功提示 5 秒、
  信息提示 8 秒后自动消失；带表单或按钮的提示（如恢复确认）不会自动关闭。
- **周报 / AI 复盘**：按 ISO 周生成指标摘要与复盘问题；可配置 OpenAI 兼容接口 /
  Anthropic / Ollama，让模型基于周报和笔记生成复盘；也能只导出 Markdown/JSON 给外部模型。
- **设置**：导出全量 JSON / 交易 CSV、清除演示数据、清空全部数据。

## 目录

```
src/server.js              HTTP 适配与静态资源
src/db.js                  SQLite 连接、schema、事务
src/store.js               数据读写（交易、账户、凭据、同步审计）
src/stats.js               统计引擎（纯函数）
src/breakdown.js           单笔盈亏推导（纯函数）
src/csv.js                 CSV 解析、列映射、去重指纹（纯函数）
src/sync.js                分批游标同步引擎
src/sync-worker.js          添加账户后的后台自动回溯
src/live.js                 余额/持仓/资金费率刷新
src/exchanges/             六家交易所只读适配器 + 成交配对 + 资金费
src/reconcile.js           对账（纯函数）
src/review.js              周报 / AI 上下文（纯函数）
src/llm.js                 LLM 配置与调用（OpenAI 兼容 / Anthropic / Ollama）
src/markdown.js            Markdown 渲染与摘要（纯函数）
src/auth.js                单密码会话
src/routes.js              路由
src/views/                 服务端渲染页面
public/                    样式与少量交互脚本
tests/                     单元测试（node --test）
scripts/smoke.mjs          HTTP 冒烟测试
docs/REQUIREMENTS.md       需求规格
```

## 测试

```bash
npm test                  # 纯函数单元测试
npm run smoke             # 需要先 npm start（默认 127.0.0.1:8790）
                          # 冒烟脚本依赖演示数据：启动时加 SEED_DEMO=1
npm run backup            # 创建本地快照；启用 WebDAV 时顺带上传
npm run backup:list       # 列出本地 / 远端备份
npm run restore:stage -- <文件名>   # 暂存一个备份
npm run restore           # 应用待恢复备份（需先停止服务）
```

## 数据与备份

- 默认数据库：`data/tradeledger.db`（WAL 模式）。**不要在服务运行时直接复制 `.db` 文件**，
  WAL 里可能还有未落盘的数据；程序用 `VACUUM INTO` 生成一致性快照。
- 设置页「完整备份与恢复」可以：
  - 立即创建本地快照，下载 / 恢复 / 删除；
  - 配置 WebDAV（Nextcloud、坚果云等）自动上传，设置间隔与保留份数；
  - 可选 gzip + AES-256-GCM 加密（备份密码至少 8 位）；
  - 从本地或 WebDAV 下载备份并暂存，重启服务后自动替换数据库。
- 笔记图片以 BLOB 存在 SQLite 的 `resources` 表，完整快照会自动包含图片；
  JSON / CSV 导出不包含图片二进制。
- 恢复采用「暂存 + 重启」：先写入 `data/restore-pending.db`，服务下次启动时把当前库移到
  `data/backups/pre-restore-*.db`（含 WAL），再替换。恢复前会自动保留旧库。
- WebDAV 密码与备份密码都用本机主密钥加密后存库；**备份密码本身不会被上传**，请自行记住。
  换机器恢复时，如果只带走数据库和 master.key，交易所 API 凭据仍可解密；如果 master.key 丢失，
  需要重新填写 API Key。
- `npm run reset` 会重建数据库；执行前请先停掉服务。

## Docker 部署

推荐海外 VPS（2 核 2G 起）+ Docker Compose + Caddy。数据库落在宿主机 `data/`，升级和备份都简单。

### 1. 准备

- Docker Engine 24+、Compose v2
- 域名 A 记录指向 VPS 公网 IP
- 安全组/防火墙放行 80/443；如果 80/443 不可用，改用 Cloudflare Tunnel（见第 6 节）
- Linux 宿主机上给数据目录写权限（容器内以 uid 1000 运行）：

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

### 2. 启动

镜像由 GitHub Actions 在每次 push 到 main 时自动构建并发布到 ghcr.io（标签 `latest` + 提交号，amd64/arm64 双架构）：

```bash
git clone <你的仓库地址> tradeledger
cd tradeledger
cp .env.docker.example .env
# 编辑 .env：TRADELEDGER_PASSWORD、TRADELEDGER_MASTER_KEY、TRADELEDGER_DOMAIN
docker compose up -d          # 直接拉取 ghcr 镜像，服务器上无需构建
# 拉不动 ghcr（国内网络）或想用本地代码时：docker compose up -d --build
```

`.env` 里两个必填项：

- `TRADELEDGER_PASSWORD`：至少 16 位随机密码；
- `TRADELEDGER_MASTER_KEY`：64 位十六进制，用 `openssl rand -hex 32` 生成。**这个值决定交易所 API 凭据能否解密，迁移时不能换。**

首次启动**不会写入任何演示数据**（`SEED_DEMO` 默认关闭；想先看效果可显式设 `SEED_DEMO=1`）。访问 `https://你的域名`；本地测试可把域名设为 `localhost`（Caddy 用内部证书，浏览器会提示不受信任）。

> 镜像可见性：仓库为私有或包默认私有时，到 GitHub → 右上角头像 → Packages → `tradeledger` → Package settings → Danger Zone → Change visibility → Public，改一次即可让所有服务器匿名 `docker pull`。

### 3. 迁移已有数据

```bash
# 本地先生成一致性快照（不要直接复制运行中的 .db）
npm run backup

# 上传快照到服务器，作为主库
scp data/backups/tradeledger-YYYYMMDD-HHMMSS.db user@vps:/path/tradeledger/data/tradeledger.db

# 主密钥必须与本地一致
cat data/master.key
# 把输出填到服务器 .env 的 TRADELEDGER_MASTER_KEY
```

如果本地是通过 `TRADELEDGER_MASTER_KEY` 环境变量启动的，直接用同一个值即可。数据库和 master key 必须配对，否则旧 API 凭据无法解密，需要重新填写。

### 4. 备份

- 首选设置页的 WebDAV 自动备份；
- 或备份整个 `data/` 目录 + `.env`（包含数据库、笔记图片、快照、master.key）；
- 恢复时把快照放到 `data/restore-pending.db`，重启容器后自动替换。

### 5. 更新

```bash
git pull
docker compose up -d --build
```

更新前先在设置页创建本地快照。

### 6. 80/443 不可用：Cloudflare Tunnel

不用 Caddy，改用 cloudflared 容器，通过出站连接回源，无需开放任何入站端口：

```yaml
cloudflared:
  image: cloudflare/cloudflared:latest
  restart: unless-stopped
  command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
```

在 Cloudflare 控制台把 Public Hostname 指向 `http://tradeledger:8790`（同一个 Compose 网络），再配一条 Access 策略。

### 7. 安全清单

- 应用容器不发布 `8790`，只通过 Caddy/Tunnel 暴露；
- 使用强密码，建议再加 Cloudflare Access 或 Tailscale；密码仍是示例值或少于 8 位时服务会拒绝启动；
- 交易所 API 只给只读权限；
- `master.key` 离线保存一份；示例值 `replace-with-64-hex-chars` 会导致启动失败；
- SQLite 必须放本地磁盘，不要放 NFS/SMB。

仓库附带一个 GitHub Actions 模板 `deploy/github-actions-test.yml`；复制到 `.github/workflows/test.yml` 即可启用测试与镜像构建（推送 token 需要 `workflow` 权限）。

## 已知限制（v0.5）

- 后台会自动回溯历史，但**默认每 5 秒只推一批**（`SYNC_WORKER_SECONDS`），避免把交易所限流打满；
  账户很多时首次全量会花一些时间。单批最多翻 8 个 7 天窗口（`SYNC_WINDOW_BUDGET`）。
- 历史回溯深度由交易所接口保留期决定：OKX / Bitget 约 3 个月，Gate 约 6 个月，
  Binance / Bybit / Hyperliquid 可更久；“全部可用”取该交易所上限，不是字面意义的全部。
  更早的数据请用交易所导出的 CSV 手动导入（优先用「已平仓/已实现盈亏」报表）。
- CSV 逐笔成交按单次导入内的 FIFO 配对；如果开仓与平仓被拆到两个文件、或持仓跨年跨文件，
  可能无法配对。建议导出包含完整开平仓周期的成交明细，或直接用已平仓报表。
- 资金费：OKX 取仓位历史里的 `fundingFee`；Binance / Bybit / Bitget / Gate / Hyperliquid
  单独拉资金费流水，再按「同账户 + 同币种 + 持仓时间」匹配到交易。交易所对资金费的正负号与返回字段
  不完全一致，目前按各家原始符号处理；如果发现某个账户资金费方向反了，先看该交易所的账户流水符号。
- 交易匹配不到持仓区间时，资金费会保留为「未匹配」，不会硬塞进某笔交易。
- 资金流水（充值/提现/内部划转）需要钱包/资产只读权限；某些交易所的 P2P、法币买卖不在标准只读 API 内，
  可能拿不到。期权、策略机器人尚未接入。
- 现货：OKX / Bybit / Hyperliquid 自动拉全量现货成交；Binance / Bitget / Gate 需要交易对（留空会按当前
  现货余额推导）。现货成本基础依赖买入成交覆盖；如果成本数量与当前余额不一致（例如早期买入不在回溯窗口内），
  页面会标注「成本数量」并且不计算未实现盈亏。现货已实现交易按单次同步窗口内的成交 FIFO 配对，
  开仓在窗口外的卖出不会生成已实现交易，但持仓和逐笔成交仍会保留。
- 实时持仓/资金费率需要各交易所的持仓接口；合约覆盖 USDT 本位线性合约（Hyperliquid 为 USDC 永续），
  币本位/期权未适配。
- AI 复盘用的是你配置的模型和 Key：应用不内置额度，也不做内容审核；把交易数据发给第三方模型前请自行确认隐私边界。
- Markdown 图片存在本地 SQLite（单张 ≤5MB），没有做图床/CDN；适合个人复盘，不适合多用户公开站点。
  完整备份会连同图片一起打包；JSON / CSV 不包含图片。
- 备份恢复必须重启服务才能替换数据库；WebDAV 备份密码不会上传，忘记后无法解密已加密的远端备份。
- 实盘适配器需要你自己的只读 Key 验证；仓库测试用固定成交数据覆盖配对、去重、资金费匹配与同步引擎，
  不包含真实交易所凭据。添加账户时的「验证并保存」会先做一次真实连接测试。

## 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| OKX `50105 Request header OK-ACCESS-PASSPHRASE incorrect` | Passphrase 不正确。它是创建 API 时单独设置的，不是登录密码；区分大小写，前后空格也会影响。可在 OKX 删除旧 Key、新建一个只读 Key 后重试。 |
| OKX `50111 Invalid OK-ACCESS-KEY` | API Key 无效，或复制时带了多余字符。 |
| 添加账户时提示超时 | 本机无法直连交易所。程序会自动探测 7890/7897/10809/1080 代理；也可以显式设置 `HTTPS_PROXY`。 |
| OKX `51000 Parameter after error` | 分页游标错误（旧版本把 `posId` 当成 `after`）。已修复为 `uTime + 1`；重新添加账户即可。 |
| OKX `50011` | 真正的限流。后台 worker 会自动退避重试，也可以稍后再点同步。 |
| `401` 且提示 IP 不在白名单 | 把当前出口 IP 加入 OKX API 白名单，或临时关闭 IP 限制。走代理时白名单要填代理的出口 IP。 |

## 部署形态

当前应用是 **Node.js 24 + SQLite 的长期进程**，适合本机或一台 VPS：

- **本机**：`npm start`，需要能访问交易所；国内网络可用本地代理。
- **VPS（推荐用于 24/7）**：把项目、`data/tradeledger.db`、`data/master.key` 一起放到
  香港/新加坡/日本等能访问交易所的机器，用 Caddy/Nginx 反代加 HTTPS；数据层不用改。
- **Cloudflare Tunnel**：可以把本机服务安全暴露到公网，但出口仍是本机，网络问题不会消失。
- **Cloudflare Workers**：**当前不能直接部署**。`node:sqlite`、`fs`、`node:http/tls` 代理、
  `setInterval` 后台任务都需要改写成 D1/R2/Queues/Cron；而且 Worker 出口 IP 不固定，
  OKX 的 IP 白名单需要关闭。这是一次数据层与运行时重写，不是改配置。

## 许可与来源

代码原创。产品形态参考了已停止运营的 hugging.com，以及若干开源交易日志项目的公开设计思路；
具体借鉴清单与边界见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md#7-借鉴来源与边界)。
