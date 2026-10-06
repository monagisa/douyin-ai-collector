# dsh-douyin-comments

DeepSeek Harness（Cordis）工具插件：**采集抖音视频的公开评论**，注册一个工具 `douyin_comments`。
（插件版本 0.5.5，内置扩展「抖音评论采集器」v0.2.7。）

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
   实现就是标准的 cordis `Config`（schemastery），字段都标了 `volatile`——DSH 只允许表单改 volatile 字段，
   好处正是「改完 live 生效」。工具参数仍然只覆盖当次调用，不改设置。
2. **目标条数默认 300 → 80000**：300 太小（一轮就顶到），默认值与扩展单视频评论池的防御上限
   （`extension/background.js` 的 `MAX_COMMENTS_PER_VIDEO = 80000`）对齐。
3. **总超时默认 240000 → 1800000（30 分钟）**：默认要能采到几万条。
4. **并发路数 `lanes` 可调**（1~8，默认 4 = 实测甜点）：一轮同时发几路分页请求。
   以前写死在扩展里（`content.js` 的 `MAX_LANES`），现在插件在点「开始采集」前把路数写进扩展的
   `chrome.storage.local.dts_settings`，扩展每轮都现读；返回值 `lanes` 是扩展写回的**实际**路数。
   环境变量 `DOUYIN_MAX` / `DOUYIN_LANES` / `DOUYIN_TIMEOUT_MS` 也能给出厂值兜底（设置没声明时用）。

**0.4.1 修了什么**（0.4.0 发出去踩的两个坑）：

1. **未登录不再硬采**：以前未登录也直接开始采集（登录探测只看 DOM，实测未登录时登录按钮/弹窗常常一个都探不到），
   匿名接口采到一半就被限流、数据残缺。现在以登录 cookie 为准，没登录就停下来等你扫码（默认 180s），
   等不到返回 `phase=need-login` 并把浏览器窗口留着，扫完再调一次即可。
2. **peerDependencies 不再卡死运行时**：`@deepseek-ai/dsh-tools` 从 `^0.1.5-rc.3` 改成 `>=0.1.5-rc.3`。
   旧范围遇到 0.2.x 运行时会被 DSH 判定不兼容，**静默跳过整个 bundle** → 工具永远不出现、重启无效。

特点：

- **自带 Chrome 扩展**（抖音评论采集器 v0.2.7）。第一次调用时会自动把扩展装进它启动的浏览器，
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

## 安装

方式一：目录安装（本机开发/自己用）

```powershell
dsh plugin --profile web add file:D:\dycopy\dsh-douyin-comments
```

方式二：tarball 安装（把包发给别人时用）

```powershell
# 对方收到 dsh-douyin-comments-0.5.5.tgz 后：
dsh plugin --profile web add file:C:\path\to\dsh-douyin-comments-0.5.5.tgz
```

装完必须**重启 dsh web**：模块解析表在进程启动时冻结，新插件的工具要重启后才可见。
重启后工具名是 `douyin_comments`（不带 `mcp__` 前缀，这是原生插件而不是 MCP server）。

更新插件代码后：

```powershell
Remove-Item C:\Users\mo\.dsh\profiles\web\node_modules\dsh-douyin-comments -Recurse -Force
dsh plugin --profile web add file:D:\dycopy\dsh-douyin-comments
# 再重启 dsh web
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
| `lanes` | 4 | 并发路数 1~8：一轮同时发几路分页请求（4 = 实测甜点，6 路服务端开始排队、更慢且有风控风险） |
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
  **注意**：扩展面板自己的设置（0.2.4 文字按钮 → 0.2.5 标题栏齿轮 `⚙`，存 `dts_user_settings`）
  优先级更高——面板里设过的字段会盖掉插件下发值。
- 加载不到 `@deepseek-ai/schemastery` 时（例如在一个残缺的 profile 里跑）插件照常工作，只是**没有这张表单**。

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | — | **必填**。`https://www.douyin.com/video/<id>`、带 `modal_id` 的浮层链接，或直接给 15~25 位 aweme id |
| `max` | integer | 设置里的值（出厂 80000） | 目标条数（一级评论），到量即暂停并落盘（实际条数通常略多于 max；二级回复仍会补完） |
| `lanes` | integer | 设置里的值（出厂 4） | 本次并发路数 1~8；只影响这一次调用，不改设置 |
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

实测记录（2026-10-05）：

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

发布物在 `D:\dycopy\release\dsh-douyin-comments-v0.5.5\`：

| 文件 | 说明 |
| --- | --- |
| `dsh-douyin-comments-0.5.5.tgz` | 插件本体，14 个文件（`index.js`/`collector.mjs`/`cordis.patch.yml`/`README.md`/`package.json` + `client/client.js` + `extension/` 8 个） |
| `douyin-collector-extension-v0.2.7.zip` | 单独的扩展 zip，顶层目录 `douyin-collector/`（8 个文件），供 `chrome://extensions` 手动「加载已解压的扩展程序」 |
| `使用说明.md` | 给收件人看的中文说明（安装/扫码/两处设置/参数/FAQ/macOS） |
| `SHA256SUMS.txt` | 三个文件的 SHA256 |

再外面还有 `D:\dycopy\release\dsh-douyin-comments-v0.5.5.zip`（把上面整目录打成一个单文件，方便直接发给人）。

草稿目录 `D:\dycopy\release\dsh-douyin-comments-v0.5.4\` 是上一版，保留作对照。

重新打包：

```powershell
cd D:\dycopy\dsh-douyin-comments
npm pack --pack-destination D:\dycopy\release\dsh-douyin-comments-v0.5.5

# 扩展开 zip（顶层目录名必须是 douyin-collector；只装 8 个运行文件，别把 md 打进去）。
# 用 .NET ZipFile 逐个 CreateEntry 造，避免 Compress-Archive 多套一层目录：
$rel = 'D:\dycopy\release\dsh-douyin-comments-v0.5.5'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open("$rel\douyin-collector-extension-v0.2.7.zip", 'Create')
Get-ChildItem D:\dycopy\douyin-collector -File |
  Where-Object { $_.Extension -in '.js','.json','.css','.html' } |
  ForEach-Object { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "douyin-collector/$($_.Name)") | Out-Null }
$zip.Dispose()
```

**注意**：清空发布目录时别用 `Remove-Item "$rel\*" -Recurse -Force` —— 它不进回收站，会把里面刚写好的
`使用说明.md` 一起删掉（v0.5.2 打包时踩过，靠旧的外层 zip 解出来才恢复）。要保留的文件先复制到别处。

打包验收（**全新 profile 从 tgz 装**，2026-10-05 实测通过，日志 `_accept_tgz.txt`）：

```powershell
mkdir C:\Users\mo\.dsh\profiles\pkgtest     # package.json：dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]
dsh plugin --profile pkgtest add file:D:\dycopy\release\dsh-douyin-comments-v0.5.5\dsh-douyin-comments-0.5.5.tgz
dsh --profile pkgtest --dump-config | Select-String dsh-douyin-comments
dsh --profile pkgtest headless '用 douyin_comments 工具采集 https://www.douyin.com/video/7660328050596371819 （max=20）。工具返回后只回复三行：ok=、count=、csvPath=。'
# ⇒ ok=true，CSV 落在 ~\.dsh\douyin-collector\out\（实测两轮：194 条 / 227 条——按页落库，条数每轮不同）
```

- 依赖 `playwright-core ^1.63.0`（13 MB，只有驱动、不含浏览器）由 `dsh plugin add` 自动装进 profile；
  浏览器优先用 ms-playwright 的 chromium，找不到就用系统已装的 Chrome / Edge（mac 上也找
  `~/Library/Caches/ms-playwright`；品牌版 Chrome 137+ 会打警告并建议换 Chromium）。

## 与其他组件的关系

- 浏览器里跑的扩展本体在 `D:\dycopy\douyin-collector\`（权威开发目录，v0.2.7）；插件里的 `extension/`
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
