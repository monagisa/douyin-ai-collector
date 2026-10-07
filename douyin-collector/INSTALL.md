# 安装 · 使用 · 打包

> 抖音评论采集器 **v0.2.15** — 无 npm 依赖、无构建步骤。  
> **适用浏览器：Chrome 111+ / Edge（Chromium）**；**不支持** Firefox / Safari（详见 README「适用范围」）。  
> v0.2.x：AI Bridge（本地 MCP，见 `../douyin-mcp/README.md`）；采集核心仍为「复用页面签名、只改 cursor」。  
> 历史要点：v0.1.5 起采二级回复；v0.1.11 起面板绝对坐标拖动 + 开始采集时自动打开评论区；  
> v0.1.12 起按 DOM 判页面形态（关注/朋友/我的可用）；v0.1.13 起换视频/清空后自动重取签名、  
> `hook.js` 由 manifest 在主世界 `document_start` 注入；v0.1.15 起面板固定紧凑档（宽约 236px）；  
> v0.2.2 起并发路数可由 `chrome.storage.local.dts_settings = {lanes}` 设置（1~8，见 PROTOCOL §3.9；**v0.2.12~v0.2.14 该设置被固定成单路，v0.2.15 起重新生效**）；  
> v0.2.3 起二级回复的四档限速也能从 `dts_settings` 覆盖（`replyLanes` / `replyGapMs` / `replyWarmupMs` / `replyThrottleMaxWaitMs`，默认值不变，见 PROTOCOL §3.9）；  
> **v0.2.13 起**再加一道**跨线程全局闸门** `replyGlobalGapMs`（默认 250ms、范围 0~2000；撞限流自动翻倍到 1000ms 封顶、并把并发降 1 路），
> 且 `maxCount`（目标条数）**只停顶层扫描、二级回复仍会补完**（v0.2.4~v0.2.12 的旧实现会把回复一起丢掉）；  
> **v0.2.14 起**「服务端不回数据」不再**一波判终局**：单波最多试 12 秒，只要还有线程没拉到就**自动停一会儿再来一波**
> （停顿 15 → 30 → 60 秒），总窗口 `replyThrottleMaxWaitMs` 默认从 10 秒放宽到 **120 秒**（面板「限流等待 s」可调 10~600 秒，
> 设 10 = 旧行为；DSH 插件侧默认交给扩展决定）；收尾文案如实报**本轮共等多少秒、分几波**，并写明
> 「列表接口正常：服务端回的是 HTTP 200 + 0 字节 body，不是本地请求没回来」。同一版还修正 `replyGlobalGapMs = 0`
> 的语义（**0 / 缺省 = 用内置 250ms**；v0.2.13 及更早把它当「关闸门」，与设置页/MCP/PROTOCOL 文案矛盾），
> 并在补采阶段结束时把阶段交回主循环（旧版停在 `replies`，收尾门槛不成立 ⇒ 面板一直显示「补采二级回复」、
> 采集器还要空等到「无进展」才收工；真机 y1 轮复现）；离线自测 **164/164 全绿**。  
> v0.2.4 起面板自带「设置」按钮（改 目标条数/并发路数/回复并发/回复间隔/限流等待），存 `dts_user_settings`，**优先级：面板 > `dts_settings` > 内置默认**；  
> v0.2.5 起入口改为**标题栏齿轮 ⚙**（在「—」左边，不占按钮行），浮层第一项标签就是 `max` 目标条数，当前生效值显示在浮层顶部；  
> v0.2.6 起 AI 桥可**读写设置**（`get_settings` / `set_settings`，`start_collect` 可带 `settings`），配套 MCP `douyin-mcp` 0.3.0 的 `ai_get_settings` / `ai_set_settings`（见 PROTOCOL §7.9）。  
> v0.2.7 起新增**后台探活**：后台多了零副作用探针 `dts-ping`，内容脚本 `probeBackground()` 会主动探活
> （状态镜像与面板文案含 `bgOk` / `bgErr` / `bgCheckedAt`）；扩展后台不可达时面板不再谎称「已清空」，
> 配套插件也会明确报「落库失败（扩展后台不可达）」而不是静默交付 0 条。  
> v0.2.8 起**面板的「清空」拆成两个按键**：`[清空]` 只清**当前视频链接**这一条的去重桶
> （别的视频与面板设置都不动，没识别到 video ID 时仍然不发清空）；`[全部清空]`（红色危险样式）是
> **两步确认**——第一次点只把按钮「上膛」成 `确认全部清空？`、数据一条不动，5 秒内再点一次才真清掉
> 所有视频的评论与去重表（`dts_user_settings` 保留），超时自动复原；全清不受 video ID 护栏限制。
> 装上新扩展后 **F5 刷新抖音页**（在扩展页点过「重新加载」的旧 content script 会作废）即可看到两个按钮。  
> **v0.2.15 起**顶层列表改回**错峰多路**（`lanes` 默认 **3**，每路错开 **200ms**；`lanes: 1` = 老的单路串行），
> 单路模式的礼貌间隔也从 400ms 降到 **150ms**：2026-10-07 探针实测扫完 21 页单路 15.79s vs 错峰 4 路 7.72s
> （**2.04×**，唯一 cid 907 vs 912 一样多）。合并的真正触发条件是「同一签名 + ~200ms 内**同时**发」
> （同时发 4 个 cursor：Σ200 条、去重后只剩 **56** 条，且 `next` 字段还是对的 ⇒ 静默少采），错峰就正常；
> 扩展一旦发现两路拿到逐条相同的页会**当轮降回单路**并把原因写进 `dts_settings_effective.lanesNote`。
> 离线自测 **172/172 全绿**。  
> v0.2.12 起曾**顶层列表扫描固定单路**（`lanes` 设置被停用）：真机实测（2026-10-06）同一个签名在同一时刻发多路
> 分页请求会被服务端**合并成同一响应**，4 路 5 轮只拿到 492 条一级评论**且 0 个失败请求**；单路串行 18 步
> 拿到 **714~744 条**，每路错峰 200ms 则恢复正常。同一视频实测：修复前（0.2.11 / 4 路）**768 条**、20.1s →
> 修复后（0.2.12 / 单路）**945 条**、70.4s（一级 586→753、二级 182→192）。  
> v0.2.11 起**导出只有一份实现、AI/MCP 也能「全部视频」导出**：面板「导出 CSV/JSON」按钮与
> Hub(AI/MCP) 的 `export` 命令现在共用 `background.js` 的 `exportComments(opts)`，行为完全一致；
> `export` 新增 `all:true`——不传 `videoId` 也能把本地所有视频合成一份导出（每条评论标 `videoId`，
> CSV 末尾追加 `video_id` 列、前 17 列不变，文件名 `douyin-comments-all-<时间戳>.csv|json`）。
> 导出失败口径统一：既没 `videoId` 又没 `all` 回 `MISSING_VIDEO_ID`（hint 提示可传 `all:true`），
> 本地确实没评论数据回 `EMPTY_POOL`——**不再下载一个只有表头的空 CSV**；面板失败提示会带上后台给的
> `hint`（`导出失败：<error>（<hint>）`）。面板 UI、按钮与存储格式都没有变化。  
> v0.2.10 起**清空会自检，失败不再谎报**：以前 `sendClear` 不等后台回包，扩展刚在 `edge://extensions`
> 重新加载 / 后台没响应时面板照样显示「已清空」，其实 `chrome.storage.local` 里一条都没动；现在点
> 「清空 / 全部清空」会**等后台回包**，再由内容脚本 `verifyCleared(vid, all, cb)` **直接读回
> `chrome.storage.local` 自检**（`all=true` 查所有 `dts_c_*` 与 `dts_videos`，否则只查本条视频的桶
> 与它在 `dts_videos` 里的记录），后台回包 + 读回自检**都过**才显示「已清空」；否则明确提示
> 「清空没有生效」，并指引你去 `edge://extensions` 点「重新加载」、回到抖音页按 **F5** 刷新后再试。
> 同时面板统计带请求序号 `localStatsSeq`（清空时把在途的旧 `dts-stats` 回包作废），修掉「全部清空后
> 『本地已存』还显示旧数字（比如 `2 个视频 / 7 条`）」的旧回包竞态。语义不变：`[清空]` 只清当前这条
> 视频，`[全部清空]` 仍是两步确认（`CLEAR_ALL_CONFIRM_MS = 5000`），后台 `dts-clear` 仍要求显式
> `all: true`。  
> v0.2.9 起**面板能看到「别的视频」的数据了**：换视频**不会丢数据**，评论一直按视频分桶存在本地
> （`dts_c_<videoId>`，一个视频一个桶），旧面板只是计数与导出都只认「当前这条视频」，所以滑到下一条
> 再点「开始采集」时看起来像归零。本版**不动任何数据路径**，只补两件事：
> ① 面板新增一行 **「本地已存」** `N 个视频 / M 条（本条 X 条）`（面板构建时读一次，之后每 20 秒刷新，
>    落库后与点「清空」后立刻刷新），「已采（去重）」在本轮还没落库但本地已有该视频数据时显示
>    `（本地已有 N 条）`，点「开始采集」时还会写一行
>    `本机已存：N 个视频 / M 条（含其它视频）；本条视频本地已有 X 条`；
> ② 面板新增一行 **「导出范围」**：`[本条视频]`（默认，等于旧行为）/ `[全部视频]`
>    （本地所有视频的评论合成一份），两个按钮互斥（挂点 `data-dts-act="export-scope-video"` /
>    `data-dts-act="export-scope-all"`，选中态 `dts-on`）。「全部视频」导出的 **CSV 末尾多一列
>    `video_id`**（18 列，前 17 列列序与含义不变），JSON 多 `scope:"all"` 与
>    `videos:[{videoId,title,count}]`，文件名 `douyin-comments-all-<时间戳>.csv|json`；
>    后台 `dts-stats` 相应多回 `totalAll` / `videoCount`。

---

## 1. 抓完会怎么样

采集流程全部在本地完成，**不发评论数据到第三方服务器**。

### ① 跑的时候：边采边落库

content script 把裁剪后的字段交给 background，写入 `chrome.storage.local`（已声明 `unlimitedStorage`）：

| 存储键 | 内容 |
|---|---|
| `dts_videos` | `{ [videoId]: { title, total, count, hasMore, phase, signedUrlAt, … } }` |
| `dts_c_<videoId>` | `{ [cid]: 评论对象 }` —— 按 cid 去重 |
| `dts_ai_bridge` | 可选：MCP Hub 地址（`host/port/enabled`） |
| `dts_settings` | v0.2.2 起：外部写进来的运行时设置（`{lanes, replyLanes, replyGapMs, replyWarmupMs, replyThrottleMaxWaitMs, replyGlobalGapMs}`，都可选）；缺字段就用内置默认（`lanes=3`（v0.2.15 起；v0.2.2~0.2.14 是 4，其中 0.2.12~0.2.14 实际被固定成 1）、`replyLanes=4`、`replyGapMs=600`、`replyWarmupMs=1500`、`replyThrottleMaxWaitMs=120000`、`replyGlobalGapMs=250`）。**`lanes` 自 v0.2.15 起重新生效**（顶层错峰多路，默认 3 路、每路错开 200ms；`1` = 单路）；**v0.2.14 起 `replyThrottleMaxWaitMs` 是「分波重试的总窗口」**（单波 12 秒、波间停 15/30/60 秒），默认 120 秒；`replyGlobalGapMs` 的 0 = 用内置 250ms（v0.2.13 及更早把 0 当关闸门）。v0.2.6 起 AI 经 MCP 的 `ai_set_settings` / `ai_start_collect` 写的就是它 |
| `dts_user_settings` | v0.2.4 起：**面板「设置」按钮**写进去的用户设置（`{maxCount, lanes, replyLanes, replyGapMs, replyThrottleMaxWaitMs}`）；优先级高于 `dts_settings`，删掉它就回到插件/内置值（`maxCount=0` 表示不限条数；面板里不暴露 `replyGlobalGapMs` / `replyWarmupMs`，保存时不会把它们带进来，所以插件下发的值会保留） |
| `dts_settings_effective` | v0.2.3：本轮**实际**用的值 `{lanes, lanesWanted, lanesNote, maxCount, replyLanes, replyGlobalGapMs, replyGapMs, replyThrottleMaxWaitMs, replyWaveBudgetMs, replyParkPlanMs, from: 'panel'\|'plugin', at}`，回写给调用方核对；**v0.2.15 起 `lanes` = 本轮实际路数**（正常 = 设置值，检测到「两路同一页」就地降为 1）、`lanesWanted` 是设置值、`lanesNote` 平时空串、被降路时写明原因；**v0.2.13 起 `maxCount` 是真正下发的目标条数**（插件据此判断扩展是否自己管住了 max）；**v0.2.14 起多两个只读键**：`replyWaveBudgetMs`（单波预算，12000）、`replyParkPlanMs`（停顿计划 `"15000/30000/60000"`） |

单视频上限 `MAX_COMMENTS_PER_VIDEO = 80000`（`background.js`），超出时按 `create_time` 淘汰最早数据。  
落库条数同步到扩展图标角标。

### ② 结束时：进入 `done`，不自动下载

终止信号是服务端列表 **`has_more = 0`**（及触底补扫规则）。数据已在 storage，可关页面/关浏览器，导出时再写盘。

### ③ 导出

面板按钮走 `background.js` 的 `dts-export`：

- **CSV**：`douyin-comments-<videoId>-<时间戳>.csv`，UTF-8 BOM，17 列（前 15 列冻结 + 末尾 `is_reply`/`parent_cid`）
- **JSON**：同名 `.json`，含 `count` / `topLevelCount` / `replyCount` / `comments[]`
- 默认 `SAVE_AS = false`：不弹「另存为」，直接进下载目录
- **成功判据** = 下载进入终态且文件写盘；中断会明确报错，不谎报成功

**v0.2.9 新增「导出范围」**（面板上一行两个互斥按钮，默认「本条视频」）：

- **「全部视频」** = 把本地**所有**视频的评论合成一份：CSV **末尾追加一列 `video_id`**（共 18 列，
  前 17 列的列序与含义完全不变），JSON 顶层多 `scope: "all"` 与 `videos: [{ videoId, title, count }]`
  （每条评论也带 `videoId`），文件名 `douyin-comments-all-<时间戳>.csv|json`。
- 想导出所有视频的数据：**先把「导出范围」切成「全部视频」，再点「导出 CSV / 导出 JSON」**。
  导出是只读的，不会动本地任何数据。
- 单视频仍是 `douyin-comments-<videoId>-<时间戳>.csv|json`，17 列。

### ④ 清库

`dts-clear`：传 `videoId` 只清该视频（面板「清空」按钮），不传清空全部（面板「全部清空」按钮，两步确认）；角标归零。

**两个按钮的范围完全不同，别当成一回事**（v0.2.8 起，v0.2.9 再重申）：

| 按钮 | 挂点 | 作用范围 | 是否可恢复 |
|---|---|---|---|
| `[清空]` | `data-dts-act="clear-video"` | **只清当前页面这条视频链接**的去重桶 `dts_c_<videoId>`（并从 `dts_videos` 摘掉这一条） | 不可恢复 |
| `[全部清空]` | `data-dts-act="clear-all"` | **所有视频**的评论与去重表（`dts_user_settings` 保留） | 两步确认后不可恢复 |

- 换视频、清空某一条视频**都不会影响别的视频**的数据；没识别到 video ID 时「清空」不发请求（有护栏），
  「全部清空」不受该护栏限制、任意页面都能用。
- 数据本身按视频分桶存（`dts_c_<videoId>`），所以「换视频后上一条不见了」只是面板只显示当前这条 ——
  点「导出范围 → 全部视频」就能把它们一起导出来。
- **清空会读回存储自检**（v0.2.10）：点「清空 / 全部清空」会先等后台回包，再由内容脚本直接读回
  `chrome.storage.local` 核对（`verifyCleared`）——只有真清掉才显示「已清空」。失败时明确提示
  「清空没有生效」，让你去 `edge://extensions` 点「重新加载」、回到抖音页按 **F5** 刷新后重试，
  **不会再假报「已清空」**。

---

## 2. 五分钟上手

```text
1. chrome://extensions → 开发者模式 → 加载已解压的扩展程序
2. 选择本目录（含 manifest.json 的那一层，不要选上级）
3. 浏览器登录抖音
4. 打开 https://www.douyin.com/video/<id>
5. 右下角出现面板；必要时按提示打开评论区
6. 点「开始采集」→ 等待完成/暂停
7. 点「导出 CSV」或「导出 JSON」——默认只导**当前这条视频**；想一次导出**本地所有视频**的评论，
   先把“导出范围”那一行切成 **「全部视频」** 再点导出（CSV 会多一列 `video_id`，
   文件名 `douyin-comments-all-<时间戳>.csv`）。面板上「本地已存 `N 个视频 / M 条`」那行
   就是跨视频的总规模，换视频**不会**把它清零
8. 想清数据：面板最后一行是 `[清空] [全部清空]` ——「清空」只清**当前这条视频链接**的评论
   （别的视频数据和面板设置都不动）；「全部清空」会清掉所有视频的评论与去重表，
   为了防手滑要**连点两次**（第一次只是「上膛」确认、数据一条不动，5 秒内再点一次才真清）
```

**改过代码后**：在 `chrome://extensions` 点扩展的 **重新加载**，再 **F5 刷新抖音页**。

> 只用 `chrome://extensions` 换文件、不点「重新加载」的话，浏览器可能仍在跑**上一次的脚本**
> （Chrome 把未打包扩展的脚本缓存在 profile 的 `Default/Code Cache` 与
> `Default/Service Worker/` 里）：现象是 `manifest.json` 已经是新版本号，
> 但新加的命令/功能不生效（例如 AI 桥回 `UNKNOWN_COMMAND:get_settings`）。
> 点一次「重新加载」即可；实在不行就关掉浏览器，**把 `Default/Code Cache` 与整个
> `Default/Service Worker` 目录删掉**再开 —— 只删 `Default/Service Worker/ScriptCache`
> 是不够的：留下的 `Default/Service Worker/Database` 存着指向已删脚本的注册库，会让扩展后台
> 起不来（面板还在，但页面 `sendMessage` 一直回
> `Could not establish connection. Receiving end does not exist.`，点清空没反应、评论一条不落库）。
> 由 DSH 插件 `dsh-douyin-comments` 启动的浏览器不用手动做——它发现扩展变了会自己清这两个位置。

---

## 3. 打包形态

| 形态 | 做法 | 适合 |
|---|---|---|
| ① 源码目录 | 开发者模式 → 加载已解压 → 选 `douyin-collector/` | 自用 / 改代码 |
| ② ZIP | 将扩展目录内文件压成 zip（`manifest.json` 在 zip 根，勿多套一层） | 发给别人 |
| ③ CRX + 更新 XML | `chrome.exe --pack-extension=<目录> --pack-extension-key=<key.pem>` | 自动更新（**不推荐**，需商店或企业策略） |

### 固定扩展 ID

未签名时 ID 由**目录路径**推导，换路径会换 ID，旧 `chrome.storage` 数据会「跟丢」。

在 `manifest.json` 顶层加入 `"key"`（base64 的 2048-bit RSA SPKI 公钥）可固定 ID：

1. `openssl genrsa -out dts.pem 2048`
2. `openssl rsa -in dts.pem -pubout -outform DER -out dts.spki`
3. base64 后填入 `"key"`
4. 用 `--pack-extension-key=dts.pem` 打包  

**私钥务必备份**；丢失后无法用同一 ID 发更新。

---

## 4. 权限与数据规模

- 权限：`storage` · `unlimitedStorage` · `downloads` · `scripting`（**不再使用 `alarms`**）
- Host：`*://*.douyin.com/*` · `*://*.iesdouyin.com/*`
- 裁剪后字段约 1.3 KB/条；数千条评论约数 MB～十余 MB（`unlimitedStorage` 不受默认 10 MB 限制）

---

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| 面板不出现 | 确认抖音页 + 扩展加载成功；看 `chrome://extensions` 错误 |
| 无法加载：`Filenames starting with "_" are reserved` | 扩展目录里混入了 `_xxx` 文件（或调试脚本）。Chrome **禁止** `_` 前缀文件名。把这些文件移出 `douyin-collector/`（例如放到上级 `extension-extra/`），再点「加载已解压」 |
| `Extension context invalidated` | 在扩展页点过「重新加载」后，旧 content script 仍挂在抖音页上。**F5 刷新该页**再采集 |
| `onAlarm` TypeError / SW registration failed | 扩展已去掉 chrome.alarms；请在扩展页点「重新加载」强制载入新 background.js |
| CORS blocked `127.0.0.1` | 重启 douyin-mcp（新版才有 CORS）→ 扩展重新加载 → 打开本目录 `index.html` 探测 /health |
| 采集秒停 / 0 条 | 刷新页面，让评论区发出请求后再点开始 |
| 面板说「已清空」但一条不落库 / 工具报「落库失败（扩展后台不可达）」 | 扩展后台（Service Worker）没起来，常见于只清了 `ScriptCache`、留下 `Default/Service Worker/Database`：关掉浏览器，删掉 `Default/Code Cache` 与**整个** `Default/Service Worker` 目录再开。DSH 插件 0.5.5 起会自动清并做「后台可达性」预检 |
| 停在少量条数 | 登录态被作废：重新登录抖音并刷新 |
| 条数远小于页面「X.X万」 | 正常：`total` 含回复/已删除计数，列表接口可翻页集合更小 |
| 导出无反应 | 查 `chrome://downloads` 与 Service Worker 控制台 |
| 数据找不到 | 换路径导致扩展 ID 变化：旧数据在旧 ID 的 storage 里 |
| AI 报 `HUB_TIMEOUT` | Hub 是否在跑；`dts_ai_bridge.port` 是否与 `douyin-mcp` 一致 |

---

## 6. 风险与边界

- 依赖**你本人已登录**的会话；不破解签名、不伪造身份  
- 有触发风控的可能；检测到登录态降级会暂停并提示重登  
- 导出含昵称与 uid 等公开评论信息：勿公开分发原始数据集  
- **账号与合规风险由使用者自行承担**

完整设计约束见仓库根 `README.md` 与 `PROTOCOL.md`。
