# 抖音评论采集器

在 Chrome / Edge 中采集**抖音公开评论**（含二级回复），导出 CSV / JSON。

- **不破解签名** · **不绕过登录** · **不伪造请求**  
- 复用页面自己生成的签名请求，只改分页 `cursor` / `count`  
- 数据只落在本机 `chrome.storage.local`，可导出后自行分析  
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
- v0.2.3：二级回复的四档限速同样可被外部覆盖（`replyLanes` 并发线程数、`replyGapMs` 同线程页间隔、
  `replyWarmupMs` 进补采前的静默、`replyThrottleMaxWaitMs` 等限流窗口的墙钟上限）；
  不写就等价于老版本（4 / 600ms / 1500ms / 10s），扩展单独使用时行为不变
- v0.2.4：**面板上多了「设置」按钮**（就在「开始采集/暂停」下面一行），点开可直接改
  目标条数 / 并发路数 / 回复并发 / 回复间隔 / 限流等待，存到 `chrome.storage.local.dts_user_settings`；
  优先级 **面板设置 > `dts_settings`（外部/插件写入）> 内置默认**；目标条数到量会自动收工
- v0.2.5：**面板设置入口改成标题栏的齿轮 ⚙**（在「—」收起按钮左边，不再占一整行），
  点开浮层里第一项就是 **`max` 目标条数**（另有 并发路数 / 回复并发 / 回复间隔 / 限流等待），
  当前生效值以「当前：并发 N 路 · 目标 M 条/不限（面板）」显示在浮层顶部
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
| 面板 | 右下角可拖动采集面板：标题栏齿轮 ⚙ 可改设置（目标条数 max / 并发路数 / 回复并发 / 回复间隔 / 限流等待）；「本地已存」一行显示跨视频总数；「导出范围」两个互斥按钮（本条视频 / 全部视频）；清空分成「清空」（只清本条视频）与「全部清空」（两步确认）两个按钮 |
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

**自测**：离线 `node verify-tool.mjs` **135/135 全绿**（上一版 130/130；新增 5 条断言：`sendClear`
等后台回包、清空后读回 storage 自检、失败文案带 `edge://extensions` 重新加载 + F5 指引、
统计请求序号作废在途旧回包、失败文案必须走 `setPhase` 的 `err` 参数不被清空）。真机验收（两条路径，
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
