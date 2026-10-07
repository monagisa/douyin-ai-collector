# 抖音评论采集器

在 Chrome / Edge 中采集**抖音公开评论**（含二级回复），导出 CSV / JSON。

- **不破解签名** · **不绕过登录** · **不伪造请求**  
- 复用页面自己生成的签名请求，只改分页 `cursor` / `count`  
- 数据只落在本机 `chrome.storage.local`，可导出后自行分析  
- v0.2.15：**顶层列表改回「错峰多路」——单路慢的根因是「同时发」而不是「并发」**（用户 2026-10-07 追问
  「服务端会把它们合并成同一页？但是单路太慢了」）——
  ① 用 `window.__DTS_COLLECTOR__.replay()` 在同一视频复现：同一签名下**同时**发 4 个 cursor（0/50/100/150）
  Σ返回 200 条、**按 cid 去重后只有 56 条**，`c50/c100/c150` 三页逐条完全相同，而每路响应的 `next`
  字段还是对的（50/100/150/200）⇒ **静默少给**，只有去重才看得出；改成**错峰 200ms** 发就恢复正常
  （唯一 200/200），错峰 500ms 也一样。
  ② 扫完整个列表（21 页、Σ返回 1021 条）量化收益：单路（含 400ms 礼貌间隔）**15.79s / 唯一 907**
  vs 错峰 4 路 **7.72s / 唯一 912** ⇒ **2.04× 提速、数据一样多**（多 5 条是那半小时里新评论在变）。
  ③ 于是 `lanes` 重新生效：内置默认 **3 路**，路与路之间 `await sleep(LANE_STAGGER_MS = 200ms + 抖动)`
  （**错峰**在途，最后 `Promise.all` 收拢）；`lanes: 1` = 老的单路串行。单路礼貌间隔 `MIN_INTERVAL_MS`
  也从 **400ms 降到 150ms**（实测中位往返 344ms，那 400ms 有一半是纯等）。
  ④ **降路兜底**：同一轮里一旦发现两路返回**逐条相同**的页，当轮就把路数降回 1，并把原因写进
  `dts_settings_effective.lanesNote`（面板同步提示）——宁可慢，也不再静默少采；多路时「某路越界返回空页」
  不再算触底（`anyLaneHasMore`），`laneShort`（某路明显不满一页）同样把路数降回 1，靠近列表末端自然收回单路。
  真机（2026-10-07，扩展 0.2.15）：3 路错峰扫完 21 页交付 **919 条**一级评论、**29.5s**、
  `dts_settings_effective.lanes=3`；`max=30` 的端到端一轮 **421 条**（一级 105 + 二级 316，38/38 线程）、
  **24.3s**、`phase=done`。离线自测 **172/172 全绿**。
- v0.2.14：**「服务端不回数据」不再一波判终局；修掉「0 = 关闸门」与文档的矛盾**（用户 2026-10-07 报
  「我怀疑这个限速是假限速，有时候我自己点就可以拿到」，随后又猜「请求过快、还没拿到返回结果就说是限流」）——
  ① 先说清事实：判「限流」的唯一依据是 **HTTP 200 + body 0 字节**（`hook.js` 里只有 `await res.text()`
  拿到空串才产生 `EMPTY_BODY`，并把往返 `ms` 记下来）；「没拿到返回」是另一个错误码 `REPLAY_TIMEOUT`，
  真机 A/C/D 三轮（同一视频 `7692405235813272867`）**从未出现过** ⇒ 不是「本地抢跑」。
  ② 但「等 10 秒就收尾」确实是**假终局**：A 轮会话内连撞 **108 秒 / 48 次请求全被拒**，
  **11 秒后新会话**的 B 轮 **39/39 线程、302 条回复一次没失败**；C 轮把预算放宽到 300 秒、
  连撞 **125 秒 / 200+ 次请求**仍一次没放行（所以「一口气硬撞」也没用）；D 轮跨 **8.5 分钟 4 波**全被拒，
  随后新会话 x1 轮 **23/23 线程全成**。⇒ 服务端状态确实在起作用（窗口几秒~十几分钟自己开），
  而旧实现把它当成了「本轮结束」。
  ③ 因此改成**分波停顿重试**：单波最多撞 `REPLY_WAVE_BUDGET_MS = 12 秒`，
  波与波之间停 `REPLY_PARK_PLAN_MS = [15, 30, 60] 秒`（最后一档重复），
  **总等待封顶 `replyThrottleMaxWaitMs`**（内置 **10 秒 → 120 秒**；面板「限流等待 s」可设 10~600 秒，
  设 10 = 老行为「十秒不行就收尾」）。每波开始前先 `flushComments(0)` 落盘，
  用户中途关页面/切视频也不丢已拿到的。收尾文案改为如实报**本轮共等 N 秒 / 分 M 波 / 还剩几个线程**，
  并说明服务端回的是「HTTP 200 + 0 字节 body」（旧文案只说「已重试 N 秒」——那只是**最后一波**的秒数，
  A 轮实际等了 108 秒却报 14 秒）。
  ④ 修 `replyGlobalGapMs` 的语义矛盾：旧版把 **0 当「关掉闸门」**，而 DSH 设置页 / MCP /
  `PROTOCOL.md` / README 全写「0 = 用扩展内置 250ms」⇒ AI 一条 `ai_set_settings{replyGlobalGapMs:0}`
  就能静默关掉限速。现在 **0 / 缺省一律等于内置 250ms**（跟文档一致）。
  ⑤ 顺手修掉两个「看起来一直在限流」的假象：面板那行**暂态红字**（这一波先撞了几次空 body、后面又成功）
  现在有任意一个线程成功就立刻清掉，不再一直挂着；补采阶段结束时把**阶段交回主循环**，
  于是「到量停止顶层扫描」的收尾能真正置 `done`（旧版停在 `replies`，面板一直显示「补采二级回复」、
  DSH 采集器还要空等到「无进展 900 秒」才收工——真机 y1 轮 `ok=true` 却 `phase=waiting-sign`、白等 120 秒）。
  **真机 z1 轮（v0.2.14）：25 秒跑完、`phase=done`、`count=334`（一级 50 + 二级 284，28/28 线程）**。
  离线自测 **161/161 全绿**。
- v0.2.13：**修两个严重缺陷：目标条数一到量就丢掉全部二级回复；回复请求没有任何跨线程限速**（用户 2026-10-07 报告）——
  ① 面板齿轮的**目标条数**（以及插件/MCP 下发的 `maxCount`）旧实现是在主循环里直接 `break` 收工，
  而补采二级回复的分支写在那个 `break` **之后**，所以只要设了目标条数，**二级回复一条都采不到**
  （代码注释还写着「到量后已收集到的线程的二级回复仍要补完再停」，与实际行为相反）。现在到量只
  **停止顶层扫描**（`topCapReached`，把面板阶段留在「采集中」），二级回复统一交给**循环外的第二阶段**
  补完；收尾文案写明「一级评论已到目标 N 条（去重后 M 条），已停止顶层扫描；二级回复 x/y 个线程，
  共 Z 条。再点「开始采集」会从断点继续」。
  ② 到量判定改用**一级去重计数** `topSeenCount`（旧版用一二级同池的 `seen.size`，既偏大又口径不对），
  并随状态回包上报 `topSeen`（插件/MCP 据此判定；旧扩展不报时自动退回 `unique` 兜底）。
  ③ **回复请求新增跨线程全局限速**：默认 `REPLY_GLOBAL_GAP_MS = 250ms`（≈ ≤4 次/秒），
  所有回复请求（含失败重试）都要过 `replyGate()` 这道闸门——旧版 4 条线程各自「取到就发」，
  单页线程之间**零间隔**（实测总速率 ≈20 次/秒），同一条视频两轮能差到「0/46 线程」与「~139 条二级回复」；
  撞限流时自动**把全局限速翻倍（封顶 `REPLY_GLOBAL_GAP_MAX_MS = 1000ms`）+ 并发降 1 路**（下限 1），
  并把这件事写进面板说明。新设置项 `replyGlobalGapMs`（0~2000，0 = 用内置 250ms）可由
  `dts_settings` / DSH 插件 / MCP 下发（面板齿轮暂不加输入项，避免浮层变高）。
  离线自测 **153/153 全绿**。
- v0.2.12：**顶层列表采集固定单路**——实测发现**多路并发会被服务端合并成同一页**，路数越多反而**少采**：
  同一个签名在同一时刻发 `cursor` / `cursor+50` / `+100` / `+150` 四路时，服务端把**同签名的并发分页请求合并成同一响应**
  （四路里三路拿到的是**同一页**，两两重合 50/50，而且这一页不在任何单路页里）：4 路 5 轮只拿到 **492 条**一级评论，
  **且 0 个失败请求**（不是报错，是静默少给）；而单路串行（每次用服务端返回的 `next` 推进）18 步拿到
  **714~744 条**唯一一级评论（再多轮补扫只再加 1 条）；同样 4 路、每路之间**错峰 200ms** 就恢复正常（4 页 = 200 条唯一）。
  所以 0.2.12 起**顶层列表扫描固定单路**，`lanes`（并发路数）设置**已停用**——仍可读写、仍会下发给扩展，
  但**不再影响采集**（仅保留兼容）。**⚠️ 这条结论在 v0.2.15 被修正**：触发合并的条件是「同一签名 +
  ~200ms 窗口内**同时**发」，**错峰 200ms 的多路不会合并**（`_lanes_probe.mjs` 实测），
  所以 v0.2.15 起 `lanes` 重新生效（默认 3 路错峰），见上面 v0.2.15 条目。
  同一视频实测：修复前（扩展 0.2.11，4 路）**768 条**（一级 586 / 二级 182）**20.1s** →
  修复后（扩展 0.2.12，单路）**945 条**（一级 753 / 二级 192）**70.4s**，一级 **+28%**、总条数 **+23%**；
  代价是单路更慢（同一视频 20s → 70s）。另外服务端列表本身也有上限：`cursor=850` 时只回 8 条且 `has_more=0`，
  `cursor≥900` 直接回字面量 `null`（这个视频的列表接口最多只给约 **850 条**，服务端 `total=1709` 里的差额是
  二级回复 + 已删除/被过滤评论）。离线自测 **141/141 全绿**。
- v0.2.11：**导出只有一份实现 + AI/MCP 也能「全部视频」导出**——面板「导出 CSV / 导出 JSON」与 Hub(AI/MCP)
  的 `export` 命令现在**共用同一份实现** `background.js` 的 `async function exportComments(opts)`，
  行为完全一致（以前是两份各写各的）；Hub `export` 新增 `all:true`：**不传 `videoId` 也能导出**——
  把本地所有视频的评论合成一份，每条评论标上 `videoId`，CSV **末尾追加 `video_id` 一列**（前 17 列不变），
  文件名 `douyin-comments-all-<时间戳>.csv|json`，JSON 里 `scope:"all"` 且带 `videos` 摘要；
  导出失败口径统一（既没 `videoId` 又没 `all` → `MISSING_VIDEO_ID`；本地确实没数据 → `EMPTY_POOL`），
  **不再下载一个只有表头的空 CSV**；面板导出失败的提示会带上后台给的 `hint`（`导出失败：<error>（<hint>）`）。
- v0.2.10：**清空会自检**——后台没响应 / 扩展刚重新加载时不再谎称「已清空」，而是提示你重新加载扩展并 F5；修掉「全部清空后『本地已存』还显示旧数字」的旧回包竞态。
- v0.2.9：**面板新增「本地已存」+ 导出范围（本条视频 / 全部视频）**——换视频**不会丢数据**，
  评论一直按 `videoId` 分池存在本地（`dts_c_<videoId>`，一个视频一个桶），
  只是旧面板的计数与导出都只认「当前这条视频」，滑到下一条点「开始采集」后计数归零，看起来像被清了。
  本版不改数据路径：新增一行「本地已存」显示 `N 个视频 / M 条（本条 X 条）`（面板构建时读一次、
  之后每 20 秒刷新，落库后与点「清空」后立刻刷新）；新增一行「导出范围」两个互斥按钮
  `[本条视频]`（默认，旧行为）/ `[全部视频]`（合成一份导出，CSV **末尾多一列 `video_id`**，
  共 18 列，前 17 列列序不变；文件名 `douyin-comments-all-<时间戳>.csv|json`）；
  后台 `dts-stats` 多回 `totalAll` / `videoCount`；点「开始采集」时面板会写一行
  `本机已存：N 个视频 / M 条（含其它视频）；本条视频本地已有 X 条`
- v0.2.2：并发路数可由外部设置（`chrome.storage.local.dts_settings = {lanes: 1~8}`，默认 4）；
  DSH 插件 `dsh-douyin-comments` 在「设置 → 插件」里改的就是它
  ——v0.2.12~v0.2.14 该设置曾**被固定成单路**（顶层列表固定单路，仅保留兼容）；
  **v0.2.15 起重新生效**（默认 3 路错峰，见本条最上面的 v0.2.12 修正与 v0.2.15）
- v0.2.3：二级回复的四档限速同样可被外部覆盖（`replyLanes` 并发线程数、`replyGapMs` 同线程页间隔、
  `replyWarmupMs` 进补采前的静默、`replyThrottleMaxWaitMs` 等窗口的**总**墙钟上限）；
  不写就等价于老版本（4 / 600ms / 1500ms / 10s）。
  v0.2.13 起另有 `replyGlobalGapMs`（跨线程全局限速，0 = 用内置 250ms）；
  v0.2.14 起 `replyThrottleMaxWaitMs` 从「10 秒一波判决」变成「总窗口」（内置 120 秒，分波停顿重试）——见上一条
- v0.2.4：**面板上多了「设置」按钮**（就在「开始采集/暂停」下面一行），点开可直接改
  目标条数 / 顶层并发路数 / 回复并发 / 回复间隔 / 限流等待，存到 `chrome.storage.local.dts_user_settings`；
  优先级 **面板设置 > `dts_settings`（外部/插件写入）> 内置默认**；目标条数到量**只停顶层扫描、二级回复仍会补完**
  （v0.2.13 起才真正如此；v0.2.4~v0.2.12 之间实际会连二级回复一起丢掉，见上方 v0.2.13）
- v0.2.5：**面板设置入口改成标题栏的齿轮 ⚙**（在「—」收起按钮左边，不再占一整行），
  点开浮层里第一项就是 **`max` 目标条数**（另有 顶层并发路数 / 回复并发 / 回复间隔 / 限流等待），
  当前生效值以「当前：顶层 3 路错峰（200ms） · 目标 M 条/不限（面板）」显示在浮层顶部
- v0.2.4 配套的插件侧（`dsh-douyin-comments` 0.5.2）**兼容 macOS**：浏览器查找覆盖
  `~/Library/Caches/ms-playwright`、`/Applications/Chromium.app`、`Google Chrome for Testing.app`、
  Homebrew / node 全局模块目录；另外品牌版 Chrome 137+ 会忽略命令行的 `--load-extension`，
  这时要么用 playwright 装的 Chromium，要么用 `DOUYIN_CHROME` 指过去（详见插件 README）
- v0.2.6：**AI 桥也能读写设置**——新增 `get_settings` / `set_settings` 两条命令，`start_collect`
  可带 `settings`（写 `dts_settings` 后立即生效）；配套 MCP `douyin-mcp` **0.3.0** 新增
  `ai_get_settings` / `ai_set_settings`，`ai_start_collect` 支持 `max` / `lanes` / `replyLanes` /
  `replyGapMs` / `replyWarmupMs` / `replyThrottleMaxWaitMs`（协议 §7.9）
- v0.2.7：**采集不再「静默 0 条」**——① 后台新增零副作用探针 `dts-ping`（只回
  `{ok:true,pong:true,at}`；用 `dts-status` 探活会给 `updateVideoMeta` 写一条 `videoId=undefined` 的脏记录）；
  ② 内容脚本新增 `probeBackground()` 主动探活（启动 200ms 后一次、之后每 30 秒一次），状态镜像与面板文案
  新增 `bgOk` / `bgErr` / `bgCheckedAt`，扩展后台不可达（`Could not establish connection. Receiving end
  does not exist.` / `Extension context invalidated`）时面板**不再谎称「已清空」**；③ 配套 DSH 插件
  `dsh-douyin-comments` 0.5.5 改清 `Default/Code Cache` + **整个** `Default/Service Worker`
  （只清 `…/ScriptCache` 会留下指向已删脚本的 `…/Service Worker/Database`，这正是「面板还在、
  后台起不来、最后交付 0 条」的成因），并先做「扩展后台可达性」预检，不通就刷新页面重试（最多 2 次），
  仍不通则把这次启动标脏、下次强制清缓存重开；④ 页面采到 N 条但扩展存储没增加时，明确报
  **「落库失败（扩展后台不可达）」**，不再把锅甩给「抖音限流 / 视频没有新评论」；⑤ `clearBefore` 时
  点「清空」两次仍不空 → 刷新页面重试 → 仍不空则报错（点了 3 次仍剩 N 条），不再当成功继续
- v0.2.8：**面板「清空」拆成两个按键**——最后一行从 `[清空]` 变成 `[清空] [全部清空]`：
  **「清空」**（挂点 `data-dts-act="clear-video"`）只清**当前视频链接**这一条的去重桶
  `dts_c_<videoId>`，并从 `dts_videos` 里摘掉这一条；别的视频数据与面板设置（`dts_user_settings`）
  都不动，仍然保留「没识别到 video ID 就不发清空」的护栏；**「全部清空」**（红色危险样式
  `.dts-btn-danger`，挂点 `data-dts-act="clear-all"`）是**两步确认**——第一次点只把按钮「上膛」成
  `确认全部清空？`、**数据一条不动**，5 秒内再点一次才真清掉所有 `dts_c_*` 与 `dts_videos`
  （`dts_user_settings` 保留），超时按钮文案自动复原；全清**不受** video ID 护栏限制，任意页面都能用。
  后台侧口径不变：仍然要求 `all=true` 才全清、保留 `NO_VIDEO_ID` 护栏。配套 DSH 插件
  `dsh-douyin-comments` **0.5.6**：其采集器优先按 `[data-dts-act="clear-video"]` 点「清空」，
  浏览器里装的是老扩展（没有该挂点）时才退回按按钮文案 `/^清空$/` 找
- 可选：配套 **MCP** 让 AI 代理调用采集能力（见下文）

> ⚠️ 使用本工具可能违反抖音用户协议，**账号风险自负**。请仅用于自有账号、公开数据与合规研究。

---

## 适用范围（浏览器兼容）

**本仓库以 Chromium 系浏览器为设计目标，请按此范围使用：**

| 浏览器 | 状态 | 说明 |
|---|---|---|
| **Google Chrome 111+** | ✅ 支持 | 主目标；`world: MAIN` 等需 Chrome 111+ |
| **Microsoft Edge（Chromium）** | ✅ 支持 | 与 Chrome 同一套扩展；入口为 `edge://extensions` |
| Brave / Vivaldi / Opera / Arc 等 Chromium | ⚠️ 尽力兼容 | 需开发者模式手动加载；个别策略可能禁用未打包扩展 |
| **Mozilla Firefox** | ❌ 不支持 | MV3 后台、`world: MAIN` 注入时序、权限与 API 均需移植，当前未做 |
| **Safari** | ❌ 不支持 | 需独立打包与平台工程，不在范围内 |

**其他约定：**

- **安装方式**：仅支持「开发者模式 → 加载已解压的扩展程序」（Chrome 137+ / Edge 已禁用命令行 `--load-extension`）。
- **登录态**：按浏览器隔离；Chrome 登录 ≠ Edge 登录。
- **多浏览器同时装同一扩展**：扩展 ID 可能相同，但 `chrome.storage.local` **互不相通**；AI 联调时建议只开一个装了扩展的浏览器，避免抢 Hub 命令。
- **AI / MCP**：与浏览器种类无关，前提是扩展能在该 Chromium 浏览器里加载并轮询本机 Hub。

若你只需要 Chrome/Edge 以外的浏览器支持，请先按 Chromium 路径验收，再单独立项做 Firefox/Safari 移植。

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 多页面采集 | 视频详情页、推荐/关注/朋友流、精选网格（先点开视频）、「我的」作品页 |
| 二级回复 | 顶层采完自动补采 `reply_comment_total > 0` 的线程 |
| 本地存储 | 按 `videoId` 分池去重，关浏览器数据仍在；面板「本地已存」显示跨视频总规模 `N 个视频 / M 条（本条 X 条）` |
| 导出 | CSV（UTF-8 BOM）/ JSON，写入浏览器下载目录；导出范围可选「本条视频」（默认）或「全部视频」（把所有视频合成一份，CSV 末尾多一列 `video_id`） |
| 面板 | 右下角可拖动采集面板：标题栏齿轮 ⚙ 可改设置（目标条数 max / **顶层并发路数**（v0.2.15 起生效：默认 3 路错峰 200ms，1 = 单路）/ 回复并发 / 回复间隔 / 限流等待）；「本地已存」一行显示跨视频总数；「导出范围」两个互斥按钮（本条视频 / 全部视频）；清空分成「清空」（只清本条视频）与「全部清空」（两步确认）两个按钮 |
| AI Bridge | 本地 MCP Hub，AI 可 `status` / `start_collect`（可带设置）/ `get_settings` / `set_settings` / `get_comments` / `export` |

---

## 快速开始

### 1. 安装扩展

Chrome 137+ / Edge 已禁用命令行 `--load-extension`，请手动加载：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启 **开发者模式**
3. **加载已解压的扩展程序** → 选择本目录（含 `manifest.json` 的那一层）
4. 在浏览器中**登录抖音**
5. 打开任意视频页，例如 `https://www.douyin.com/video/<id>`

更多安装/打包/固定扩展 ID 说明见 [INSTALL.md](./INSTALL.md)。

### 2. 采集

1. 等面板状态从「等待签名」变为可开始（或按面板提示打开评论区）
2. 点 **开始采集**
3. 等待「完成」或「已暂停」
4. 点 **导出 CSV** / **导出 JSON**

### 3. 可选：让 AI 调用（MCP）

仓库内配套目录 [`../douyin-mcp`](../douyin-mcp)（若以 monorepo 上传则为同级目录；单独上传扩展时请克隆/拷贝该目录）：

```bat
cd douyin-mcp
node mcp.js
```

在 MiMo Desktop / Claude 等 MCP 客户端中注册 **stdio** server：

```json
{
  "type": "local",
  "command": ["node", "/绝对路径/douyin-mcp/mcp.js"],
  "enabled": true
}
```

Tools：`ai_status` · `ai_list_videos` · `ai_start_collect` · `ai_pause_collect` · `ai_live_status` · `ai_get_comments` · `ai_export` · `ai_clear_storage`  

详细说明见 [douyin-mcp/README.md](../douyin-mcp/README.md)。

---

## 工作原理（摘要）

抖音评论接口依赖页面生成的 `a_bogus` 签名。逆向算法不可行且版本频变。本扩展采用：

```text
① hook.js 在页面主世界截获「页面自己发出的」带签名评论请求
② 只读保存 URL 参数（不伪造、不逆向）
③ 用同一份参数重放，只改 cursor / count —— 等价于让页面多翻几页
④ 采集结果写入 chrome.storage.local，可导出 CSV/JSON
```

**语义**：不伪造身份；签名由页面生成，我们只是让页面自己多请求几页。  
**限制**：页面自身只会主动请求约 2 页 / 10 条评论，因此必须依赖上述重放才能拿到全量；登录态是硬门槛。

协议与实现约束见 [PROTOCOL.md](./PROTOCOL.md)。

---

## 支持的页面

| 页面 | 用法 |
|---|---|
| 视频详情页 `/video/<id>` | 直接打开即可；必要时滚一下评论区让页面发请求 |
| 推荐页 `/?recommend=1`、关注 `/follow`、朋友 `/friend` | 一屏一条视频；点「开始采集」后扩展会尝试自动点开右侧评论图标 |
| 精选 `/jingxuan`、「我的」作品网格 | **必须先点开一条视频**（变成浮层）再采集；网格上扩展不会替你点卡片 |
| 新页面形态 | v0.1.12 起按 **DOM** 判形态，不写死 URL 清单 |

---

## 导出格式

**CSV** 文件名：`douyin-comments-<videoId>-<时间戳>.csv`  

前 15 列自 v0.1.4 起冻结；末尾追加二级回复两列：

```text
cid, create_time, create_time_str, text, text_clean, text_len,
digg_count, reply_comment_total, ip_label, is_hot, is_folded,
level, stick_position, user_nickname, user_uid,
is_reply, parent_cid
```

- UTF-8 BOM，Excel 打开中文不乱码  
- 导出成功 = 文件**真正写盘**；中断不会谎报「已导出」  

**JSON** 含 `videoId` / `count` / `topLevelCount` / `replyCount` / `comments[]` 等字段。

### v0.2.15：顶层列表改回错峰多路（单路慢的根因是「同时发」，不是「并发」）

用户 2026-10-07 追问：「服务端会把它们合并成同一页？**但是单路太慢了**」——于是把 v0.2.12 的结论
拆开重测，结论是**当时的止损方向对、但把原因归错了**。

**探针一：复现「合并」，并找出真正的触发条件**（同一视频 `7692405235813272867`，同一签名，
用扩展自己的 `window.__DTS_COLLECTOR__.replay(cursor, count)`；它只改 `cursor`/`count`，其余参数原样透传）：

| 形态 | Σ返回 | **唯一 cid** | 失败请求 | 墙钟 |
|---|---|---|---|---|
| 4 个 cursor **同时**发（0/50/100/150） | 200 | **56** | 0（全 `status_code=0`） | 572ms |
| 错峰 **200ms** 发 | 200 | **200** | 0 | 1023ms |
| 错峰 **500ms** 发 | 200 | **200** | 0 | 2041ms |
| 完全串行（基准） | 200 | **200** | 0 | 1479ms |

同时发的那组里 `cursor=50 / 100 / 150` **逐条完全相同**（首条都是 `7693372998044713777`），
而每路响应的 `next` 字段**还是对的**（50/100/150/200）⇒ 只有按 cid 去重才看得出少给，**静默**。
⇒ **合并的触发条件是「同一签名 + ~200ms 内同时发」，不是并发本身。**

**探针二：量化「单路慢」能省多少**（扫完整个顶层列表：21 页、Σ返回 1021 条、中位往返 344ms）：

| 形态 | 墙钟 | 唯一 cid | 请求数 |
|---|---|---|---|
| 单路串行（每页后 `sleep(400ms + 抖动)`，即 v0.2.12~v0.2.14 的行为） | **15.79s** | 907 | 21 |
| 错峰 4 路（`next` 入队 + 每路启动错开 200ms） | **7.72s** | **912** | 21 |

⇒ **2.04× 提速，数据一样多**（多 5 条是那半小时里新评论在变）。单路慢的一半原因是那 400ms
**礼貌间隔纯等**（往返才 344ms）。

**改法（0.2.15）**：

1. `lanes` **重新生效**：内置默认 **3 路**（`MAX_LANES = 3`，历史默认 4 降为 3 更保守），
   一轮里 `cursors = [cursor, cursor+COUNT, cursor+2*COUNT]`，**每路之间先 `sleep(200ms + 0~60ms 抖动)`
   再发下一个**（不 await，让请求错峰在途），最后 `Promise.all` 收拢。
2. 单路礼貌间隔 `MIN_INTERVAL_MS` **400ms → 150ms**（`lanes=1` 时也变快）。
3. **降路兜底**：同一轮里发现**两路 items 逐条 cid 相同** ⇒ 判定「服务端又合并了」，
   当轮把路数降回 1，并把原因写进 `dts_settings_effective.lanesNote` + 面板提示；
   多路时「某路越界返回空页」不再算触底（`anyLaneHasMore`），`laneShort`（某路明显不满一页）
   同样把路数降回 1 ⇒ 靠近列表末端自然收回单路。
4. 面板齿轮「并发路数（已停用）」→「**顶层并发路数**」（1~8，默认 3），摘要显示
   「顶层 3 路错峰（200ms）」。

**真机端到端验收（2026-10-07，扩展 0.2.15，同一视频，先清空）**：

| 轮次 | 参数 | 交付条数 | 耗时 | 结果 |
|---|---|---|---|---|
| 单路基线 | `lanes=1, replies=false` | **919**（一级，扫到底） | **36.8s** | `phase=paused` |
| 错峰 3 路 | `lanes=3, replies=false` | **919**（一级，扫到底） | **29.5s** | `phase=paused`，`lanesNote` 空（没触发降路） |
| 错峰 3 路 + 二级 | `lanes=3, replies=true, max=30` | **421** = 一级 105 + 二级 316 | **24.3s** | `phase=done`，二级 38/38 线程、请求 47 次 |

⇒ **唯一条数一分不少**（919 = 919，两轮都 `has_more=0` 扫到底），端到端快约 20%
（纯扫页阶段是 2.04×，端到端里还混着清空、等签名、写盘的时间）；
`dts_settings_effective` 实测为 `{lanes:3, lanesWanted:3, lanesNote:'', maxCount:30, replyGapMs:600,
replyGlobalGapMs:250, replyLanes:4, replyThrottleMaxWaitMs:120000, replyWaveBudgetMs:12000,
replyParkPlanMs:'15000/30000/60000', from:'plugin'}`。

**注意**：一轮真机曾因**已知的签名抖动**（页面没自动打开评论区）只交付 55 条
（`note` =「还没拿到签名：没能自动找到评论入口…」），重跑即正常——与本版改动无关。

**自测**：离线 `node verify-tool.mjs` **172/172 全绿**（3a 段整段重写：错峰发送顺序、
`MAX_LANES=3`/`LANE_STAGGER_MS=200`、`MIN_INTERVAL_MS=150`、合并兜底降路、`anyLaneHasMore`、
面板文案；3e 段新增对 `mcp.js` 的 `lanes` 描述与 `VERSION` 断言）。
`manifest.json` 版本 → **0.2.15**。

### v0.2.14：服务端不回数据时不再「一波判终局」；0 = 用内置 250ms

用户 2026-10-07 连续两条反馈：「我怀疑这个**限速是假限速**，有时候我自己点就可以拿到」
→「有没有可能是因为，**请求过快，还没拿到返回结果就说是限流**」。两条假设我都用真机探针查了。

**先证伪「抢跑」这条**：判「服务端没放行」的唯一依据是 `hook.js` 里

```js
const t = await res.text();          // ← 已经拿到完整 HTTP 响应
if (!t) return { ok: false, error: 'EMPTY_BODY', ms: Date.now() - t0 };   // body 是 0 字节
```

只有**服务端回了 200、body 长度 0** 才会产生 `EMPTY_BODY`，并且把往返 `ms` 一起记下来；
「请求没回来 / 太慢」是另一个错误码 `REPLAY_TIMEOUT`（`content.js` 的 `REPLAY_TIMEOUT_MS`）。
真机 A/C/D 三轮的 `replyLastError` **从头到尾只有 `EMPTY_BODY`**，一次 `REPLAY_TIMEOUT` 都没出现。
另外用探针 `_rl_direct.mjs` 在页面主世界**手动重放**改写后的回复 URL（`getSigned()` → 改 path 为
`/aweme/v1/web/comment/list/reply/`、补 `item_id/comment_id/cursor/count/cut_version`，其余参数原样）：

```
HTTP 200 · status_code:0 · body 58276 字节 · 366~1666 ms   ← 6 轮 × 2 个请求全绿
```

⇒ 空 body 是**服务端真的没给数据**，不是本地「还没拿到结果就判限流」。

**再证伪「限速是假的」……但只对一半**。同一个视频 `7692405235813272867`、同一份代码、同样的
250ms 全局闸门，四轮真机（`_rl_probe.mjs`，每秒采样 `getStatus()`）：

| 轮次 | 参数 | 结果 |
| --- | --- | --- |
| A | `max=100 clearBefore=true` | 回复请求 **48 次全被拒**（始终 `EMPTY_BODY`），会话内连撞 **108 秒**，二级回复 **0 条** |
| B | 在 A 结束 **11 秒后**开新会话 | **39/39 线程、302 条回复一次没失败**（`rqPg=48`），速率中位 3.98 次/秒 |
| C | `max=100 clearBefore=true replyThrottleSec=300` | 连撞 **125 秒 / 200+ 次请求**仍一次没放行（降速生效：速率中位 1.99 次/秒） |
| D | `max=100 clearBefore=true` | 跨 **8.5 分钟 4 波**全被拒（每波 ~14 秒预算） |
| x1 | D 之后新会话，手动重放对照 | 改写后的回复请求 **全部 200 / 58276 字节**；该轮采集 **23/23 线程、265 条** |

⇒ ① **限速本身是真的**（B 轮实测 ≈4 次/秒，与 250ms 闸门吻合；1 秒采样跨界的 4.99 是噪声）；
② 但**「等 10 秒就收尾」是假的终局**：A 轮窗口在 108 秒后又开了（B 轮 11 秒后全成），
C 轮「一口气硬撞 125 秒」却没用 ⇒ 该做的是**停下、歇一会儿、再打一波**，不是一路硬撞、也不是一波判死。

**修法（`content.js`）**：

1. 新增两个常量：`REPLY_WAVE_BUDGET_MS = 12 * 1000`（**单波**连续重试上限）、
   `REPLY_PARK_PLAN_MS = [15000, 30000, 60000]`（波间停顿计划，最后一档重复）；
   `REPLY_THROTTLE_MAX_WAIT_MS` 从 `10s` 改成 **`120s`**，语义从「一波预算」改成「**总**窗口上限」。
2. `recoverReply()` 判上限改用**本波预算** `replyWaveBudgetMs`（由 `collectReplies()` 按剩余总窗口算，
   下限 6 秒），到点照旧返回 `{ givingUp, throttled }`——但不再等于终局。
3. `collectReplies()` 在原来的「失败线程退避 2.5s 重试一轮」之后加**停顿重试循环**：
   每轮先 `flushComments(0)` 落盘（用户这时关页面/切视频也不丢），
   面板写「服务端还没放行回复接口（本轮已等 N 秒，还剩 K 个线程）：M 秒后自动再试一波，不用你操作……」，
   停 `parkMs` 后把波次 +1、状态复位（`replyFailStreak/replyThrottleStartAt/replyThrottledMs/replyLastError`）
   再 `runRound(failed, …)`；`wouldWait + REPLY_WAVE_BUDGET_MS > RS.replyThrottleMaxWaitMs` 就收尾。
4. `loadRuntimeSettings()` 的 `replyThrottleMaxWaitMs` 下限改成字面量 `10000`（内置默认却变成 120 秒），
   这样**面板「限流等待 s」设 10 就能回到老行为**（面板 title 也改成「本轮总共最多等这么久」）。
5. **修语义矛盾**：`replyGlobalGapMs` 旧版把 **0 当「关掉闸门」**，而 DSH 设置页 / MCP /
   `PROTOCOL.md` / 本 README 全写「0 = 用扩展内置 250ms」⇒ AI 一条 `ai_set_settings{replyGlobalGapMs:0}`
   就能静默关掉限速。现在 `var gap = pick('replyGlobalGapMs', 0, 2000, 0); out.replyGlobalGapMs = gap > 0 ? gap : REPLY_GLOBAL_GAP_MS;`
   ——**0 / 缺省一律等于内置 250ms**（与全部文档一致）。
6. 收尾文案不再只报**最后一波**的秒数：面板与交付 note 改为
   「服务端始终没放行回复接口（本轮共等 N 秒、分 M 波重试；x/y 个线程、共 Z 条已采到，请求 P 次）。
   再点一次「开始采集」会从断点续补采……想让它等更久/更短，面板「限流等待 s」可调（内置 120 秒，设 10 秒 = 老行为）」；
   并说明服务端回的是「HTTP 200 + 0 字节 body」而不是本地抢跑。
7. `dts_settings_effective` 追加 `replyWaveBudgetMs` / `replyParkPlanMs`，排查时一眼能看到生效的波策略。
8. **暂态红字不再假挂**：`runRound()` 的 worker 里，任一回复线程成功就 `if (errText) errText = '';`
   —— 这一波先撞了几次「服务端暂时不回数据」、后面又成了的话，面板不再一边写「已完成」一边挂着红字
   （真机 y1 轮读到 `error: "服务端暂时不回数据（EMPTY_BODY）…"` 而同一时刻 `note` 已是「补采完成」）。
9. **补采结束把阶段交回调用方**：正常收尾（非 `needSignStop`）时裸赋值 `phase = 'collecting'`（不走 `setPhase`，
   免得清掉刚写好的 `noteText`/`errText`），让主循环第二阶段的 `phase === 'collecting'` 收尾门槛成立，
   从而 `setPhase('done', '', doneNote)` 真正执行。旧版停在 `replies` ⇒ 面板永远显示「补采二级回复」，
   DSH 采集器只能等「无进展 900 秒」（`collector.mjs` 的 `stallLimit`）才收工，期间还可能被签名抖动
   拽成 `waiting-sign` 再空等 120 秒；真机 y1 轮就是这么跑掉 8.5 分钟的。修完 z1 轮 **25 秒**结束。

**真机验收（2026-10-07，v0.2.14）**：

| 轮次 | 参数 | 结果 |
| --- | --- | --- |
| y1（修 8 之前） | `max=20 clearBefore=true` | `ok=true count=316`，但 `phase=waiting-sign`、回复补采完成后**白等 120 秒**、整轮 **8.5 分钟** |
| **z1（修完）** | 同样 `max=20 clearBefore=true` | **25 秒**跑完、`phase=done`、`count=334` = 一级 50 + 二级 284（28/28 个线程、37 次回复请求）；面板文案「一级评论已到目标 20 条（去重后 50 条），已停止顶层扫描；has_more=0 结束，已采 334/2034 条；二级回复已补采 284 条…」；同轮对照实验 `reply-rewritten → 200 / 58276 字节 / 436ms` |
| 生效值 | `dts_settings_effective` | `maxCount:20 / replyGlobalGapMs:250 / replyThrottleMaxWaitMs:120000 / replyWaveBudgetMs:12000 / replyParkPlanMs:'15000/30000/60000'` |

**自测**：离线 `node verify-tool.mjs` **164/164 全绿**（v0.2.14 共新增 11 条断言：单波/停顿常量、
`recoverReply` 用本波预算、停顿重试循环存在且先落盘、总预算下限仍是 10 秒、收尾文案报总等待、
0 = 用内置 250ms、插件描述如实写「总共多等多少秒」、版本 0.5.12 / 0.2.14 对得上、
暂态红字清空、补采收尾交回 `collecting` 且收尾门槛仍在）。

### v0.2.13：目标条数不再吞掉二级回复；回复请求加全局限速

用户 2026-10-07 报的两个缺陷（都复现过）：

**缺陷 1：设了「目标条数」就再也采不到二级回复。** 旧代码在主循环里：

```js
// ……到量后已收集到的线程的二级回复仍要补完再停   ← 注释是这么写的
if (RS.maxCount > 0 && seen.size >= RS.maxCount) {
  setPhase('done', '', '已达到设置的目标条数 …');
  break;                       // ← 直接跳出主循环
}
// ……下面才轮到「补采二级回复」
if (laneEnd) { if (replyTargets.size > replyDoneSet.size) { await collectReplies(); } … }
```

`break` 在 `collectReplies()` 之前，所以**永远走不到补采**，面板却显示「已完成」；再点「开始采集」
也还是停在同一个 `break`。同一时期 DSH 插件/MCP 的 `max` 走另一条路（只推 `lanes`、从不推 `maxCount`），
于是「一级跑完整轮、一进回复阶段就被点暂停」——实测 `max=100` 返回 **896 条 / 50.3s**。

**修法**：到量不再 `break` 收工，而是

1. 记 `topCapReached = true`，把面板阶段留在 `collecting`（说明「停止顶层扫描，继续补采二级回复……」），
   只跳出顶层 `while`；
2. 顶层 `while` 结束后统一跑**第二阶段**（`replyTargets.size > replyDoneSet.size` 时 `await collectReplies()`），
   列表触底与到量两条路径都落到这里；
3. 第二阶段之后才 `setPhase('done', …)`，且**只在仍是 `collecting` 时**收尾（不覆盖补采自己置的
   `waiting-sign` / `paused`）；收尾 note 写明「一级评论已到目标 N 条（去重后 M 条），已停止顶层扫描；
   二级回复 x/y 个线程，共 Z 条。再点「开始采集」会从断点继续」。

**缺陷 2：到量计数用错池子。** `seen` 是一级评论 + 二级回复**同池**去重（回复的 `cid` 也进 `seen`），
旧代码拿 `seen.size` 当「一级条数」跟 `maxCount` 比，数字偏大且口径不一致。现在新增
`topSeenCount`（只在 `accept()` 的非回复分支自增）专门给 `maxCount` / 面板「目标条数」用，
并随状态回包上报 `topSeen`；插件判定 `max` 时优先用 `topSeen`（旧扩展不报时退回 `unique` 兜底）。

**缺陷 3：回复阶段完全没有跨线程限速。** 旧实现 `runRound()` 起 `replyLanes` 条 worker，每条
`while` 里取到线程就立刻 `fetchThread(cid)`——唯一的 `sleep` 是同一条线程翻页时的 `replyGapMs`（600ms），
而绝大多数线程只有一页 ⇒ **请求之间零间隔**，总速率 ≈ `replyLanes / RTT` ≈ 20 次/秒。实测同一条视频
两轮差别巨大（一轮 **0/46 线程**：面板「抖音正在限流回复接口（列表接口仍正常），已重试 13 秒」；
另一轮 **~139 条二级回复**）。

**修法**：新增全局闸门 `replyGate()`——所有回复请求（`fetchThread()` 每一页、`recoverReply()` 每次重试）
都先过闸门，跨线程最小间隔 `REPLY_GLOBAL_GAP_MS = 250ms`（≈ ≤4 次/秒）；撞限流时 `replyBackOff(err)`
把间隔**翻倍**（封顶 `REPLY_GLOBAL_GAP_MAX_MS = 1000ms`）并把并发**降 1 路**（下限 1，worker 按
`replyLaneLimit` 自觉退出），同时把原因写进面板说明。新设置项 `replyGlobalGapMs`（0~2000，0 = 内置 250ms）
可被 `dts_settings` 覆盖：`background.js` 的 `SETTINGS_FIELDS`、`content.js` 的
`loadRuntimeSettings()`（面板 `dts_user_settings` 优先）都加了这一项。

**真机验收（2026-10-07，视频 `7692405235813272867`，`max=100`、`clearBefore=true`、扩展 0.2.13、浏览器实测）**：

- 面板收尾文案：**「一级评论已到目标 100 条（去重后 103 条），已停止顶层扫描；二级回复已补采 300 条
  （38/38 个线程，请求 86 次）。再点「开始采集」会从断点继续」**，`phase=done`。
- 交付 **403 条 = 一级 103 + 二级 300**，用时 **345.4s**（单路顶层扫描 + 38 个线程的回复补采）。
  对照旧行为（0.2.12 + 插件 0.5.10 的 `max=100`）：**896 条、二级回复 0 条**、面板「已手动暂停」。
- 也就是说：到量**只停顶层**（103 ≈ max）、二级回复**照采**（300 > 0）——这是本版要修的两件事。

**自测**：离线 `node verify-tool.mjs` **153/153 全绿**（新增 3 组共 6 条断言：到量口径用 `topSeenCount`、
到量只停顶层、补采在循环外第二阶段、全局限速闸门、撞限流翻倍+降路、`replyGlobalGapMs` 可下发）。
`manifest.json` 版本 → **0.2.13**。面板 UI、按钮、存储格式**没有**任何变化。

### v0.2.12：顶层列表固定单路（并发会被服务端合并，导致少采）

**根因（2026-10-06 真机探针实测，视频 `7692405235813272867`，登录态正常，服务端 `total=1709`）**：

- **单路串行**（每次用服务端返回的 `next` 推进）：18 步拿到 **714~744 条**唯一一级评论（再多轮补扫只再加 1 条）。
- **4 路并发**（同一个签名、同一时刻发 `cursor` / `cursor+50` / `+100` / `+150`）：5 轮只拿到 **492 条**，
  **且 0 个失败请求**——不是报错，是服务端静默少给。
- 并发时 `c50` / `c100` / `c150` 三个请求拿到的是**同一页**（两两重合 50/50，而且这一页不在任何串行页里）
  ⇒ **服务端把同签名的并发分页请求合并成同一响应**。
- 同样 4 路、每路之间**错峰 200ms** → 恢复正常（4 页 = 200 条唯一）。
- 服务端列表本身的上限：`cursor=850` 时只回 8 条且 `has_more=0`；`cursor≥900` 直接回字面量 `null`。
  也就是这个视频的列表接口最多只给约 **850 条**（`total=1709` 里的差额是二级回复 + 已删除/被过滤评论）。

**修复（0.2.12 起）**：**顶层列表扫描固定单路**；`lanes`（并发路数）设置**已停用**——
仍可读写、仍会下发给扩展，但**不再影响采集**（仅保留兼容；二级回复的 `replyLanes` 不受影响，
它只在顶层采完之后跑）。

> **⚠️ 这条结论在 v0.2.15 被修正（2026-10-07）**：真正触发合并的是「同一签名 + **~200ms 窗口内同时发**」，
> 而不是「并发」本身——改用**错峰 200ms** 的 4 路就恢复正常（200/200 唯一）。
> 所以 v0.2.15 起 `lanes` **重新生效**（默认 3 路错峰，见上面 v0.2.15 条目），
> 并带「发现两路拿到同一页就自动降回单路」的兜底。v0.2.12 当时「固定单路」是**矫枉过正**：
> 数据确实不会再少，但把「同时发」这个真凶当成了「并发」。

**同一视频实测对比（2026-10-06）**：

| | 扩展版本 / 路数 | 实际条数 | 一级 / 二级 | 耗时 |
|---|---|---|---|---|
| 修复前 | 0.2.11 / 4 路 | **768** | 586 / 182 | 20.1s |
| 修复后 | 0.2.12 / 单路 | **945** | 753 / 192 | 70.4s |

代价：单路更慢（同一视频 **20s → 70s**），换来 **+23%** 数据（一级 **+28%**）。

**自测**：离线 `node verify-tool.mjs` **141/141 全绿**。

`manifest.json` 版本 → **0.2.12**。面板 UI、按钮、存储格式**没有**任何变化。

### v0.2.11：导出只有一份实现 + Hub/MCP 也能「全部视频」导出

**导出实现合并成一份**：`background.js` 新增 `async function exportComments(opts)`（第 227 行起），
面板「导出 CSV/JSON」按钮（内容脚本发 `dts-export` 消息）与 AI/MCP 走的 Hub 命令 `export`
（`background.js` 第 708 行 `case 'export':`）**现在共用这一份实现**，行为完全一致
（以前是两份各写各的）。

**Hub 的 `export` 命令新增 `all:true`**：不传 `videoId` 也能导出——把本地所有视频的评论合成一份，
每条评论标上 `videoId`，CSV **末尾追加 `video_id` 一列**（前 17 列契约不变，列顺序：
…`is_reply,parent_cid` 之后是 `video_id`）；文件名 `douyin-comments-all-<时间戳>.csv|json`
（单视频仍是 `douyin-comments-<videoId>-<时间戳>.*`）。JSON 里 `scope:"all"` 且带
`videos:[{videoId,title,count}]` 摘要。

**导出失败口径统一**（面板与 Hub 一样）：

- 既没 `videoId` 又没 `all:true` →
  `{ok:false, error:'MISSING_VIDEO_ID', hint:'export 需要 videoId 参数；要导出本地全部视频请传 all:true'}`
- 本地确实没有评论数据 → `{ok:false, error:'EMPTY_POOL', hint:'该 videoId 本地没有评论数据'}`；
  全量时 `hint:'本地还没有任何评论数据：先采集，或用 list_videos / get_comments 确认'`
- **不再下载一个只有表头的空 CSV**（以前「导出成功」会掩盖「本来就是空的」）。

**Hub 成功回包结构**（Hub 命令约定：成功主体放 `result`）：
`{ok:true, result:{scope:'all'|'video', videoId, videoCount, count, topLevelCount, replyCount, format, filename, bytes, downloadId, path}}`；
失败保持顶层 `{ok:false, error, hint}`。

面板导出失败时的提示现在会带上后台给的 `hint`：文案形如 `导出失败：<error>（<hint>）`。

`manifest.json` 版本 → **0.2.11**。面板 UI、按钮、存储格式**没有**任何变化。

### v0.2.10：清空自检，失败不再谎报

用户报「**为什么全部清空没有用，本地已存还是在**」。真机复现后确认这是**面板显示/自检的 bug**，数据本身没问题：

**两个根因**：

1. **清空以前是「发出去就当成功」**：`sendClear` 不等后台回包。扩展后台没响应时（例如扩展刚在
   `edge://extensions` 重新加载、页面上还是旧的内容脚本上下文），面板照样显示「已清空」，
   但 `chrome.storage.local` 里一条都没动。
2. **清空其实已经生效，但清空之前的旧回包把面板数字写了回去**：清空**之前**发出的 `dts-stats`
   回包晚到，把「本地已存」又写成旧值（`2 个视频 / 7 条`），最长要等 20 秒的周期刷新才纠正 ——
   这就是用户看到的「没有用，本地已存还是在」。

**修法**：

- `sendClear(payload, onDone)` **等后台回包**；失败分三类 `SEND_FAILED:` / `CLEAR_REJECTED:` /
  `SEND_THREW:`（含 `EXT_CONTEXT_LOST`）。
- 新增 `verifyCleared(vid, all, cb)`：**内容脚本直接读回 `chrome.storage.local` 自检**
  （`all=true` 查所有 `dts_c_*` 与 `dts_videos`；否则只查本条视频的桶与它在 `dts_videos` 里的记录）。
  后台回包 + 读回自检**都过**才显示「已清空」；否则提示**清空没有生效**，并告诉你：打开
  `edge://extensions` 点「重新加载」，回到抖音页按 **F5** 刷新后再试。**不会再假报「已清空」。**
- 面板统计带请求序号 `localStatsSeq`（清空时 `localStatsSeq++`，`dts-stats` 回包时
  `if (seq !== localStatsSeq) return;`）：把在途的旧统计回包作废，修掉「清空后『本地已存』
  还显示旧数字」。
- 新增常量 `COMMENT_KEY_PREFIX = 'dts_c_'`；单视频「清空」与「全部清空」两条路径都走自检。
- **语义不变**：「清空」只清当前页面这条视频；「全部清空」仍是两步确认（第一次点按钮变
  `确认全部清空？`，`CLEAR_ALL_CONFIRM_MS = 5000` 内再点一次才真清），后台 `dts-clear` 仍要求
  显式 `all:true`，空 videoId 绝不兜底成全清。

**自测**：离线 `node verify-tool.mjs` **137/137 全绿**（上一版 130/130 → 135（清空自检 5 条：`sendClear`
等后台回包、清空后读回 storage 自检、失败文案带 `edge://extensions` 重新加载 + F5 指引、
统计请求序号作废在途旧回包、失败文案必须走 `setPhase` 的 `err` 参数不被清空）→ 137（本版 2 条：
① Hub(AI/MCP) 的 `export` 命令也支持 `all`，成功放 `result`、失败保持顶层 `error+hint`；
② 导出失败口径统一 `MISSING_VIDEO_ID`（提示可传 all）/ `EMPTY_POOL`，不再下载只有表头的空 CSV））。真机验收（两条路径，
临时脚本 + 临时 profile，跑完已删）：① 正常清空 9/9——种两个视频的桶 → 面板先显示「本地已存
2 个视频 / 7 条」→ 点「清空」只清当前视频、其它视频保留、面板立刻「1 个视频 / 4 条」→ 点「全部清空」
（两步确认）→ 存储里 `dts_c_*` 与 `dts_videos` 全没了，且面板「本地已存」**立刻**变成「暂无」
（修复前同一脚本 FAIL：存储清了但面板还显示 2 个视频 / 7 条）；② 失败路径 8/8——把扩展复制一份、
只让 `dts-clear` 回 `{ok:true}` 却什么都不清 → 面板不谎报「已清空」，而是显示「「清空」没有生效（…）」
并给出 `edge://extensions` 重新加载 + F5 指引，存储一条没动。

### v0.2.9：「全部视频」导出

面板「**导出范围**」选 `本条视频`（默认，等于旧行为，只导当前这条视频）或 `全部视频`
（把本地**所有**视频的评论合成一份）。两个按钮互斥，自动化挂点分别是
`data-dts-act="export-scope-video"` / `data-dts-act="export-scope-all"`，选中态 CSS 类 `dts-on`。

| | 本条视频（默认） | 全部视频 |
|---|---|---|
| 文件名 | `douyin-comments-<videoId>-<时间戳>.csv/.json` | `douyin-comments-all-<时间戳>.csv/.json` |
| CSV 列数 | 17 列（列序冻结，见上） | **18 列：末尾追加 `video_id`**；前 17 列的列序与含义完全不变，老读者按位置读前 17 列仍然正确 |
| JSON | 含 `videoId` / `count` / … | 顶层多 `scope: "all"` 与 `videos: [{ videoId, title, count }]`；每条评论也带 `videoId` |
| 只读性 | 导出只读，不动本地数据 | 同左 |

后台 `dts-stats` 相应新增 `totalAll`（跨视频总条数，用 `dts_videos` 里的 `count` 元数据累加，
不遍历每个评论桶）与 `videoCount`（本地有几个视频）；面板的「本地已存」这一行就读它。

---

## 目录结构

```text
douyin-collector/          ← 本扩展（发布主体）
├─ manifest.json           MV3 清单
├─ background.js           存储 / 导出 / 清空 / AI Bridge 轮询
├─ hook.js                 主世界：截获签名、重放
├─ content.js              隔离世界：采集循环、面板、上报
├─ panel.css               面板样式
├─ PROTOCOL.md             跨文件协议（实现约束）
├─ INSTALL.md              安装 · 打包 · 排错
└─ README.md               本文件

douyin-mcp/                ← 可选配套（建议同仓库上传）
├─ mcp.js                  本地 Hub + MCP stdio（无 npm 依赖）
├─ test-hub.js             Hub 冒烟
├─ test-mcp-handshake.js   MCP 握手冒烟
├─ config.example.json
├─ douyin-mcp.cmd          Windows 启动包装
└─ README.md

douyin-collector-test/     ← 本地测试脚本（默认不进发行包）
└─ *.mjs                   E2E / 探针脚本（需本机 Playwright + 登录 profile）
```

**权限**（最小集）：`storage` · `unlimitedStorage` · `downloads` · `scripting`  
**Host**：`*://*.douyin.com/*` · `*://*.iesdouyin.com/*` · `http://127.0.0.1/*` · `http://localhost/*`（AI Hub）  

> 排错：用本目录 `index.html`（Hub 探测）在浏览器打开。扩展侧不再使用 `chrome.alarms`。
数据流：

```text
hook.js (MAIN)  ──postMessage──►  content.js (ISOLATED)  ──runtime──►  background.js
     签名截获 / replay                 限速采集 / 面板 UI              落库 / 导出 / AI
```

---

## 设计边界（合规）

1. 不逆向 / 不伪造 `a_bogus`  
2. 重放只改 `cursor` / `count`，不改 host、方法、其它参数  
3. 不绕过登录，不使用账号池  
4. 单浏览器顺序请求，速率不高于页面自身  
5. 只采评论正文与公开计数，不采手机号/私信等  
6. 登录态降级即暂停，不尝试抗风控  

---

## 已知限制

- **需要登录**：未登录通常只能拿到约 2 页 / 10 条  
- **签名约 8 分钟过期**：过期后暂停，刷新页面重来  
- **服务端 `total` ≠ 实收数**：`total` 常含二级回复与已删除/过滤但仍计数的评论；列表接口 `has_more=0` 为物理终点  
- **热榜区有重复**：cursor 靠前区段会重排，去重后唯一数会低于累计返回数  
- **风控真实存在**：服务端可能在 cookie 未过期时作废会话；请自行评估使用风险  

更完整的实测与口径说明见 [INSTALL.md](./INSTALL.md) 与 [PROTOCOL.md](./PROTOCOL.md)。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 面板不出现 | 确认在抖音页、扩展已加载；`chrome://extensions` 看是否有错误 |
| `Extension context invalidated` | 刚在扩展页点过「重新加载」→ **F5 刷新抖音页**再采集（旧 content script 已作废） |
| 一直「等待签名」 | 刷新页面；feed 页等扩展自动点开评论；网格页先点开一条视频 |
| 条数远小于页面上的「X.X万」 | 正常：服务端 total 口径与列表可翻页集合不同 |
| 导出无反应 | 查看 `chrome://downloads` 与扩展 Service Worker 控制台 |
| 换机器/换路径后数据消失 | 扩展 ID 随路径变化；旧数据在旧 ID 的 storage 里（见 INSTALL） |
| 换到下一个视频后，上一个视频的数据去哪了 | **还在本地**，没丢：评论按 `videoId` 分池存在 `dts_c_<videoId>`（一个视频一个桶），面板的计数与导出原来只认「当前这条视频」，所以滑到下一条再点「开始采集」时会看到 0。看面板「本地已存」那一行就是跨视频总数；要把几条视频合成一份导出，把「导出范围」切到「全部视频」 |
| 导出的 CSV 多了一列 / 列数不是 17 | 用了「全部视频」范围：18 列，末尾一列是 `video_id`（前 17 列列序不变）；切回「本条视频」就是原来的 17 列 |
| 点了「全部清空」没反应 / 本地已存还在？（v0.2.10） | 「全部清空」是**两步确认**：第一次点只把按钮变成 `确认全部清空？`（数据一条不动），5 秒内再点一次才真清。确认后若仍失败，面板会**直接告诉你后台没响应**（不会再假报「已清空」），去 `edge://extensions` 点「重新加载」，回到抖音页按 **F5** 刷新后再试 |

---

## 相关文档

- [INSTALL.md](./INSTALL.md) — 安装、打包、固定扩展 ID、排错  
- [PROTOCOL.md](./PROTOCOL.md) — 内部协议与 AI Bridge（v0.2.0 §7）  
- [../douyin-mcp/README.md](../douyin-mcp/README.md) — MCP / AI 调用  

---

## License

个人自用 / 学习研究向工具。上传 GitHub 前请自行确认合规义务，并勿提交：
- 登录 Cookie / 浏览器 profile  
- 真实评论数据集  
- 私钥（`.pem`）与本机绝对路径敏感配置  
