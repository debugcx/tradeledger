# TradeLedger 需求规格（v0.1）

> 一句话：**本地优先、单用户、以「复盘」为中心**的加密合约交易台账。
> 界面语言沿用 Hugging / CNote 的仪表盘形态（深色、侧栏、面板、SVG 图表），
> 但代码、数据层与交互全部重写，不依赖旧项目。

---

## 1. 背景与目标

### 1.1 背景

`hugging.com` 是加密交易者用来记录与复盘交易的工具，已停止运营。旧项目 CNote 基于
Wayback 存档重建，但存在三个结构性问题：

1. **统计黑箱**：只给结果数字，不解释盈亏如何得出，用户无法核对。
2. **导入缺失**：只能靠交易所 API 同步或逐笔手录，换工具的历史数据进不来。
3. **复盘维度单一**：有按小时、按星期，但没有「周 × 小时」这类交叉维度。

### 1.2 目标

做一个**自己每天愿意打开**的交易复盘台账：

- 数据在自己手里（单文件 SQLite，可导出）。
- 每一笔盈亏都能摊开核对。
- 任何来源的历史交易都能通过 CSV 进来。
- 打开首页 10 秒内能回答：最近赚不赚、哪里在亏、什么时段/标签/币种有效。

### 1.3 非目标

- 不下单、不接实盘交易权限、不做信号/跟单/社交。
- 不做多租户 SaaS；一份部署 = 一个用户。
- v0.1 不做交易所 API 实时同步（列入 P1）。

---

## 2. 用户与场景

**用户画像**：单人、自有服务器或本机、主要交易 U 本位永续合约、同时用过 2~4 家交易所、
有历史 CSV 导出、愿意每周花 30 分钟复盘。

| 编号 | 场景 | 期望 |
|---|---|---|
| S1 | 每天收盘后 | 打开首页看今日盈亏、当前回撤、是否过度交易 |
| S2 | 每周复盘 | 按标签/币种/时段找出亏损来源，写复盘笔记 |
| S3 | 换交易所/换工具 | 把历史成交 CSV 导入，去重、可预览、可回滚 |
| S4 | 怀疑统计不对 | 点开单笔交易，看到「净盈亏 = 毛盈亏 + 手续费 + 资金费」的推导与独立复算 |
| S5 | 月度回顾 | 日历视图看每天盈亏，定位连续亏损周 |
| S6 | 备份/迁移 | 一键导出全量 JSON / 交易 CSV |

---

## 3. 功能需求

优先级：**P0 = v0.1 必须可用**；P1 = 下一阶段；P2 = 可选。

### 3.1 认证与账户（P0）

| ID | 需求 | 验收标准 |
|---|---|---|
| A1 | 单密码登录 | 未配置密码时登录页明确提示如何配置，不存在绕过入口 |
| A2 | 会话 Cookie | HttpOnly + SameSite=Lax；「7 天内免登录」有效期 7 天 |
| A3 | 退出登录 | POST /logout 清除会话与 Cookie |
| A4 | 暴力尝试限速 | 同一 IP 连续失败 10 次后锁 5 分钟（内存计数即可） |

> 不做注册、邮箱、找回密码。密码来自环境变量 `TRADELEDGER_PASSWORD`。

### 3.2 交易记录（P0）

| ID | 需求 | 验收标准 |
|---|---|---|
| T1 | 手动新增 | 必填：币种、方向、开/平仓时间、开/平仓价、数量；盈亏可自动算 |
| T2 | 编辑 | 可改全部业务字段并保留 `source`、`external_id` |
| T3 | 删除 | 二次确认；同时删除标签关联 |
| T4 | 列表 | 分页（默认 50/页）、按时间倒序 |
| T5 | 筛选 | 方向、盈亏结果、币种、订单类型、标签、有无笔记、日期区间、关键词 |
| T6 | 排序 | 时间 / 盈亏 / 持仓时长 / 名义价值 |
| T7 | 单笔详情 | 展示全部字段 + 盈亏推导 + 独立复算 |
| T8 | 行内笔记 | 列表内直接写复盘笔记，AJAX 保存不跳页 |

### 3.3 CSV 导入（P0）

| ID | 需求 | 验收标准 |
|---|---|---|
| I1 | 两种输入 | 上传 `.csv/.txt` 文件或直接粘贴文本 |
| I2 | 自动解析 | 自动识别分隔符（`,` `;` `\t` `|`）、引号、BOM、空行 |
| I3 | 列映射 | 自动识别常见中英文表头；识别结果可在页面上逐字段修改 |
| I4 | 预览 | 提交前展示前 10 行解析结果和逐行错误原因 |
| I5 | 时区 | 可选 UTC / UTC+8 / UTC-5 / UTC-8；无时区字符串按所选偏移解释 |
| I6 | 费用符号 | 可声明「正数 = 支出」（默认开，适配多数交易所导出） |
| I7 | 去重 | 同账户内按 `external_id` 去重；无 ID 时按业务指纹去重；文件内重复也跳过 |
| I8 | 部分失败 | 单行错误不阻断整体；导入后报告「成功 / 跳过重复 / 失败」及原因 |
| I9 | 审计 | 每次导入记录文件名、行数、成功数、跳过数、时间 |
| I10 | 上限 | 单次 ≤ 8MB、≤ 50,000 行；超限直接报错 |

### 3.4 仪表盘（P0）

| ID | 模块 | 说明 |
|---|---|---|
| D1 | KPI 条 | 总交易数、胜率、平均持仓时长、多/空占比 |
| D2 | 统计面板 | 总盈亏、交易预期、日均收益/成交量/次数、平均盈亏、最大连胜/连亏、总交易量 |
| D3 | 多空分区 | 各自数量、占比、胜率、平均时长、高于/低于均时胜率、总盈亏 |
| D4 | 权益曲线 | 按天盈亏、累计盈亏、回撤（滚动峰值） |
| D5 | 分布图 | 按小时、按星期、持仓时长、按时长盈亏、币种盈亏 |
| D6 | **周 × 小时热力图** | 7×24 交叉表；颜色深浅 = 盈亏绝对值；tooltip 显示笔数/胜率；列出最佳/最差/胜率最高时段 |
| D7 | 资金费与手续费 | 收/付资金费、净资金费、净手续费、做市返佣、交易费用 |
| D8 | 订单类型/仓位报告 | 市价/限价/其他的笔数、占比、盈亏、胜率、均值；仓位区间分桶 |
| D9 | 标签报告 | 每个标签的笔数、总盈亏、胜率、平均盈亏、平均时长、交易预期 |
| D10 | 按天明细 | 最近 30 个交易日 |
| D11 | 最近交易 | 最近 50 笔 |
| D12 | 复盘覆盖率 | 有笔记的交易占比 + 最近复盘入口 |
| D13 | 时区声明 | 所有按小时统计标明所用时区 |

### 3.5 盈亏推导（P0，「show its work」）

单笔详情固定展示：

```
毛盈亏（价差）      = 净盈亏 − 手续费 − 资金费
手续费              = 交易所记录（正=返佣，负=支出）
资金费              = 交易所记录（正=收取，负=支付）
净盈亏              = 毛盈亏 + 手续费 + 资金费
────────────────────────────────
独立复算            = (平仓价 − 开仓价) × 数量 × 方向
与毛盈亏差异        = 复算值 − 毛盈亏
```

- 复算差异在 1% 或 $0.01 以内 → 标「一致」。
- 超出 → 标「不一致」，并解释常见原因（合约面值 / 币本位 / 分批成交 / 记录的是交易所净额）。
- 该模块**不修改任何数据**，只做展示与校验。

### 3.6 盈亏日历（P0）

- 月视图，每天显示当日净盈亏、笔数。
- 周汇总、月汇总；盈利/亏损/无交易三种底色。
- 上一月 / 下一月 / 回到本月。

### 3.7 标签与笔记（P0）

- 标签：新建（名称 + 颜色）、删除、按标签统计；删除标签不删交易。
- 独立笔记：新建、编辑、删除、列表；支持纯文本/Markdown 源文（按纯文本渲染）。
- 交易笔记：每笔交易一段复盘文本 + 更新时间。

### 3.8 设置与数据（P0）

| ID | 需求 |
|---|---|
| S1 | 修改显示名与简介 |
| S2 | 导出全量 JSON（交易、标签、笔记、账户） |
| S3 | 导出交易 CSV（字段与导入器兼容，可再导入） |
| S4 | 清除演示数据（只删 `is_demo=1` 账户下的数据） |
| S5 | 清空全部数据（二次确认，不可恢复） |
| S6 | 显示数据库大小、交易数、最近导入记录 |

### 3.9 交易所同步（P1）

- 只读 API Key；支持 OKX / Binance / Bybit / Bitget / Gate / Hyperliquid。
- 凭据加密存储（`node:crypto` AES-256-GCM，主密钥来自环境变量）。
- 分批游标同步，断点续传；限速与错误重试。
- 与 CSV 导入共用同一套去重与对账逻辑。

### 3.10 AI 复盘（P2）

- 导出结构化复盘上下文，供外部 LLM/Agent 使用；不在应用内保存 API Key。
- 生成「本周最差 3 个时段 / 标签」摘要草稿。

---

## 4. 指标口径（必须统一）

| 指标 | 定义 |
|---|---|
| 已平仓交易 | `realized = 1` 的记录；v0.1 导入/手录均为已平仓 |
| 胜率 | `pnl > 0` 的笔数 / 总笔数 |
| 交易预期 | `胜率 × 平均盈利 − 败率 × 平均亏损` |
| 平均亏损 | 亏损笔 `abs(pnl)` 的均值（正数展示） |
| 手续费符号 | 正数 = 返佣/收入，负数 = 支出 |
| 资金费符号 | 正数 = 收取，负数 = 支付 |
| 净盈亏 | 已扣手续费与资金费；`毛盈亏 = pnl − fee − funding` |
| 持仓时长 | `close_time − open_time` |
| 高于均时胜率 | 该方向中 `时长 ≥ 该方向平均时长` 的子集胜率 |
| 回撤 | 按日累计盈亏相对历史峰值的回落 |
| 活跃交易日 | 有已平仓交易的日期数 |
| 时段统计 | 按 `close_time`、服务端本地时区（可用 `TZ` 固定） |

---

## 5. 信息架构

```
/login
/dashboard              仪表盘
/dashboard/calendar     盈亏日历
/dashboard/journal      交易记录
/dashboard/journal/new  手动记录
/dashboard/journal/:id  交易详情（盈亏推导 + 复盘笔记）
/dashboard/journal/:id/edit
/dashboard/import       CSV 导入
/dashboard/tags         标签
/dashboard/notes        笔记
/dashboard/settings     设置与数据
/api/summary            汇总统计（JSON）
/api/trades             交易明细（JSON）
/api/tags /api/notes    标签 / 笔记
/api/health             健康检查
```

侧栏顺序：仪表盘 → 盈亏日历 → 交易记录 → CSV 导入 → 标签 → 笔记 → 设置。

---

## 6. 数据模型（SQLite）

```sql
accounts(id, exchange, name, is_demo, created_at)
trades(id, account_id, external_id, symbol, side, order_type, size, notional,
       entry_price, exit_price, open_time, close_time, pnl, fee, funding,
       source, note, note_updated_at, created_at, updated_at)
tags(id, name UNIQUE, color)
trade_tags(trade_id, tag_id)
notes(id, title, content, created_at, updated_at)
sessions(token_hash, created_at, expires_at)
imports(id, account_id, filename, rows, inserted, skipped, failed, created_at)
meta(key, value)
```

- 时间统一存 UTC ISO 8601 字符串。
- `UNIQUE(account_id, external_id) WHERE external_id IS NOT NULL` 保证幂等。
- WAL 模式；写操作使用事务。

---

## 7. 借鉴来源与边界

| 来源 | 借鉴内容 | 边界 |
|---|---|---|
| hugging.com / CNote | 仪表盘信息架构、指标词典、深色视觉语言 | 不复制其代码/品牌/字体；新项目独立实现 |
| [Mouses007/Crypto-Trading-Journal](https://github.com/Mouses007/Crypto-Trading-Journal) | 周×小时热力图、标签统计、资金费/手续费拆分 | 只借鉴产品形态，不复制代码（GPL-3.0） |
| [madmatt112/tradr](https://github.com/madmatt112/tradr) | 「the journal shows its work」：盈亏推导可核对 | 只借鉴交互理念（Apache-2.0） |
| [LuxAlgo/trade-journal](https://github.com/LuxAlgo/trade-journal) | CSV 迁移导入、列映射、去重、审计 | 只借鉴流程设计（MIT） |
| [Bilovodskyi/ai-trading-journal](https://github.com/Bilovodskyi/ai-trading-journal) | 与交易所数字对账的思路（P1） | 只借鉴校验思路 |
| [stop-loss-enjoyer/plainbook](https://github.com/stop-loss-enjoyer/plainbook) | 纯文本导出、对 Agent 友好 | 导出格式自行设计 |

**许可红线**：GPL/AGPL 项目只读不抄代码；新项目代码全部原创。

---

## 8. 非功能需求

| 项 | 要求 |
|---|---|
| 运行时 | Node.js ≥ 24（使用内置 `node:sqlite`），零第三方依赖 |
| 数据量 | 10 万笔以内首页 < 1.5s（本机） |
| 安全 | 密码只从环境变量读取；会话 token 只存哈希；所有输出转义；上传大小限制 |
| 备份 | 单个 `.db` 文件 + 导出 JSON/CSV |
| 可移植 | `TZ` 控制统计时区；`PORT`/`HOST`/`DB_FILE` 可配置 |
| 可测试 | 统计与 CSV 解析为纯函数，单元测试覆盖；HTTP 冒烟测试覆盖全部路由 |
| 可访问性 | 表单有 label；颜色不是唯一信息载体（热力图有 tooltip 与文字表） |

---

## 9. 里程碑

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1 | P0 全部功能：认证、手录、CSV 导入、仪表盘、日历、标签、笔记、设置、导出、测试 | 已交付 |
| v0.2 | P1：交易所只读同步、对账报告、导入规则模板 | 已交付（同步由页面/CLI 触发） |
| v0.3 | P2：AI 复盘上下文导出、周报生成 | 已交付（不内嵌 LLM，不保存 LLM Key） |
| v0.4 | 五家资金费补齐、实时持仓/资金费率、后台自动回溯、应用内 LLM、Markdown 图片笔记 | 已交付 |
| v0.5 | 可配置历史范围、窗口预算、重新回溯、充提/内部划转资金流水 | 已交付 |
| v0.6 | 交易所 CSV 兼容层：智能表头、编码识别、六家格式预设、逐笔成交 FIFO 配对 | 已交付 |
| v0.7 | 现货实时同步：余额/持仓/成本基础/逐笔成交、市场切换 | 已交付 |

## 10. 验收清单（v0.1）

- [x] `npm start` 后可用环境变量密码登录
- [x] 564 笔演示数据下所有页面 200
- [x] 手动新增/编辑/删除交易后统计随之变化
- [x] CSV 预览可改列映射；导入 2 行后统计 +2；重复导入被跳过
- [x] 单笔详情展示盈亏推导与复算结论
- [x] 周×小时热力图有 168 个格子（空格显示为无数据）
- [x] 日历可翻月并显示每日盈亏
- [x] 导出 JSON 可重新导入（字段自洽）
- [x] `npm test` 与 `npm run smoke` 全绿

---

## 11. v0.2 / v0.3 实现说明与已知限制

### 11.1 已实现

| 需求 | 实现 |
|---|---|
| 只读 API Key | 添加账户时先调交易所只读接口验证；权限由用户在交易所侧控制 |
| 凭据加密 | AES-256-GCM；主密钥来自 `TRADELEDGER_MASTER_KEY`，否则生成 `data/master.key` |
| 六家交易所 | OKX、Binance、Bybit、Bitget、Gate.io、Hyperliquid |
| 分批游标 | `accounts.sync_state` 保存时间窗与游标；`sync_done` 标记回溯完成 |
| 断点续传 | 中途失败保留上一次游标；下次从断点继续 |
| 去重 | 与 CSV 共用 `UNIQUE(account_id, external_id)`；成交配对用业务指纹 |
| 审计 | `sync_runs` 记录每次批次拉取/写入/跳过/失败 |
| 导入模板 | 列映射按「字段 → 表头名」保存，换列顺序/复用同类导出时可直接套用 |
| 对账 | 独立复算毛盈亏，列出不一致与缺字段交易，按来源统计一致率 |
| AI 上下文 | `/dashboard/review` 与 `/api/review?format=md|json`；不调用外部模型 |

### 11.2 已知限制

1. **自动回溯节流**：后台 worker 默认每 5 秒推一批（`SYNC_WORKER_SECONDS`），账户多时首次全量耗时较长。
2. **资金费符号与覆盖**：OKX 直接使用 `fundingFee`；其余五家单独拉流水再按币种+持仓时间匹配。
   各家字段与正负号不一致，按原始符号入库；匹配不到的保留为「未匹配」。
3. **品种范围**：USDT 本位线性永续 + Hyperliquid USDC 永续；币本位/现货/期权未适配。
4. **OKX 数量归一**：OKX 的 `openMaxPos` 是张数，适配器用「毛盈亏 ÷ 价差」反推币数量，
   以便与价格复算和 notional 口径一致；极端小价差时退回张数。
5. **首次回溯窗口**：默认 180 天；更早历史调整 `SYNC_LOOKBACK_DAYS` 后重新建立账户同步状态。
6. **实盘验证**：仓库测试使用固定成交数据，不包含真实凭据；交易所侧接口变更时，
   以添加账户时的验证错误与同步失败信息为准。

---

## 12. v0.4 增量能力

| 能力 | 实现 |
|---|---|
| 资金费补齐 | 五家适配器新增 `fetchFunding`；`funding_events` 去重入库，`applyFundingEvents` 按币种+持仓时间匹配，更新交易 funding/pnl |
| 实时持仓 | 六家 `fetchLive` 拉余额、持仓、未实现盈亏、资金费率；`positions`/`balances` 快照表 |
| 定时刷新 | 服务端 `LIVE_REFRESH_SECONDS`（默认 60s）+ 仪表盘 30s 读快照 + 立即刷新按钮 |
| 自动回溯 | 添加账户即 `sync_done=0`；`sync-worker` 后台分批推进，页面 3s 轮询进度条 |
| 应用内 LLM | `llm_config` 存 meta，Key 加密；支持 OpenAI 兼容 / Anthropic / Ollama；按周/14 天/全部 + 笔记生成复盘，可保存为笔记 |
| Markdown 笔记 | `markdown.js` 安全渲染；图片上传到 `resources` 表，经 `/media/:id` 鉴权读取；编辑页支持预览 |

### 12.1 安全边界

- LLM Key 与交易所 Key 一样使用 AES-256-GCM 加密；页面不回显明文。
- 只有用户点击「生成复盘」时，才会把所选范围的统计与笔记发送到配置的模型接口。
- Markdown 渲染先转义原始 HTML，`javascript:` 等非 http(s)/本地资源 URL 不会变成可点击链接或图片。
- 图片上传限制 5MB，仅允许 PNG/JPEG/GIF/WebP，`/media/:id` 需要登录会话。

---

## 13. v0.5 增量能力

| 能力 | 实现 |
|---|---|
| 历史范围 | `accounts.lookback_days` 可选 90/180/365/730/3650/0（全部可用）；0 取该交易所上限 |
| 交易所上限 | OKX 90 天、Bitget 90 天、Gate 180 天、Bybit 730 天、Binance/Hyperliquid 3650 天 |
| 窗口预算 | `SYNC_WINDOW_BUDGET` 控制单批最多翻多少个 7 天窗口；游标继续下一批 |
| 重新回溯 | 账户页“重新回溯”重置 `sync_done/sync_state`，按当前范围重扫；交易按 `external_id` 去重保留 |
| 增量补页 | 完成后的增量同步如果超过一页，保留 `mode=incremental` 的游标继续补拉 |
| 资金流水 | `transfers` 表 + 六家 `fetchTransfers`；页面 `/dashboard/transfers`，支持账户/类型/币种/日期筛选 |
| 刷新节奏 | 资金流水随同步每 `TRANSFER_REFRESH_HOURS`（默认 6）小时刷新；失败后 6 小时再试，避免打爆接口 |

### 13.1 保留期说明

| 交易所 | 交易可回溯 | 资金流水 |
|---|---|---|
| OKX | 约 3 个月（positions-history） | 充值/提现历史，按回溯范围拉取 |
| Bitget | 约 3 个月（history-position） | 充值/提现记录 |
| Gate.io | 约 6 个月（my_trades） | 充值/提现记录 |
| Bybit | 7 天窗口，按接口保留期 | 充值/提现记录 |
| Binance | 7 天窗口，可回溯更久 | 充值/提现记录（90 天窗口切分） |
| Hyperliquid | 账户全部历史 | `userNonFundingLedgerUpdates` |

### 13.2 尚未包含

- 现货成交与现货持仓成本基础（需要单独的数据模型与按交易对查询）。
- 期权、策略/机器人订单（模型与交易所接口差异大）。
- P2P / 法币买卖 USDT（部分交易所不提供标准只读 API）。
- 多账户内部划转的完整对手方信息（各交易所字段不同，目前能取到多少显示多少）。

---

## 14. v0.6 CSV 兼容层

### 14.1 解析能力

- 自动跳过前置标题/账户信息行，在前 15 行内按字段别名打分定位表头。
- 自动识别分隔符（`,` `;` `\t` `|`）、引号、BOM。
- 自动解码 UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE（交易所导出常见 UTF-16）。
- 表头别名覆盖六家常见英文/中文列名；支持列顺序变化。
- 金额解析支持千分位、货币符号、括号负数、小数逗号。
- 时间解析支持 epoch（秒/毫秒/微秒）、ISO、`YYYY-MM-DD HH:mm:ss`、`YYYY/MM/DD`、`MM/DD/YYYY`。

### 14.2 两种数据形态

| 形态 | 适用 | 处理 |
|---|---|---|
| `roundtrip` | 交易所「平仓盈亏 / 已实现盈亏 / 仓位历史」导出 | 一行直接作为一笔已平仓交易 |
| `fills` | 「成交明细 / fills / my_trades」导出，含现货 | 按 symbol + 买卖方向做 FIFO 配对，手续费分摊到 round trip |

- 自动判断：有开/平仓价 → roundtrip；只有方向 + 成交价 + 数量 → fills。
- 逐笔成交没有方向列时，按数量正负判断买卖（适配 Gate 等）。
- 只有一个时间列时，自动作为成交/平仓时间使用。

### 14.3 兼容性边界

- 逐笔配对只在单次导入的文件内进行；开仓与平仓拆到两个文件时无法跨文件配对。
- 现货、合约都能走 fills 模式，但输出仍是“已实现 round trip”，未卖出的现货持仓不会出现在交易表。
- 优先建议使用交易所的「已平仓/已实现盈亏」报表；fills 模式用于只有成交明细的历史导出。
- 单次导入上限：8MB、50,000 行。

---

## 15. v0.7 现货实时同步

### 15.1 数据模型

| 表 | 用途 |
|---|---|
| `trades.market` | `futures` / `spot`，用于仪表盘和交易记录的市场过滤 |
| `spot_fills` | 现货逐笔成交（external_id 去重） |
| `spot_balances` | 现货余额快照（asset/total/free） |
| `spot_holdings` | 现货持仓快照（symbol/quantity/price/value） |
| `spot_cost_basis` | long-only FIFO 计算出的剩余持仓成本 |

### 15.2 同步策略

- 每 `SPOT_REFRESH_HOURS`（默认 1 小时）拉一次现货成交；首次按账户回溯范围，之后只拉最近 2 天。
- `fetchSpotTrades` 返回原始 fills，统一用 `matchFills(..., { longOnly: true })` 配对：
  现货卖出只平多，不创建空头；没有买入覆盖的卖出被忽略。
- 已实现现货交易写入 `trades`，`market='spot'`，`source='api'`，`external_id` 以 `spot:<exchange>:` 开头。
- 现货成交同时写入 `spot_fills`，并用全部历史 fills 重算 `spot_cost_basis`。
- 实时面板每 `LIVE_REFRESH_SECONDS` 刷新 `spot_balances` / `spot_holdings`。

### 15.3 各交易所差异

| 交易所 | 现货成交 | 现货余额 |
|---|---|---|
| OKX | `fills-history?instType=SPOT`，全量 | 交易账户 + 资金账户合并 |
| Binance | `myTrades` 按交易对（可配置或按余额推导） | `/api/v3/account` |
| Bybit | `execution/list?category=spot`，全量 | UNIFIED wallet |
| Bitget | `spot/trade/fills` 按交易对 | `spot/account/assets` |
| Gate.io | `spot/my_trades` 按交易对 | `spot/accounts` |
| Hyperliquid | `userFillsByTime` 中带 `/` 的现货成交 | `spotClearinghouseState` |

### 15.4 边界

- Binance / Bitget / Gate 的现货成交接口要求交易对；账户编辑页可填 `BTCUSDT,ETHUSDT`，留空按当前余额推导。
- 成本基础只覆盖已同步的买入成交；早期买入不在回溯窗口、或资产来自充值/划转时，
  会出现「成本数量与当前余额不一致」，此时不计算未实现盈亏。
- 已实现现货交易按单次同步窗口内的成交配对；跨窗口的开平仓可能不会生成已实现交易，但逐笔成交和持仓仍保留。
- 期权、策略机器人不在本版本范围。
