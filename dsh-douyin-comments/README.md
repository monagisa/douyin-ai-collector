# dsh-douyin-comments

DeepSeek Harness（Cordis）工具插件：**采集抖音视频的公开评论**，注册一个工具 `douyin_comments`。
（插件版本 0.5.10，内置扩展「抖音评论采集器」v0.2.12。）

**0.5.10 新增**（内置扩展升到 **0.2.12**：顶层列表**固定单路**、`lanes` 并发路数**已停用**；配套 MCP `douyin-mcp` 升到 **0.3.3**）：

1. **顶层列表扫描固定单路（重要）**：真机实测（2026-10-06，视频 `7692405235813272867`，服务端 `total=1709`）
   **多路并发会被服务端合并成同一响应**——同一个签名在同一时刻发 `cursor` / `cursor+50` / `+100` / `+150`
   四路时，其中三路拿到的是**同一页**（两两重合 50/50，而且这一页不在任何单路页里）：4 路 5 轮只拿到
   **492 条**一级评论、**且 0 个失败请求**（是静默少给，不是报错）；单路串行（每次用服务端返回的 `next`
   推进）18 步拿到 **714~744 条**唯一一级评论（再多轮补扫只再加 1 条）；同样 4 路但每路之间**错峰 200ms**
   就恢复正常（4 页 = 200 条唯一）。所以扩展 0.2.12 起**顶层列表固定单路**，`lanes` 设置**已停用**：
   仍可读写、仍会下发给扩展，但**不再影响采集**（仅保留兼容）。
2. **同一视频实测对比**：修复前（扩展 0.2.11，4 路）**768 条**（一级 586 / 二级 182）**20.1s** →
   修复后（扩展 0.2.12，单路）**945 条**（一级 753 / 二级 192）**70.4s**：一级 **+28%**、总条数 **+23%**，
   代价是单路更慢（同一视频 **20s → 70s**）。另外服务端列表本身也有上限：该视频 `cursor=850` 时只回 8 条
   且 `has_more=0`、`cursor≥900` 回字面量 `null`，列表接口最多只给约 **850 条**（`total` 差额是二级回复 +
   已删除/被过滤评论）。
3. **自测**：`node verify-tool.mjs` **141/141 全绿**。
4. **配套 MCP 升到 0.3.3**：`ai_set_settings` / 设置项里的 `lanes` 说明改成「已停用（扩展 0.2.12 起顶层
   列表固定单路，并发会被服务端合并成同一页，4 路少采约 30%）」；`ai_export` 的「需要扩展 ≥ 0.2.11」
   保留不变。

**0.5.9 新增**（Hub/MCP 也能一次导出「本地全部视频」；内置扩展升到 **0.2.11**，配套 MCP `douyin-mcp` 升到 **0.3.2**）：

1. **导出只有一份实现**：扩展把面板「导出 CSV / 导出 JSON」与 Hub(AI/MCP) 的 `export` 命令合并到
   `background.js` 的 `async function exportComments(opts)`，两条入口行为完全一致（以前是两份各写各的）。
2. **Hub/MCP 也能「全部视频」导出**：`export` / MCP `ai_export` 新增 `all:true`——不传 `videoId`
   也能把本地所有视频合成一份，每条评论标 `videoId`，CSV 末尾追加 `video_id` 列（前 17 列契约不变），
   文件名 `douyin-comments-all-<时间戳>.csv|json`；Hub 成功回包主体放 `result`，MCP 侧把它**拍平**
   给模型看（`scope / videoCount / count / topLevelCount / replyCount / format / filename / bytes / path`）。
3. **导出失败不再「成功」**：既没 `videoId` 又没 `all` → `MISSING_VIDEO_ID`（hint 提示可传 `all:true`）；
   本地确实没数据 → `EMPTY_POOL`——**不再下载一个只有表头的空 CSV**；面板失败提示带上后台给的 `hint`。
4. **MCP 0.3.2 补上并发与限流的实测口径**（写进 `ai_start_collect` / `ai_set_settings` 的参数描述）：
   `lanes` 只作用于拉评论列表这一段（**该设置自扩展 0.2.12 起已停用**），对二级回复阶段没有约束；`replyLanes` 实测（2026-10-06，RTT≈245ms）
   **每路恒定约 4 次/秒**，总速率 ≈ 路数 × 4 次/秒（2 路≈8/秒、4 路≈16/秒），4 路连跑两组后回复接口
   会限流（服务端回 **0 字节**、报 `EMPTY_BODY`），惩罚态可持续**数分钟**，**建议 1~2**；`replyGapMs`
   只在同一条评论的回复有多页时生效，**不能当限速用**，限速请调 `replyLanes`。
5. **自测**：`node verify-tool.mjs` **141/141 全绿**（含本版新增 2 条：Hub(AI/MCP) 的 `export` 也支持
   `all` 且成功放 `result` / 失败保持顶层 `error+hint`、导出失败口径统一 `MISSING_VIDEO_ID` /
   `EMPTY_POOL` 且不再下载只有表头的空 CSV）；同时 `node test-hub.js` exit 0、`node test-settings.js`
   15/15、`node test-mcp-handshake.js`（含新增 `hasExportAll` 断言）全部 PASS。
6. **真机端到端验收 14/14**（2026-10-06：真 Chromium 加载扩展 + 隔离桥端口 18777 + 真 MCP stdio 调用）：
   种 2 个视频共 5 条评论 → `ai_export{all:true,format:'csv'}` 得 `scope=all, videoCount=2, count=5,
   topLevelCount=4, replyCount=1`，CSV 表头末列 `video_id`、内容按视频分 v1=3 行 / v2=2 行；
   `ai_export{videoId:'v1',format:'json'}` 得 `scope=video, count=3`（含 1 条二级回复、无 `videos` 数组）；
   `ai_export{}` 在 MCP 层直接拒（没发桥命令）、`ai_export{videoId:'no-such-video'}` 回 `EMPTY_POOL`。

**0.5.8 修复**（用户报：「为什么全部清空没有用，本地已存还是在」。真机复现后确认是**面板显示/自检的 bug**，不是数据问题）：

1. **清空以前是「发出去就当成功」**：`sendClear` 不等后台回包。扩展后台没响应时（例如扩展刚在
   `edge://extensions` 重新加载、页面上还是旧的内容脚本上下文），面板照样显示「已清空」，
   但 `chrome.storage.local` 里一条都没动。
2. **真机复现（修复前必失败）**：清空其实已经生效（存储里桶和 `dts_videos` 都没了），但清空
   **之前**发出的 `dts-stats` 旧回包晚到，把「本地已存」又写成旧数字（`2 个视频 / 7 条`），
   最长要等 20 秒周期刷新才纠正 → 用户看到的就是「没有用，本地已存还是在」。**根因是在途旧回包的竞态**。

修法（都已在代码里，本版文档照此描述）：

- `sendClear(payload, onDone)`：**等后台回包**；失败分三类 `SEND_FAILED:` / `CLEAR_REJECTED:` /
  `SEND_THREW:`（含 `EXT_CONTEXT_LOST`）。
- 新增 `verifyCleared(vid, all, cb)`：**内容脚本直接读回 `chrome.storage.local` 自检**
  （`all=true` 查所有 `dts_c_*` 与 `dts_videos`；否则只查本条视频的桶与它在 `dts_videos` 里的记录）。
  后台回包 + 读回自检**都过**才改口说「已清空」，否则 `errText` 写明「没有生效」并提示：
  打开 `edge://extensions` 点「重新加载」，回到抖音页按 F5 刷新后再试。
- `refreshLocalStats` 加请求序号 `localStatsSeq`（`var seq = ++localStatsSeq;`，
  回包时 `if (seq !== localStatsSeq) return;`）：清空时 `localStatsSeq++` 把在途的旧统计回包作废。
- 新增常量 `COMMENT_KEY_PREFIX = 'dts_c_'`。单视频「清空」与「全部清空」两条路径都走自检。
- 语义不变：「清空」只清当前页面这条视频；「全部清空」仍是两步确认（第一次点击按钮变
  「确认全部清空？」，`CLEAR_ALL_CONFIRM_MS = 5000` 内再点一次才真清），后台 `dts-clear` 仍要求
  显式 `all:true`，空 videoId 绝不兜底成全清。
- **内置扩展升到 0.2.10**（插件 0.5.8 自带的那份）。
- **自测**：`node verify-tool.mjs` 全绿 **141/141**（当前版本；0.5.8 的清空自检 5 条断言之后，0.5.9 再 +2 条导出断言 → 137，
  0.5.10 顶层固定单路再 +4 条 → 141，见上方「0.5.10 新增」；更早一版 130/130。0.5.8 的这 5 条是：
  `sendClear` 等后台回包、清空后读回 storage 自检、失败文案带 `edge://extensions` 重新加载 + F5 指引、
  统计请求序号作废在途旧回包、失败文案必须走 `setPhase` 的 `err` 参数（否则会被随后清成空串、
  面板既不报成功也不报失败——这条是补跑真机失败路径时踩出来的）。
- **真机验收（两条路径，都是临时脚本 + 临时 profile，跑完已删）**：
  ① 正常清空 9/9：种两个视频的桶 → 面板先显示「本地已存 2 个视频 / 7 条」→ 点「清空」只清当前
  视频、其它视频保留、面板立刻变「1 个视频 / 4 条」→ 点「全部清空」（两步确认，首次点击按钮变
  「确认全部清空？」）→ 存储里 `dts_c_*` 与 `dts_videos` 全没了，且**面板「本地已存」立刻变成
  「暂无」**（修复前同一脚本 FAIL：存储清了但面板还显示 2 个视频 / 7 条）；
  ② 失败路径 8/8：把扩展复制一份、只让 `dts-clear` 回 `{ok:true}` 却什么都不清 → 面板**不谎报
  「已清空」**，而是显示「「清空」没有生效（…）」并给出 `edge://extensions` 重新加载 + F5 指引，
  存储一条没动。
- **配套 MCP `douyin-mcp` 没动，仍是 0.3.1**。

**0.5.7 新增**：

1. **修掉「换一条视频，上一条的数据就没了」的错觉**（用户报的原始问题，也是本版主题）：
   数据从来没丢 —— 评论一直**按视频分桶**存在浏览器本地（`chrome.storage.local` 里
   `dts_c_<videoId>`，一个视频一个桶），代码里除了面板那两个清空按钮（`dts-clear`）
   **没有任何删除路径**。真实例证：用户自己 Edge 的 `Profile 1` 里 6 个桶都在
   （624 / 1406 / 2142 / 2267 / 9446 / 27 条）。旧面板只是**口径**只认「当前这条视频」：
   滑到下一条点「开始采集」后 `savedCount`/`seen` 归零、面板显示 0，看起来像被清了。
   本版**不改任何数据路径**，只补「跨视频可见性」与「导出全部视频」。
2. **面板新增一行「本地已存」**：显示 `N 个视频 / M 条（本条 X 条）`。面板构建时读一次
   （后台 `dts-stats`），之后每 20 秒刷新一次；落库后与点「清空」后也会立刻刷新。
3. **「已采（去重）」补口径**：本轮还没落库、但本地已经有这条视频的数据时，显示
   `（本地已有 N 条）`，不再让人误以为本地是空的。
4. **面板新增一行「导出范围」两个互斥小按钮**：
   - **「本条视频」**（默认，等于旧行为，只导当前这条视频的评论），自动化挂点
     `data-dts-act="export-scope-video"`；
   - **「全部视频」**（把本地**所有**视频的评论合成一份导出），挂点
     `data-dts-act="export-scope-all"`；
   选中态是 CSS 类 `dts-on`，两个按钮互斥。
5. **「全部视频」导出**（`dts-export` 带 `all: true`）：
   - CSV **在末尾追加一列 `video_id`**（共 18 列）；**前 17 列的列序与含义完全不变**，
     老读者按位置读前 17 列仍然正确；
   - JSON 顶层加 `scope: "all"` 与 `videos: [{ videoId, title, count }]`（每条评论也带 `videoId`）；
   - 文件名 `douyin-comments-all-<时间戳>.csv|json`；单视频仍是
     `douyin-comments-<videoId>-<时间戳>.csv|json`。
6. **后台 `dts-stats` 新增 `totalAll` 与 `videoCount`**：`totalAll` 是跨视频总条数，用
   `dts_videos` 里维护的 `count` 元数据累加（**不遍历每个评论桶**），`videoCount` 是本地有几个视频。
7. **点「开始采集」时面板先写一行提示**：
   `本机已存：N 个视频 / M 条（含其它视频）；本条视频本地已有 X 条`，明确告诉用户旧数据还在。
8. **「清空」的语义再强调一次**：**「清空」= 只清当前页面这条视频**
   （`data-dts-act="clear-video"`，无危险样式）；**「全部清空」= 清所有视频**
   （`data-dts-act="clear-all"`，红色危险样式、两步确认、不可恢复）。
   换视频、清空某条视频**都不会**影响别的视频。
9. **内置扩展升到 0.2.9**（插件 0.5.7 自带的那份）。
10. **自测**：`node verify-tool.mjs` 全绿 **130/130**（上一版 121，本次新增 9 条断言：
    `dts-stats` 的 `totalAll`/`videoCount`、`dts-export` 的 `all:true` 分支、CSV 末尾 `video_id` 列、
    `all` 文件名、面板「本地已存」行与两个导出范围按钮、20 秒刷新、`all: exportAll` 传参、面板 CSS、
    AI 桥 `dts-ai-export` 也支持 `all:true`）；
    真机验收（临时脚本，跑完已删）**22/22 通过**：种两个视频的桶 → 换视频/没采过的视频时
    `totalAll` 仍是 5 且 `videoCount` 是 2；单视频 CSV 仍 17 列 4 行、无 `video_id`；
    「全部视频」CSV 18 列 6 行且两个 `video_id` 都在、一级 3 二级 2；「全部视频」JSON `scope=all`、
    `videos` 2 个、5 条评论每条带 `videoId`；面板真机页面显示「本地已存 2 个视频 / 5 条」；
    点「全部视频」后按钮选中态互斥、导出落盘文件内容正确；面板「清空」只作用于当前页面这条视频、
    两个种子桶一条没少；导出是只读的。
    配套 MCP `douyin-mcp` **没动，仍是 0.3.1**。

**0.5.6 新增**：

1. **面板「清空」拆成两个按键**：原来那一个「清空」现在是 `[清空] [全部清空]`。
   - **「清空」**（无危险样式，挂点 `data-dts-act="clear-video"`）：只清**当前视频链接**这一条的
     去重桶 `dts_c_<videoId>`，并从 `dts_videos` 里摘掉这一条；别的视频数据、面板设置
     `dts_user_settings` 都不动。护栏保留：页面没识别到 videoId 时**不发清空**，提示
     「未识别到视频 ID，无法清空；请先打开具体视频页/浮层」。
     提示文案：`已清空本视频的本地去重表与扩展存储；下次「开始采集」将从头重扫`。
   - **「全部清空」**（红色危险样式 `.dts-btn-danger`，挂点 `data-dts-act="clear-all"`）：
     **两步确认**——第一次点只「上膛」：按钮变成 `确认全部清空？` 并加 `.dts-armed` 红底强调，
     提示「再点一次「全部清空」确认：会清掉所有视频的评论与本地去重表（不可恢复），5 秒内有效」，
     **数据一条不动**；5 秒内第二次点才真清（清掉所有 `dts_c_*` 与 `dts_videos`，
     保留 `dts_user_settings`），提示「已清空全部视频的评论与本地去重表（共 N 个视频）；
     下次「开始采集」将从头重扫」；超过 5 秒按钮文案自动复原成「全部清空」。
     它**不受**「未识别到视频 ID」护栏限制（在任意页面都能全清）。
2. **内置扩展升到 0.2.8**（插件 0.5.6 自带的那份）：两个按钮都有 `data-dts-act` 挂点，
   采集器用 `[data-dts-act="clear-video"]` 点「清空」（老版本扩展没有挂点时才退回按文案
   `/^清空$/` 找按钮）；后台仍然要求 `msg.all === true` 才做「全部清空」，并保留 `NO_VIDEO_ID` 护栏。
3. **修掉采集器一个致命 bug：`page.evaluate` 传了多余参数**（真机 E2E 抓到）。
   Playwright 的 `page.evaluate(fn, arg)` 只有**一个**参数位（第二参是 options），而本版新写的
   `clickPanel(re, act)` 误写成 `page.evaluate((src, a) => {...}, re.source, act)` —— 于是只要
   `clearBefore: true` 就立刻抛
   `Too many arguments. If you need to pass more than 1 argument to the function wrap them in an object.`
   （离线断言、直接点按钮的真机测试都看不出来，只有真跑一轮采集才会崩）。现已改成把参数包成
   一个对象：`page.evaluate(({ src, a }) => {...}, { src: re.source, a: act || '' })`。
4. **自测**：`node verify-tool.mjs` 全绿 **121/121**（原 113 + 新增 8 条：两个按钮与 `data` 挂点、
   「全部清空」两步确认、全清不设 videoId 限制、采集器按挂点点「清空」、后台仍要求 `all===true`
   且保留 `NO_VIDEO_ID`、CSS 有危险样式与上膛样式、`page.evaluate` 最多只传 1 个参数（静态扫描）、
   `clickPanel` 把参数包成一个对象）；真机按钮验证 **18/18 全过**
   （面板两个按钮、单视频清空只清本条、第一次点全清只上膛不动数据、5 秒过期复原、第二次点真全清、
   设置保留；测试前后真实 profile 的存储键集合完全还原，脚本跑完即删）；真机端到端采集
   （`max=20`、`clearBefore=true`、`https://www.douyin.com/video/7660328050596371819`）交付 **196 条**，
   CSV 记录数 = JSON 条数 = 196，扩展 v0.2.8。
   配套 MCP `douyin-mcp` **没动，仍是 0.3.1**。

**0.5.5 新增**：

1. **内置扩展升级到 0.2.7，并修掉「脚本缓存清错地方」**（重要）：以前只清 `Default/Code Cache` 与
   `Default/Service Worker/ScriptCache`，会留下指向已删脚本的注册库 `Default/Service Worker/Database`，
   Chrome 因此起不来扩展后台 —— 面板照样注入，但页面每次 `sendMessage` 都回
   `Could not establish connection. Receiving end does not exist.`，表现就是「点清空没反应 /
   面板谎称已清空、评论一条不落库、最后交付 0 条」。真机对照实测：只清 ScriptCache 跑 2 轮
   （1 轮正常、1 轮扩展 SW 数=0 且探活失败）；改成清掉整个 `Default/Service Worker` 后 **2/2 正常**。
   现在清 `Default/Code Cache` + 整个 `Default/Service Worker`。
2. **采集器新增「扩展后台可达性」预检 + 自愈**：面板就绪后读页面自测的 `bgOk`/`bgErr`，命中
   `Receiving end does not exist|Extension context invalidated` 就 `page.reload()` 重试（最多 2 次），
   仍不通就把这次启动标脏（`~/.dsh/douyin-collector/extension.launched.json` 的 hash 置空，
   下次强制清缓存重开）并明确报错「扩展后台没有响应……本轮采到的评论不会落库」，**不再静默交付 0 条**。
3. **内容脚本主动探活**：新增 `probeBackground()`（发 `{type:'dts-ping'}`，启动 200ms 后一次、
   之后每 30 秒一次），状态镜像与面板文案新增 `bgOk`/`bgErr`/`bgCheckedAt`；扩展上下文中断时
   面板不再谎称「已清空」。
4. **后台新增零副作用探针 `dts-ping`**：只回 `{ok:true,pong:true,at}`；用 `dts-status` 探活会给
   `updateVideoMeta` 写一条 `videoId=undefined` 的脏记录。
5. **「交付 0 条」如实归因**：页面采到 N 条但扩展存储没增加时，明确报「落库失败（扩展后台不可达）」，
   不再把锅甩给「抖音限流 / 视频没有新评论」。
6. **清空没生效会明确报错**：`clearBefore` 时点「清空」两次仍不空 → 刷新页面重试 → 仍不空则报错
   （点了 3 次仍剩 N 条），不再当成功继续。
7. **配套 MCP `douyin-mcp` 0.3.1**：① `host` 支持 IPv6（拼 `http://[::1]:18765`；以前拼成
   `http://::1:18765` 会让每个请求 500 → 永远 `NO_HUB`）；② HTTP 头块被切开时不再把头行当 NDJSON
   吃掉（丢帧）；③ 无 `id` 的请求（`initialize`/`tools/list`/`ping`/`hub/health`）不再回无 `id` 的对象；
   ④ 清掉写死的 `D:\node-v22.23.1\node.exe`（`douyin-mcp.cmd`、`restart-hub.ps1` 改为
   `%DTS_NODE_EXE%` / PATH 兜底），`force-reload-checklist.ps1` 不再写死「扩展应当是 v0.2.1」；
   ⑤ `sync-extension.mjs` 同步后反向清理白名单外的旧文件，`verify-tool.mjs` 增加
   「插件自带 `extension/` 没有多余文件」硬校验。
8. **自测**：`verify-tool.mjs` 全绿 **113/113**（原 106 + 新增 7 条：`dts-ping` 零副作用、
   内容脚本探活+镜像、采集器 bgDead/自愈/标脏、清空 3 次报错、交付 0 条归因、
   `Config` 不直接链式 `.volatile()`、`loadSchema` 先取宿主副本）；
   MCP 三个冒烟（`test-hub.js`、`test-mcp-handshake.js`、`test-settings.js`）全过。
9. **全新 profile 里也能加载**（发布验收发现）：有些 profile 里 pnpm 会给插件装一份**旧版**
   `@deepseek-ai/schemastery`（实测 3.18.2，没有 `Schema.prototype.volatile`），`Config` 直接链式
   `.volatile()` 会抛 `TypeError: ...volatile is not a function` —— dsh 只打印
   「1 entry did not activate / failed to import」，**插件装了却没有 `douyin_comments` 工具**。
   现在 `loadSchema()` 先取宿主那份 schemastery（裸说明符放最后），字段一律走 `vol()` 兜底：
   旧版没有 `.volatile()` 时插件照常加载（只是那几个字段在设置表单里不能改），不会再整个 import 失败。

**0.5.4 新增**：

1. **内置扩展升级到 0.2.6**：AI 桥新增 `get_settings` / `set_settings` 两条命令，`start_collect`
   可带 `settings`（先写 `dts_settings` 再启动，回包带 `appliedSettings` / `settingsNote`），
   `status` 回包多了 `settings` 快照。配套 MCP `douyin-mcp` **0.3.0**
   新增 `ai_get_settings` / `ai_set_settings`，`ai_start_collect` 支持 `max` / `lanes` /
   `replyLanes` / `replyGapMs` / `replyWarmupMs` / `replyThrottleMaxWaitMs`。协议见 PROTOCOL §7.9。
2. **优先级没变**：`dts_user_settings`（面板齿轮）> `dts_settings`（AI/插件下发）> 内置常量 ——
   也就是人在面板里点过「保存」的项，AI 覆盖不了（想覆盖得用 `scope:"panel"` 或先 `clear:"user"`）。
3. 离线自测 **102/102**（多了 6 项桥命令断言 + 8 项「扩展更新后不跑旧脚本」断言 + 5 项「只从扩展自己的 SW/扩展页读写 storage」断言）；扩展与插件两处副本逐字节一致。
4. **修掉「扩展更新了、浏览器还在跑旧代码」**：Chrome 会把未打包扩展的脚本缓存在 profile 的
   `Default/Code Cache` 与 `Default/Service Worker/ScriptCache` 里，只换扩展文件不换这两处，
   新开的窗口仍执行上一次的 `background.js`（实测表现：manifest 已是 0.2.6，AI 桥却回
   `UNKNOWN_COMMAND:get_settings`）。现在插件把每次启动用的扩展 hash 记进
   `~/.dsh/douyin-collector/extension.launched.json`，下次启动发现扩展变了就
   （a）清掉这两个缓存目录、（b）把「接上一次留下的窗口」也关掉重开。

**0.5.3 新增**：

1. **面板设置入口改成标题栏齿轮 `⚙`**（扩展 0.2.5）：齿轮在「—」收起按钮**左边**，
   不再占第三行按钮位置；点开浮层第一项就是 **`max` 目标条数**，另有 并发路数 / 回复并发 /
   回复间隔 / 限流等待，当前生效值显示在浮层顶部「当前：并发 N 路 · 目标 M 条/不限（面板）」。
   存键与优先级不变（仍是 `dts_user_settings` > `dts_settings` > 内置）。
2. 浮层打开时面板自动撑高（`.dts-settings-open`，`min-height: 292px`），并修掉「当前：…」
   那一行被 flex 压成一条缝的样式 bug（子项 `flex: 0 0 auto`）。

**0.5.2 新增**：

1. **扩展面板自带「设置」按钮**（0.2.4）：面板第三行 `[设置]` + 一行摘要，点开可改
   目标条数 / 并发路数 / 回复并发 / 回复间隔 / 限流等待，存进扩展的
   `chrome.storage.local.dts_user_settings`。取值优先级 **面板设置 > 插件下发（`dts_settings`）> 内置默认**；
   面板里没填的字段继续用插件值。`startLoop()` 每轮开头读一次 ⇒ 保存后下一次「开始采集」生效。
2. **默认不再清空扩展旧数据**：保留断点续采进度，结束时按 `cid` 差集只交付本轮新采的评论；
   要清空（从头采）就传 `clearBefore=true` 或改设置里的 `clearBefore`。
3. **二级回复限速可调**：设置新增 `replyLanes`（1~8）、`replyThrottleSec`（10~600，只放宽）、
   `replyNoProgressSec`（60~7200）；修掉「一级采完、二级回复一条没补上」的几处成因
   （到量判定不再在 collecting 阶段就把扩展掐停；回复阶段的「无进展收工」单独计时）。
4. **兼容 macOS**：浏览器查找支持 `~/Library/Caches/ms-playwright`、
   `/Applications/Chromium.app`、`Google Chrome for Testing.app`、Homebrew/node 全局模块目录；
   品牌版 Chrome 137+ 会忽略 `--load-extension`，这时会打警告并提示换 Chromium（`npx playwright install chromium`）。
5. 目标条数 `max` 语义澄清：**只掐一级评论**，到量后二级回复仍会补完（与扩展面板的 `maxCount` 一致）。

**0.5.0 新增**：

1. **插件设置表单**：在 DSH 的「设置 → 插件 → dsh-douyin-comments」里直接改目标条数 `max`、并发路数 `lanes`、
   总超时 `timeoutMs`、等扫码 `waitLoginSec`，**改完立即生效**（不用重启、不用重装、也不用重装插件）。
   **（0.5.10 起 `lanes` 这一项已停用**：扩展 0.2.12 起顶层列表固定单路，改了也不影响采集，仅保留兼容。）
   实现就是标准的 cordis `Config`（schemastery），字段都标了 `volatile`——DSH 只允许表单改 volatile 字段，
   好处正是「改完 live 生效」。工具参数仍然只覆盖当次调用，不改设置。
2. **目标条数默认 300 → 80000**：300 太小（一轮就顶到），默认值与扩展单视频评论池的防御上限
   （`extension/background.js` 的 `MAX_COMMENTS_PER_VIDEO = 80000`）对齐。
3. **总超时默认 240000 → 1800000（30 分钟）**：默认要能采到几万条。
4. **并发路数 `lanes` 可调**（1~8，默认 4 = 实测甜点）：一轮同时发几路分页请求。
   以前写死在扩展里（`content.js` 的 `MAX_LANES`），现在插件在点「开始采集」前把路数写进扩展的
   `chrome.storage.local.dts_settings`，扩展每轮都现读；返回值 `lanes` 是扩展写回的**实际**路数。
   **（0.5.10 起该设置已停用：扩展 0.2.12 起顶层列表固定单路，`lanes` 仅保留兼容、不影响采集——原因见上方「0.5.10 新增」。）**
   环境变量 `DOUYIN_MAX` / `DOUYIN_LANES` / `DOUYIN_TIMEOUT_MS` 也能给出厂值兜底（设置没声明时用）。

**0.4.1 修了什么**（0.4.0 发出去踩的两个坑）：

1. **未登录不再硬采**：以前未登录也直接开始采集（登录探测只看 DOM，实测未登录时登录按钮/弹窗常常一个都探不到），
   匿名接口采到一半就被限流、数据残缺。现在以登录 cookie 为准，没登录就停下来等你扫码（默认 180s），
   等不到返回 `phase=need-login` 并把浏览器窗口留着，扫完再调一次即可。
2. **peerDependencies 不再卡死运行时**：`@deepseek-ai/dsh-tools` 从 `^0.1.5-rc.3` 改成 `>=0.1.5-rc.3`。
   旧范围遇到 0.2.x 运行时会被 DSH 判定不兼容，**静默跳过整个 bundle** → 工具永远不出现、重启无效。

特点：

- **自带 Chrome 扩展**（抖音评论采集器 v0.2.12）。第一次调用时会自动把扩展装进它启动的浏览器，
  不需要使用者手动「加载已解压的扩展程序」；扩展面板标题栏自带设置齿轮 `⚙`（0.2.5 起，在「—」左边）。
- **只交付本次新采的数据**：结束时按 `cid` 差集剔除旧数据，只交付本轮新增的；
  一条新数据都没有就返回失败并说明原因，绝不把上一轮残留当成本轮结果。
  （**默认不再清空**扩展里的旧数据，断点续采进度得以保留；要清空就传 `clearBefore=true`。）
- **轻量**：评论在浏览器侧采集落库，模型侧只看到工具返回值 + 最多 5 条样本，不往上下文里灌原始评论。
- 有头浏览器窗口（默认就能看见，方便扫码登录/观察进度）；调用被取消时自动点「暂停」并落盘已采到的部分。
- **没登录不会硬采**：未登录就先停下来，把登录二维码留在窗口里等使用者扫码（默认最多等 180 秒，
  `waitLoginSec` 可调）；等不到就返回 `phase=need-login` 并**保持窗口打开**，扫完再调用一次即可接着采
  （第二次会接上同一个浏览器窗口，不会去抢 profile 锁）。
  判据是**登录 cookie**（`sessionid` / `sessionid_ss` / `sid_tt`）：实测未登录时抖音页面上经常连登录按钮、
  登录弹窗都探不到，只看 DOM 会漏判 → 直接裸采 → 被限流 → 数据残缺。
  （以前默认 `waitLoginSec=0` 且只看 DOM，等于没登录也照采。）明知要裸采时用 `DOUYIN_ALLOW_ANONYMOUS=1`。

## 面板（采集时那个悬浮面板）

面板标题栏右侧是设置齿轮 `⚙`（0.2.5 起，在「—」收起按钮左边）；主体自上而下：

| 行 | 内容 |
| --- | --- |
| 状态 / 进度 | 阶段、进度条、「已采（去重）」——本轮还没落库但本地已有该视频数据时显示 `（本地已有 N 条）` |
| **本地已存**（0.5.7 新增） | `N 个视频 / M 条（本条 X 条）`：跨视频的本地总规模。面板构建时读一次（后台 `dts-stats`），之后每 20 秒刷新，落库后与点「清空」后立刻刷新 |
| 按钮 1 | `[开始采集]` `[暂停]` |
| 按钮 2 | `[导出 CSV]` `[导出 JSON]` |
| **导出范围**（0.5.7 新增） | `[本条视频]`（默认，等于旧行为）/ `[全部视频]`，两个互斥；自动化挂点 `data-dts-act="export-scope-video"` / `data-dts-act="export-scope-all"`，选中态 CSS 类 `dts-on` |
| 按钮 3 | `[清空]`（挂点 `clear-video`，**只清当前这条视频**）/ `[全部清空]`（挂点 `clear-all`，**清所有视频**、两步确认、不可恢复） |

点「开始采集」时面板会先写一行 `本机已存：N 个视频 / M 条（含其它视频）；本条视频本地已有 X 条`
——换视频不会丢数据，只是旧面板的计数/导出都只认当前这条视频。

## 安装

方式一：目录安装（本机开发/自己用）

```powershell
dsh plugin --profile web add file:D:\dycopy\dsh-douyin-comments
```

方式二：tarball 安装（把包发给别人时用）

```powershell
# 对方收到 dsh-douyin-comments-0.5.10.tgz 后：
dsh plugin --profile web add file:C:\path\to\dsh-douyin-comments-0.5.10.tgz
```

装完**不用重启**。桌面端（DSH Desktop）这类由启动器提供 `profileContext` 的宿主默认启用
`@deepseek-ai/dsh-hmr`（`root: []` 表示只监听 profile 配置、不监听源码模块），安装**新**插件会即时
重新组合并挂载，插件管理器把这种结果报成 `applied`。工具名是 `douyin_comments`
（不带 `mcp__` 前缀，这是原生插件而不是 MCP server）。

唯一要重启的情况是**覆盖安装同一个包**（0.5.9 → 0.5.10 这种换版本）：Node 的模块缓存里还是旧代码，
而 HMR 默认不监听源码模块，插件管理器会报 `restart-required`（界面提示「更改将在下次启动生效」），
这时候重启 DSH 才会用上新版本。没有 `profileContext` 的宿主（headless / SDK / ACP 组合包，HMR 被禁用）
一律是重启后生效。

更新插件代码后：

```powershell
Remove-Item C:\Users\mo\.dsh\profiles\web\node_modules\dsh-douyin-comments -Recurse -Force
dsh plugin --profile web add file:D:\dycopy\dsh-douyin-comments
# 覆盖安装同名包：重启 DSH 才会加载新版本代码
```

（`file:` 依赖是**真实拷贝**，不删旧拷贝时 pnpm 可能认为「已是最新」而不覆盖。）

> ⚠️ **装完、也重启了，`douyin_comments` 还是不出现？** 先看 `package.json` 的 `peerDependencies`。
> DSH 启动组装 profile 时会对每个 bundle 做兼容性检查：**只要带 `@deepseek-ai/dsh-` 前缀的 peer 不满足
> 当前运行时，整个 bundle 会被静默跳过**（只在 stderr 打一行 `skipping profile bundle ...`），
> 工具永远不出现，重启多少次都一样。而 DSH 那句兼容性提示又写着「retry the installation or restart dsh」，
> 特别容易把人带沟里 —— 2026-10-05 踩过：`@deepseek-ai/dsh-tools: ^0.1.5-rc.3`（= ≥0.1.5-rc.3 <0.2.0）
> 遇上 0.2.0-rc.2 的运行时（DSH Desktop 2.0.17 自带的就是它）。所以 dsh-* 的 peer 一律写宽范围
> （`>=0.1.5-rc.3`），`node verify-tool.mjs` 里有一项专门守这个。
> 确实要放行某个不匹配的版本：`dsh plugin --profile web allow-version <name@version> --dsh-version <exact> --accept-risk`。

> 🧩 **同一台机器装多个 profile（desktop + web）没问题，但只有一个浏览器**：浏览器 profile、扩展目录、
> 输出目录、CDP 端口（`~/.dsh/douyin-collector/*` 与 9510）在同一个 DSH_HOME 下是**共享**的。
> 所以两边都装可以，登录态也是共享的（任意一边扫一次码，另一边就不用再扫）；但同一时刻只允许一个采集在跑 ——
> 工具用 `~/.dsh/douyin-collector/collector.lock` 保证这点，第二个调用会直接报
> 「已经有一个采集在跑（pid …，profile …）」，不会去抢同一个浏览器窗口。
> 注意 `isConcurrencySafe=false` 只管得住单个宿主进程，跨 profile 靠的就是这个锁。

## 前置条件

| 项 | 说明 |
| --- | --- |
| Node.js | ≥ 22.19.0（插件与扩展驱动都在 Node 侧） |
| playwright-core | **已列为插件依赖**，`dsh plugin add` 时自动装进 profile（13 MB，不含浏览器）。也支持全局已装的副本，或用 `DOUYIN_PLAYWRIGHT` 指定模块目录 |
| 浏览器 | 优先 `%LOCALAPPDATA%\ms-playwright\chromium-*`（实测 1208 / 1228 可用，1228 = Chrome 149）；没有就用系统已装的 Chrome / Edge，或用 `DOUYIN_CHROME` 指定 |
| 抖音登录态 | 持久化 profile `~/.dsh/douyin-collector/chrome-profile`。判据是登录 cookie（`sessionid`/`sid_tt`）：**没有就视为未登录，不会开始采集**，会留出二维码默认等 180 秒（`waitLoginSec` 可调）；等不到返回 `phase=need-login`，浏览器窗口保持打开供扫码 |
| 网络 | 需要能访问 douyin.com |


环境变量覆盖：`DOUYIN_EXT_DIR`（扩展源目录）、`DOUYIN_COOKIES`（可选 cookies 文件）、
`DOUYIN_PROFILE`（Chrome profile）、`DOUYIN_CHROME`（chrome.exe 绝对路径）、`DOUYIN_OUT_DIR`（输出目录）、
`DOUYIN_CDP_PORT`（默认 9510）、`DOUYIN_WAIT_LOGIN_SEC`（默认 180）、`DOUYIN_ALLOW_ANONYMOUS=1`（未登录也照采，默认关）、
`DOUYIN_MAX` / `DOUYIN_LANES` / `DOUYIN_TIMEOUT_MS`（出厂默认值兜底，设置表单里改的优先）。

## 插件设置（DSH「设置 → 插件 → dsh-douyin-comments」）

插件导出一个 cordis `Config`，DSH 的 `@deepseek-ai/dsh-settings` 会自动把它渲染成表单；保存走
`configEditor.edit()` 写进 profile patch（`<profile>/cordis.patch.yml`），**改完立即生效**。

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `max` | 80000 | 目标条数（**一级评论**）：采到这么多就让扩展点「暂停」并落盘；二级回复仍会补完 |
| `lanes` | 4 | **已停用**（扩展 0.2.12 起顶层列表固定单路）：仍可读写、仍会下发给扩展，但**不影响采集**，仅保留兼容 |
| `timeoutMs` | 1800000 | 单次采集总超时（30 分钟）；到点也会把已采到的评论落盘 |
| `waitLoginSec` | 180 | 未登录时等你扫码的秒数；0 = 不等，直接返回 `need-login` |
| `clearBefore` | false | 是否先清空扩展里该视频的旧数据。**默认 false**：保留断点续采进度，结束时按 `cid` 差集只交付本轮新采的 |
| `replyLanes` | 4 | 二级回复的并发线程数 1~8 |
| `replyThrottleSec` | 10 | 撞上限流窗口时最多等几秒（10~600；下限就是内置值，只能放宽） |
| `replyNoProgressSec` | 900 | 回复阶段连续多久没新数据就收工（60~7200） |

细节：

- 字段都是 `volatile`：`execute()` **每次调用现读一遍**（volatile 值在 cordis 里是只有 `get` 的只读引用，
  缓存快照会读到旧值），所以改完下一次调用就生效。
- 工具参数（`max`/`lanes`/`timeoutMs`/`waitLoginSec`/`clearBefore`）**只覆盖当次调用**，不会改设置。
- 表单里改的路数由插件在点「开始采集」前写进扩展：`chrome.storage.local.dts_settings = {lanes, replyLanes?, replyThrottleMaxWaitMs?}`；
  扩展每轮读它（读不到或越界就退回内置值），并把实际用的值写回 `dts_settings_effective`，插件据此回报返回值里的 `lanes`。
  **注意（0.5.10 起）**：`lanes` **已停用**——扩展 0.2.12 起顶层列表固定单路（多路并发会被服务端合并成同一页，
  4 路少采约 30%），所以返回值里的 `lanes` 恒为 1，写进去的路数只在 `dts_settings_effective.lanesWanted` 里回显。
  **注意**：扩展面板自己的设置（0.2.4 文字按钮 → 0.2.5 标题栏齿轮 `⚙`，存 `dts_user_settings`）
  优先级更高——面板里设过的字段会盖掉插件下发值。
- 加载不到 `@deepseek-ai/schemastery` 时（例如在一个残缺的 profile 里跑）插件照常工作，只是**没有这张表单**。

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | — | **必填**。`https://www.douyin.com/video/<id>`、带 `modal_id` 的浮层链接，或直接给 15~25 位 aweme id |
| `max` | integer | 设置里的值（出厂 80000） | 目标条数（一级评论），到量即暂停并落盘（实际条数通常略多于 max；二级回复仍会补完） |
| `lanes` | integer | 设置里的值（出厂 4） | **已停用**（扩展 0.2.12 起顶层列表固定单路，并发会被服务端合并成同一页、4 路少采约 30%）：传了不报错、也不改设置，但采集固定单路，只在返回值 / `dts_settings_effective.lanesWanted` 里回显 |
| `replies` | boolean | true | 是否补采二级回复；`false` 只采一级，更快 |
| `timeoutMs` | integer | 设置里的值（出厂 1800000） | 总超时；到点也会把已采到的评论落盘 |
| `waitLoginSec` | integer | 180 | 检测到未登录时等使用者扫码的秒数；**显式传 0 = 不等**（直接返回 `need-login` 并把窗口留着） |
| `clearBefore` | boolean | 设置里的值（出厂 false） | 是否先清空扩展里该视频的旧数据；默认 false = 保留断点续采，只交付本轮新采的 |
| `outDir` | string | **当前会话工作区**/`douyin-comments` | 输出目录。默认写进调用者自己的工作区，CSV/JSON 就在他的项目目录里；取不到会话工作区（非 agent 调用）时退回 `~/.dsh/douyin-collector/out` |
| `keepOpen` | boolean | false | 调试：采完不关窗口 |

## 返回值

`ok`、`error`、`videoId`、`title`、`count`、`csvPath`、`jsonPath`、`phase`、`lanes`、`note`、
`durationSec`、`extensionVersion`、`extensionInstalled`、`sample`（前 5 条预览）。

`csvPath` / `jsonPath` 默认指向**调用方自己会话的工作区**：`<workspace>\douyin-comments\douyin-comments-<videoId>-<时间>.{csv,json}`
（会话工作区取自 `exec.agent.session.header.cwd`；取不到才退回 `~/.dsh/douyin-collector/out`）。

- `ok=false` 时 `error` 是可操作的原因（例如「本轮从头到尾没拿到页面签名（<面板说明>）」），
  此时 `csvPath`/`jsonPath` 为空串，**不会写文件**。
- `extensionInstalled=true` 表示本次把扩展重新装进了浏览器（首次调用、或扩展版本变了）。

## 输出格式

- **CSV**（UTF-8 BOM，Excel 直接打开）17 列：`cid,create_time,create_time_str,text,text_clean,text_len,digg_count,reply_comment_total,ip_label,is_hot,is_folded,level,stick_position,user_nickname,user_uid,is_reply,parent_cid`。
  文本里保留表情贴纸（如 `[比心]`）。
- **JSON**：`{exportedAt, videoId, title, totalReported, count, topLevelCount, replyCount, note, freshOnly:true, extension{version,installed}, comments:[…]}`。
- 文件名：`douyin-comments-<videoId>-<时间戳>.csv/.json`。

上面是**插件自己写盘**的那份（一次调用只导当前这一个视频，列契约与扩展 `background.js` 同源）。
浏览器面板上的「**导出范围 → 全部视频**」（扩展 v0.2.9 的 `dts-export` 带 `all: true`）另外走一条路：

| | 单视频（默认「本条视频」） | 全部视频（v0.2.9 新增） |
| --- | --- | --- |
| CSV 列 | 17 列（同上，列序冻结） | **18 列：末尾追加 `video_id`**；前 17 列的顺序与含义完全不变，老读者按位置读前 17 列仍然正确 |
| JSON | `{exportedAt, videoId, title, count, …comments[]}` | 顶层多 `scope: "all"` 与 `videos: [{ videoId, title, count }]`；每条评论也带 `videoId` |
| 文件名 | `douyin-comments-<videoId>-<时间戳>.csv\|json` | `douyin-comments-all-<时间戳>.csv\|json` |

## 数据新鲜度怎么保证

1. 打开页面、等面板就绪后，先读出扩展里该视频的 `cid` 快照；
2. 点面板「清空」，复查确实空了（真空了就把快照丢掉，只靠差集）；
3. 点「开始采集」，全程盯着 `hasSig`：**本轮一次都没拿到页面签名 ⇒ 直接判失败**，
   因为那意味着扩展根本没发出评论请求，storage 里的东西只可能是上一轮残留；
4. 采集结束后把 `chrome.storage.local` 里的评论全部读出，**过滤掉快照里的 `cid`**，只留下本次新增的；
5. 过滤后为 0 条 ⇒ 判定失败（`ok:false`），不写任何文件。

因此：**每轮导出的是「本轮从评论区开头重新抓到的 max 条左右」**，不是跨轮增量。
连续两轮采同一个视频会有重叠（正常，因为每轮都从头抓），但绝不会出现「本轮什么都没抓到却返回上一轮数据」。

面板里那句「还没拿到签名：没能自动找到评论入口」是**陈旧提示**，不要拿它判成败；
司机侧只看 `phase`/`hasSig`/`unique`。

## 自测

```powershell
cd D:\dycopy\dsh-douyin-comments
node verify-tool.mjs                                     # 离线：工具定义 + 自动装扩展（不开浏览器）
$env:DTS_MAX='60'; node verify-tool.mjs --live https://www.douyin.com/video/7684883150782106916
node _test_freshness.mjs https://www.douyin.com/video/7660328050596371819 60 300   # 两轮 + 文件自洽
node _test_nosig.mjs https://www.douyin.com/video/7660328050596371819              # 负向：没签名必须失败
node _demo_autoinstall.mjs https://www.douyin.com/video/7660328050596371819        # 删掉已装扩展，验证「从零自动装上」
```

实测记录（2026-10-06，v0.5.9 + v0.5.10）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **141/141 全绿**（当时 0.5.9 版为 137，上一版 135；0.5.9 新增 2 条：Hub(AI/MCP) 的 `export` 命令也支持 `all`、成功放 `result` / 失败保持顶层 `error+hint`；导出失败口径统一 `MISSING_VIDEO_ID`（提示可传 all）/ `EMPTY_POOL`，不再下载只有表头的空 CSV。0.5.10 顶层固定单路再 +4 条 → 141） |
| 真机清空验收（正常路径） | **9/9 通过**：两个视频的桶 → 「清空」只清当前视频（其它保留）→「全部清空」两步确认 → 桶与 `dts_videos` 清空，面板「本地已存」立刻「暂无」 |
| 真机清空验收（失败路径） | **8/8 通过**：扩展副本里 `dts-clear` 只回 `{ok:true}` 却不执行 → 面板不谎报「已清空」，显示「「清空」没有生效（…）」+ `edge://extensions` 重新加载 + F5 指引，存储一条没动 |
| 真机清空自检验收（临时脚本 + 临时 profile，跑完已删） | **通过**：种两个视频的桶 → 面板先显示「本地已存 2 个视频 / 7 条」→ 点「全部清空」（两步确认）→ 存储里 `dts_c_*` 与 `dts_videos` 全没了，且面板「本地已存」**立刻**变成「暂无」；修复前同一脚本 FAIL（存储清了但面板仍显示 2 个视频 / 7 条） |
| **MCP 端到端导出验收**（真 Chromium 加载 `D:\dycopy\douyin-collector` 扩展 + 隔离桥端口 18777 + 真 MCP stdio 调用） | **14/14 PASS**：`initialize` 报 `serverInfo={name:'douyin-collector-mcp', version:'0.3.2'}`、`tools/list` 里 `ai_export` 有 `all` 且 `videoId` 不再 required；`ai_export{all:true,format:'csv'}` → `scope=all, videoCount=2, count=5, topLevelCount=4, replyCount=1`（文件名 `douyin-comments-all-2026-10-06T06-17-50.csv`，785 字节，表头末列 `video_id`，内容 v1=3 行 / v2=2 行）；`ai_export{videoId:'v1',format:'json'}` → `scope=video, count=3, videoCount=1, replyCount=1`（1893 字节，无 `videos` 数组）；`ai_export{}` 在 MCP 层直接拒（没发桥命令）、`ai_export{videoId:'no-such-video'}` 回 `EMPTY_POOL` |
| 冒烟 / 回归（同一轮） | `node test-hub.js` **exit 0**；`node test-settings.js` **15/15 exit 0**；`node test-mcp-handshake.js` **`ALL MCP HANDSHAKE: PASS` exit 0**（新增 `hasExportAll` 断言为 true） |
| **顶层列表固定单路实测**（0.5.10 / 扩展 0.2.12，同一视频 `7692405235813272867`） | **768 → 945**：修复前（0.2.11 / 4 路）**768 条**（一级 586 / 二级 182）**20.1s** → 修复后（0.2.12 / 单路）**945 条**（一级 753 / 二级 192）**70.4s**——一级 **+28%**、总条数 **+23%**，代价 20s → 70s。依据：4 路并发 5 轮只 **492 条**且 **0 个失败请求**（同签名同刻多路被服务端**合并成同一页**，两两重合 50/50）；单路串行 18 步 **714~744 条**；4 路**错峰 200ms** 恢复正常；该视频列表上限约 **850 条**（`cursor=850` 只回 8 条、`has_more=0`；`cursor≥900` 回 `null`） |

实测记录（2026-10-06，v0.5.7）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **130/130 全绿**（上一版 121，本次新增 9 条断言：`dts-stats` 的 `totalAll`/`videoCount`、`dts-export` 的 `all:true` 分支、CSV 末尾 `video_id` 列、`all` 文件名、面板「本地已存」行与两个导出范围按钮、20 秒刷新、`all: exportAll` 传参、面板 CSS、AI 桥 `dts-ai-export` 的 `all:true`） |
| 真机验收（临时脚本，跑完已删；真机 Chromium + 真抖音视频页） | **22/22 通过**：种两个视频的桶 → 断言换视频/没采过的视频时 `totalAll` 仍是 5 且 `videoCount` 是 2；单视频 CSV 仍 17 列 4 行、无 `video_id`；「全部视频」CSV 18 列 6 行且两个 `video_id` 都在、一级 3 二级 2；「全部视频」JSON `scope=all`、`videos` 2 个、5 条评论每条带 `videoId`；面板真机页面显示「本地已存 2 个视频 / 5 条」；点「全部视频」后按钮选中态互斥、导出落盘文件内容正确；面板「清空」只作用于当前页面这条视频、两个种子桶一条没少；导出是只读的 |

实测记录（2026-10-05，v0.5.5 及更早，历史版本）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **102/102**（含：设置表单 schema/volatile/toJSON 往返、readSettings 现读、扩展读 `dts_settings`、客户端半身注册两个 slot、面板齿轮入口与 `dts_user_settings` 优先级、浮层第一项是 `目标条数 max`、浮层撑高/不被压扁的样式、`maxCount` 到量自动收工、AI 桥 `get_settings`/`set_settings` 与 `appliedSettings` 透传、扩展 hash 一变就清 `Code Cache`/`ScriptCache` 并把旧窗口关掉重开、扩展 ID 推导与「只认 chrome-extension:// 的 SW」） |
| 真采 `_verify_live.txt`（视频 7684883150782106916） | 22/22，197 条 / 10.1s，CSV 行数 = count，带 BOM |
| 设置真生效（0.5.0 新增，4 例） | `lanes=2`→回报 2；`lanes=9`→钳到 8；设置里 `lanes=3`→回报 3；设置里 `lanes=99`→钳到 8。四例 `ok=true`，日志均见「已把并发路数 N 写进扩展设置」+「扩展实际并发路数：N」 |
| 二级回复真跑通（2026-10-05） | 视频 7666035829038501129（macOS 报告里 0/243 回复的那个）：**1403 条 = 一级 623 + 二级回复 780**，246/246 个线程、247 次回复请求、37.8s，`phase=done`；CSV 里 `is_reply=1` 共 780 行 |
| 扩展面板设置真机 E2E（0.5.2 起，0.5.3 改齿轮后重跑） | 齿轮按钮（`⚙`，在「—」左边）、面板内容区不再有设置按钮行、浮层 5 项且第一项是 `目标条数 max`、「当前：…」行没被压扁、保存按钮完整可见不用滚动、保存写进 `dts_user_settings`、摘要更新、7 条到量后自动收工——**16/16 全过**（脚本跑完已删） |
| MCP 设置链路真机 E2E（0.5.4 新增，扩展 v0.2.6） | MCP `initialize` 0.3.0 + `tools/list` 10 个 tool（含 `ai_get_settings`/`ai_set_settings`）、`ai_status` 带六项设置快照与优先级、`ai_set_settings{max:5,lanes:2,replyLanes:2,replyGapMs:700}` 写进 `dts_settings`（`max`→`maxCount`）、`ai_get_settings` 读回、`ai_start_collect{max:5,lanes:3}` 回包带 `appliedSettings` 且 `dts_settings_effective={maxCount:5,lanes:3}`、`ai_set_settings{scope:"panel"}` 写 `dts_user_settings`、再 start 后 `effective.from="panel"`（`lanes=2` 覆盖插件下发）、`clear:"all"` 清掉两个键、桥配置还原——**19/19 全过**（脚本跑完已删） |
| 两轮新鲜度 `_freshness3.txt` | 15/15，两轮各自清空后重抓，CSV=JSON=count，无重复 cid |
| 负向（假装拿不到签名）`_nosig.txt` | ok=false、count=0、不写文件 |
| 吞吐 | 约 30~70 条/秒（469 条 / 13.8s；1010 条 / 14.1s；8 路 405 条 / 9.8s） |

实测记录（2026-10-06，v0.5.6，历史版本）：

| 用例 | 结果 |
| --- | --- |
| 离线自检 `node verify-tool.mjs` | **121/121**（新增 8 条：两个清空按钮与 `data-dts-act` 挂点、全清两步确认、全清不设 videoId 限制、采集器按挂点点「清空」、后台仍要求 `msg.all===true` 且保留 `NO_VIDEO_ID`、CSS 有危险样式与上膛样式、`page.evaluate` 最多只传 1 个参数、`clickPanel` 把参数包成一个对象） |
| 真机面板按钮 E2E（新脚本，跑完即删） | **18/18 全过**：面板两个按钮、单视频清空只清本条、第一次点全清只上膛不动数据、5 秒过期复原、第二次点真全清、设置保留；测试前后真实 profile 的存储键集合完全还原 |
| 真机端到端采集（`max=20`、`clearBefore=true`、`https://www.douyin.com/video/7660328050596371819`） | 交付 **196 条**、`phase=paused`（到量落盘）、扩展 v0.2.8、CSV 记录数 = JSON 条数 = 196；**这一轮才暴露出并修掉 `page.evaluate` 多传参数的崩溃** |

## 运行时验证（真 DSH agent 调用，不是模拟）

上面那些是直接调 `collector.mjs` 的验收。要验证「装进 profile 后 agent 真的能调用」，用一次性 headless profile：

```powershell
# 1) 建一个只装 headless app + 本插件的临时 profile
mkdir C:\Users\mo\.dsh\profiles\hdcheck
@'
{
  "name": "dsh-profile-hdcheck",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } }
}
'@ | Set-Content C:\Users\mo\.dsh\profiles\hdcheck\package.json -Encoding utf8
dsh plugin --profile hdcheck add file:D:\dycopy\dsh-douyin-comments

# 2) 让 agent 自己调工具（会真开浏览器采一轮）
dsh --profile hdcheck headless '用 douyin_comments 工具采集 https://www.douyin.com/video/7660328050596371819 （max=30）。工具返回后只回复三行：ok=、count=、csvPath=。'
```

实测（`_headless3.txt`）：agent 自己决定调 `douyin_comments`，拿到 `ok=true count=99`，
csvPath `C:\Users\mo\.dsh\douyin-collector\out\douyin-comments-7660328050596371819-2026-10-05T04-08-25.csv`，
并按要求的格式回复。验证完不想留着这个 profile，直接删 `C:\Users\mo\.dsh\profiles\hdcheck` 即可。

（注意 `dsh --profile web headless "task"` **不行**：web app 不接受位置参数，会报 `too many arguments`。
headless 是另一个 app，必须有对应的 profile。）

## 扩展同步

同步开发目录里的扩展进插件：

```powershell
node sync-extension.mjs                    # 源目录默认 D:\dycopy\douyin-collector
node sync-extension.mjs D:\path\to\ext
```

## 打包 / 发布

**正式分发走 GitHub Releases**（仓库里不放二进制包，`release/` 只在本地做打包输出）：
<https://github.com/monagisa/douyin-ai-collector/releases> —— 当前版本 [v0.5.10](https://github.com/monagisa/douyin-ai-collector/releases/tag/v0.5.10)，
附件有 `dsh-douyin-comments-v0.5.10.zip`（整目录单文件）、`dsh-douyin-comments-0.5.10.tgz`、
`douyin-collector-extension-v0.2.12.zip`、`douyin-collector-mcp-v0.3.3.zip`、`使用说明.md`、`SHA256SUMS.txt`。

本地发布物在 `D:\dycopy\release\dsh-douyin-comments-v0.5.10\`：

| 文件 | 说明 |
| --- | --- |
| `dsh-douyin-comments-0.5.10.tgz` | 插件本体，14 个文件（`index.js`/`collector.mjs`/`cordis.patch.yml`/`README.md`/`package.json` + `client/client.js` + `extension/` 8 个） |
| `douyin-collector-extension-v0.2.12.zip` | 单独的扩展 zip，顶层目录 `douyin-collector/`（8 个文件），供 `chrome://extensions` 手动「加载已解压的扩展程序」 |
| `使用说明.md` | 给收件人看的中文说明（安装/扫码/两处设置/参数/FAQ/macOS） |
| `SHA256SUMS.txt` | 三个文件的 SHA256 |

再外面还有 `D:\dycopy\release\dsh-douyin-comments-v0.5.10.zip`（把上面整目录打成一个单文件，方便直接发给人）。

更早的草稿目录（`D:\dycopy\release\dsh-douyin-comments-v0.5.7\` 及以前）都保留作对照，不删。

重新打包：

```powershell
cd D:\dycopy\dsh-douyin-comments
npm pack --pack-destination D:\dycopy\release\dsh-douyin-comments-v0.5.10

# 扩展开 zip（顶层目录名必须是 douyin-collector；只装 8 个运行文件，别把 md 打进去）。
# 用 .NET ZipFile 逐个 CreateEntry 造，避免 Compress-Archive 多套一层目录：
$rel = 'D:\dycopy\release\dsh-douyin-comments-v0.5.10'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open("$rel\douyin-collector-extension-v0.2.12.zip", 'Create')
Get-ChildItem D:\dycopy\douyin-collector -File |
  Where-Object { $_.Extension -in '.js','.json','.css','.html' } |
  ForEach-Object { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "douyin-collector/$($_.Name)") | Out-Null }
$zip.Dispose()
```

**注意**：清空发布目录时别用 `Remove-Item "$rel\*" -Recurse -Force` —— 它不进回收站，会把里面刚写好的
`使用说明.md` 一起删掉（v0.5.2 打包时踩过，靠旧的外层 zip 解出来才恢复）。要保留的文件先复制到别处。

打包验收（**全新 profile 从 tgz 装**，2026-10-05 对 v0.5.5 实测通过，日志 `_accept_tgz.txt`；v0.5.10 打包后按同样三步验收）：

```powershell
mkdir C:\Users\mo\.dsh\profiles\pkgtest     # package.json：dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]
dsh plugin --profile pkgtest add file:D:\dycopy\release\dsh-douyin-comments-v0.5.5\dsh-douyin-comments-0.5.5.tgz
dsh --profile pkgtest --dump-config | Select-String dsh-douyin-comments
dsh --profile pkgtest headless '用 douyin_comments 工具采集 https://www.douyin.com/video/7660328050596371819 （max=20）。工具返回后只回复三行：ok=、count=、csvPath=。'
# ⇒ ok=true，CSV 落在 ~\.dsh\douyin-collector\out\（实测两轮：194 条 / 227 条——按页落库，条数每轮不同）
```

> 上面那段是 **v0.5.5 的历史实测记录**（命令里的 `v0.5.5` 路径是当时的真实命令，刻意不改）。
> v0.5.10 打包后照抄同样三步，只把包路径换成本版：

```powershell
dsh plugin --profile pkgtest add file:D:\dycopy\release\dsh-douyin-comments-v0.5.10\dsh-douyin-comments-0.5.10.tgz
```

- 依赖 `playwright-core ^1.63.0`（13 MB，只有驱动、不含浏览器）由 `dsh plugin add` 自动装进 profile；
  浏览器优先用 ms-playwright 的 chromium，找不到就用系统已装的 Chrome / Edge（mac 上也找
  `~/Library/Caches/ms-playwright`；品牌版 Chrome 137+ 会打警告并建议换 Chromium）。

## 与其他组件的关系

- 浏览器里跑的扩展本体在 `D:\dycopy\douyin-collector\`（权威开发目录，v0.2.11）；插件里的 `extension/`
  由 `node sync-extension.mjs` 单向同步过去（同步后会反向清理白名单外的旧文件；别再手动复制）。
  插件每次启动都会把扩展 hash 记进 `~/.dsh/douyin-collector/extension.launched.json`，一变就清掉
  profile 里的旧脚本缓存再开浏览器。**注意清的范围**：要清 `Default/Code Cache` + **整个**
  `Default/Service Worker` 目录——只清 `Default/Service Worker/ScriptCache` 会留下
  `Default/Service Worker/Database` 里指向已删脚本的注册库，Chrome 起不来扩展后台：面板照样注入，
  但页面 `sendMessage` 一直回 `Could not establish connection. Receiving end does not exist.`，
  表现是「点清空没反应、面板谎称已清空、评论一条不落库、最后交付 0 条」。真机对照实测：
  只清 ScriptCache 跑 2 轮（1 轮正常、1 轮扩展 SW 数=0 且探活失败），清掉整个
  `Default/Service Worker` 后 **2/2 正常**。手工换扩展文件后若发现浏览器还在跑旧代码
  （AI 桥回 `UNKNOWN_COMMAND`），也是同一处缓存没清干净。
- 采集结果想接着做统计/情感/检索，用分析后端 `D:\dycopy\douyin-analysis\`：
  `python -m douyin_analysis ingest`（自动扫 `~/Downloads` 与 `~/.dsh/douyin-collector/out`），
  或让 agent 直接调 MCP 工具 `mcp__douyin__ingest_paths`。
- 老的 Node 控制面 `D:\dycopy\douyin-mcp\`（Hub + 扩展轮询）仍然可用，但**与本插件不要同时开浏览器扩展通道**：
  插件的扩展是它自己 `--load-extension` 起来的独立实例，和 `douyin-mcp` 的 Hub 不是同一条链路。
