# douyin-collector MCP

让 AI（MiMo Desktop / Claude / 任意 MCP 客户端）调用「抖音评论采集器」扩展，**不必会 Playwright、不必手点面板**。

| 项 | 说明 |
|---|---|
| 角色 | **控制面**：状态 / 开采 / 读评论 / 导出 / **读改采集设置** |
| 不改 | 扩展的签名语义、限速、落库逻辑 |
| 传输 | AI ↔ 本进程：**stdio**（JSON-RPC）；扩展 ↔ Hub：**HTTP 127.0.0.1** |
| 依赖 | Node ≥ 18，**无 npm 包** |
| 版本 | `0.3.6`（对齐扩展 0.2.15：顶层列表 `lanes` **重新生效**——默认 3 路**错峰 200ms**，单路礼貌间隔 400→150ms） |

**0.3.6 新增**（跟 `dsh-douyin-comments` **0.5.13** / 扩展 **0.2.15** 配套）：

1. **`lanes` 从「已停用」改回「真正生效」**：`ai_set_settings` / `ai_start_collect` 的设置项说明、
   `ai_get_settings` 的回读都改成「顶层列表路数（默认 3，错峰多路：每路错开 200ms；1 = 单路）」。
   依据（2026-10-07 真机）：当时「并发会被合并」的结论只对一半——**真凶是「同一签名 + ~200ms 内同时发」**，
   同一签名同时发 4 个 cursor（0/50/100/150）Σ返回 200 条、**去重后只剩 56 条**，而每路响应的 `next`
   还是对的（静默少采）；**错峰 200ms / 500ms 都是 200/200 唯一**。
   扫完整个 21 页列表：单路 **15.79s / 唯一 907** vs 错峰 4 路 **7.72s / 唯一 912**（2.04×、数据一样多）。
2. **扩展侧兜底**：一旦发现两路返回逐条相同的页，当轮自动降回单路，并把原因写进
   `dts_settings_effective.lanesNote`（`ai_get_settings` 能看到）；所以「AI 把 `lanes` 调大」最坏情况是
   被自动降回 1 路，不会静默少采。
3. 其余工具、参数、返回值一律不变（`lanes` 的取值区间仍是 1–8）。

**0.3.5 新增**（跟 `dsh-douyin-comments` **0.5.12** / 扩展 **0.2.14** 配套）：

1. **`replyThrottleMaxWaitMs` 的口径变了**：它现在是「等窗口」的**总**预算（ms，10000~600000），
   扩展 0.2.14 不再「一波判终局」——单波最多撞 12 秒，波间停 15/30/60 秒再打一波，总等待封顶在这个值。
   内置默认 **120000**（旧版是 10000）；设 10000 = 老行为（十秒不行就收尾，再点一次「开始采集」断点续补采）。
2. **`replyGlobalGapMs = 0` 的语义与文档统一了**：0 = 用扩展内置的 250ms。扩展 ≤ 0.2.13 把 0 当「关闸门」，
   而设置页/MCP/PROTOCOL 一直写「0 = 用内置」——`ai_set_settings {replyGlobalGapMs: 0}` 因此会**静默关掉限速**，
   0.2.14 修掉了这个矛盾。
3. **收尾文案如实报「本轮共等 N 秒、分 M 波重试」**，并说明服务端回的是 `HTTP 200 + 0 字节 body`
   （不是本地请求没回来）；补采结束即置 `done`（旧版停在 `replies`，采集器还要空等到「无进展」才收工）。
4. 其余工具、参数、返回值一律不变。

**0.3.4 新增**（跟 `dsh-douyin-comments` **0.5.11** / 扩展 **0.2.13** 配套）：

1. **`max` / `maxCount` 的说明改为新语义**：到量**只停止顶层扫描**，已采到线程的二级回复**仍会补完**；
   判定用**一级去重计数**（扩展新上报的 `topSeen`）。（扩展 ≤ 0.2.12 不接受 `maxCount`，
   插件会自检并退回旧行为——但在 MCP 这条路上，`max` 一直只是设置项，最终仍由插件决定。）
2. **新增设置项 `replyGlobalGapMs`**：回复请求**跨线程的全局最小间隔** ms（0–2000，**0 = 用扩展内置的 250ms**）。
   旧版回复阶段没有全局限速（`replyLanes` 条线程取到就发、单页线程零间隔，总速率 ≈20 次/秒），
   同一条视频两轮能差到「0/46 线程」与「~139 条二级回复」；现在所有回复请求都过全局闸门，
   撞限流还会翻倍（封顶 1000ms）并**降 1 路**。
3. **`replyGapMs` 的说明不再暗示「想限速就调 `replyLanes`」**：它只对**同一条评论翻页**生效，
   要限速请用 `replyGlobalGapMs`（或降 `replyLanes`）。
4. 其余工具、参数、返回值一律不变；`ai_export` 的 `all: true` 仍然**需要扩展 ≥ 0.2.11**。

**0.3.3 新增**：

1. `ai_set_settings` / `ai_start_collect` 的设置项里，`lanes` 的说明改成**已停用**（**这条在 0.3.6 又被改回「生效」**）：
   扩展 **0.2.12** 起顶层评论列表**固定单路**——多路并发会被服务端合并成同一页（同一个签名、同一时刻发 `cursor` /
   `+50` / `+100` / `+150` 时，其中三路拿到的是**同一页**；4 路 5 轮只拿到 **492 条**一级评论，且
   **0 个失败请求**，是静默少给）。同一视频实测：4 路 **768 条**（一级 586 / 二级 182）→ 单路
   **945 条**（一级 753 / 二级 192），即 **4 路少采约 30%**。`lanes` 仍可读写、仍会下发给扩展，
   但**不再影响采集**（仅保留兼容；扩展回写的 `dts_settings_effective.lanes` 恒为 1，
   `lanesWanted` 是你传的值）。
2. 其余工具、参数、返回值一律不变；`ai_export` 的 `all: true` 仍然**需要扩展 ≥ 0.2.11**。

**0.3.2 新增**：

1. `ai_export` 支持 `all: true`：不传 `videoId` 也能导出**本地全部视频**，合成一份（`scope: "all"`，
   CSV 末尾追加 `video_id` 列，回包带 `videoCount`）。需要扩展 **≥ 0.2.11**；旧扩展会回
   `MISSING_VIDEO_ID`，本版会给这个回包补一句「扩展太旧（< 0.2.11）」的 `hint`，不让人误以为是参数写错。
2. 单视频导出行为不变（`scope: "video"`）；本地没有数据时统一回 `EMPTY_POOL`，
   **不再生成只有表头的空文件**（扩展 0.2.11 起面板「导出」也是这个口径）。
3. 工具说明写进 2026-10-06 的实测口径：二级回复每路约 4 次/秒（≈1/RTT），总速率 ≈ `replyLanes × 4` 次/秒；
   4 路≈16 次/秒会撞限流（回复接口回 0 字节 → `EMPTY_BODY`，惩罚态可持续数分钟），**建议 `replyLanes` 取 1~2**；
   `replyGapMs` 只对「同一条评论翻页」生效，不能当限速用。

**0.3.1 修复**：

1. `host` 支持 IPv6：扩展填 `::1` 时拼成 `http://[::1]:18765`（以前拼成 `http://::1:18765`，
   每个请求都 500 → 永远 `NO_HUB`）。
2. HTTP 头块被 TCP 切开时，不再把头行当 NDJSON 解析吃掉（丢帧）。
3. 无 `id` 的请求（`initialize` / `tools/list` / `ping` / `hub/health`）不再回一个没有 `id` 的对象。
4. 清掉写死的 `D:\node-v22.23.1\node.exe`：`douyin-mcp.cmd`、`restart-hub.ps1` 改用
   `%DTS_NODE_EXE%` 或 PATH 兜底；`force-reload-checklist.ps1` 不再写死「扩展应当是 v0.2.1」。
5. 配套插件脚本：`sync-extension.mjs` 同步后反向清理白名单外的旧文件，`verify-tool.mjs` 增加
   「插件自带 `extension/` 没有多余文件」硬校验；本目录三个冒烟（`test-hub.js` /
   `test-mcp-handshake.js` / `test-settings.js`）全过。

> 采集协议见 `../douyin-collector/PROTOCOL.md` §7（AI Bridge）。  
> 前提：**Chrome / Edge（Chromium）** 已装扩展、**已登录抖音**、已打开具体视频页。  
> **不支持** Firefox / Safari（扩展本体未适配，见扩展 README「适用范围」）。

---

## 架构

```text
AI / MCP 客户端
      │  stdio（Content-Length / NDJSON）
      ▼
node douyin-mcp/mcp.js
      │  enqueue / await result
      ▼
HTTP Hub  127.0.0.1:18765/api/v1
      ▲  GET /pending    POST /result
      │
Chrome 扩展 background.js（约 800ms 出站轮询）
      ├─ 存储类：list_videos / get_comments / export / clear
      └─ 页面类：tabs.sendMessage → content.js（start / pause / status）
```

MV3 Service Worker **不能 listen 端口**，所以扩展主动拉命令；Hub 只绑本机。

---

## 使用者准备清单

1. 安装扩展（**仅 Chrome/Edge**；见 `../douyin-collector/README.md`）  
2. 在该浏览器 **登录抖音**  
3. 打开视频页（或已能识别视频的 feed/浮层）  
4. 本机运行 `node mcp.js`（或由 MCP 客户端自动拉起）  
5. 在 MCP 客户端注册本进程  

---

## 启动

```bat
cd douyin-mcp
node mcp.js
```

- 日志在 **stderr**；stdout 留给 MCP  
- Hub：`http://127.0.0.1:18765/api/v1`（仅 `127.0.0.1`；扩展的 `host` 填 IPv6 `::1` 也可，拼出来是 `http://[::1]:18765`）  
- Windows 可用：`douyin-mcp.cmd`

只开 Hub 调试：

```bat
node mcp.js --hub-only
```

冒烟（无需 Chrome）：

```bat
node test-hub.js
node test-mcp-handshake.js
node test-settings.js
```

---

## 注册 MCP

**MiMo Desktop**：设置 → MCP → 添加 **Stdio（本地）**

| 字段 | 值 |
|---|---|
| 名称 | `douyin-mcp` |
| 命令 | `node` + 本目录下 `mcp.js` 的**绝对路径**（Windows 建议写全 `node.exe` 路径） |
| 额外参数 | 空 |
| 环境变量 | 空 |

配置文件片段（`~/.config/mimocode/mimocode.jsonc` 等）：

```json
{
  "type": "local",
  "command": ["node", "/绝对路径/douyin-mcp/mcp.js"],
  "enabled": true
}
```

> MCP 变更 **不会热加载**到当前会话，请**新开对话**。  
> 若 `initialize` 超时：确认没有旧实例占着端口、命令里是绝对路径、扩展已重新加载。

改端口：复制 `config.example.json` → `config.json`，并同步扩展：

```js
chrome.storage.local.set({ dts_ai_bridge: { host: '127.0.0.1', port: 18765, enabled: true } })
```

**两侧端口必须一致。**

---

## Tools

| tool | 作用 |
|---|---|
| `ai_status` | 存储摘要 + 最近页面快照 + 抖音 tab + Hub 状态 + **当前采集设置** |
| `ai_list_videos` | 已采集视频列表 |
| `ai_start_collect` | 当前页开始采集（需已打开具体视频）；可**带设置参数**，先下发再启动 |
| `ai_pause_collect` | 暂停 |
| `ai_live_status` | 当前页采集器只读快照 |
| `ai_get_settings` | 读设置快照：`external`（AI 下发）/ `user`（面板齿轮）/ `effective`（上次实际生效）/ `precedence` / `limits` |
| `ai_set_settings` | 写/清设置：`scope=external`（默认，`dts_settings`）或 `panel`（`dts_user_settings`）；`clear=external\|user\|all` 恢复默认 |
| `ai_get_comments` | `mode=summary`（默认）或 `mode=page` |
| `ai_export` | 导出 CSV/JSON：默认导一个 `videoId`；`all: true` 导出本地全部视频合集（CSV 带 `video_id` 列）。返回 filename / path / bytes / count / videoCount |
| `ai_clear_storage` | 清空（`videoId` 可选；不传清全部，危险） |

### 采集设置（AI 可调）

七个参数（`ai_start_collect` 与 `ai_set_settings` 通用，都可选）:

| 参数 | 含义 | 范围 | 面板齿轮上的名字 |
|---|---|---|---|
| `max` | 目标条数上限（**AI 别名**；按去重后的**一级**计数，到量**只停顶层扫描**、二级回复仍补完——需要扩展 ≥ 0.2.13） | 0–1000000 | 目标条数 max |
| `maxCount` | 同上（原生字段名；与 `max` 同时给时 `max` 优先） | 0–1000000 | 目标条数 max |
| `lanes` | **顶层列表路数**（扩展 0.2.15 起生效）：默认 **3** 路、每路**错开 200ms**；`1` = 单路串行。扩展发现两路拿到同一页会当轮降回 1（`dts_settings_effective.lanesNote`）。旧版 0.2.12~0.2.14 曾停用、固定单路 | 1–8 | 顶层列表路数 |
| `replyLanes` | 二级回复并发；**撞限流时扩展会自动降 1 路**（下限 1），限流过去、下一轮补采才恢复 | 1–8 | 回复并发 |
| `replyGlobalGapMs` | 回复请求**跨线程的全局最小间隔**（**0 = 用扩展内置的 250ms** ≈ ≤4 次/秒；撞限流时在此基础上翻倍，封顶 1000ms） | 0–2000 | 回复全局限速 ms |
| `replyGapMs` | 回复**同一条评论翻页**的间隔（不是全局限速；要限速用 `replyGlobalGapMs`） | 0–60000 | 回复间隔 ms |
| `replyWarmupMs` | 回复阶段暖场等待 | 0–600000 | — |
| `replyThrottleMaxWaitMs` | 被拒时「等窗口」的**总**预算（扩展 0.2.14 起分波重试：单波 ≤12 秒、波间停 15/30/60 秒；设 10000 = 旧行为） | 10000–600000 | 限流总等待 ms |

三层优先级（扩展每次「开始采集」时重读）：

```text
内置常量  <  dts_settings（AI 经 MCP 下发）  <  dts_user_settings（面板齿轮里保存的值）
```

> 也就是说：**人在面板里点过「保存」的项，AI 覆盖不了**——这是故意设计的（用户的手动设置优先）。AI 想强行改，用 `ai_set_settings` 带 `scope: "panel"`，或者先 `clear: "user"` 再下发。

例子：

```jsonc
// 只本次采集生效（写 dts_settings 后启动）
{ "name": "ai_start_collect", "arguments": { "max": 500, "lanes": 6, "replyLanes": 4 } }

// 改「插件下发」这一层的默认值
{ "name": "ai_set_settings", "arguments": { "max": 80000, "lanes": 4, "replyGapMs": 600 } }

// 想连面板里的值一起改（有"人"的语义，慎用）
{ "name": "ai_set_settings", "arguments": { "scope": "panel", "lanes": 2 } }

// 读回来核对
{ "name": "ai_get_settings", "arguments": {} }

// 全部恢复默认
{ "name": "ai_set_settings", "arguments": { "clear": "all" } }
```

写进去的值都会**钳位**到上表范围；未知键和非法值在回包 `unknown` 里列出来，不会报错中断。`ai_set_settings` 既没给设置也没给 `clear` 时返回 `NO_SETTINGS`，**不会**发桥命令。

### 并发与限流（2026-10-06 / 2026-10-07 实测）

顶层列表（2026-10-07 真机，视频 `7692405235813272867`）：

- `lanes`（顶层列表）**0.2.15 起重新生效**：默认 3 路、每路**错开 200ms**。当时「并发会被服务端合并成同一页」
  只对一半——**同时发**（同一签名、~200ms 窗口内）才会被合并：4 个 cursor 同时发 Σ返回 200 条、
  **去重后只剩 56 条**（每路 `next` 还是对的，静默少采）；**错峰 200ms / 500ms 都是 200/200 唯一**。
- 收益：扫完 21 页列表，单路（每页后停 400ms）**15.79s / 唯一 907** vs 错峰 4 路 **7.72s / 唯一 912**；
  端到端（扩展 0.2.15）单路 **919 条 / 36.8s**、错峰 3 路 **919 条 / 29.5s** ⇒ **数据一分不少、更快**。
- 扩展自带兜底：发现两路返回逐条相同的页就**当轮降回单路**，原因写进 `dts_settings_effective.lanesNote`。
  历史结论（0.2.12~0.2.14 固定单路、4 路 768 条 vs 单路 945 条）是**矫枉过正**，保留在下方旧记录里。

二级回复（2026-10-06 受控实测：先暂停扩展，再在页面内自控并发打回复接口；20s 窗口，中位 RTT≈245ms）：

| 二级回复并发 | 请求数（20s） | 总速率 | 每路速率 |
|---|---|---|---|
| 2 | 157 | 7.8 次/秒 | 3.9 次/秒 |
| 4 | 325 | 16.1 次/秒 | 4.0 次/秒 |
| 4（复跑） | 322 | 15.9 次/秒 | 4.0 次/秒 |

- 总速率 ≈ `replyLanes × 4` 次/秒 —— **4 路是 2 路的两倍**（不是一致）。**上表是扩展 0.2.12 及更早**的行为：
  那时回复阶段没有全局限速。**0.2.13 起**所有回复请求都要过跨线程全局闸门（默认 `replyGlobalGapMs = 250ms`，
  即 ≈ ≤4 次/秒，无论 `replyLanes` 多大），撞限流还会翻倍（封顶 1000ms）并**自动降 1 路**；
  要调速率用 `replyGlobalGapMs`，`replyLanes` 只决定还能不能并发。
- ~~`lanes`（顶层并发）自扩展 0.2.12 起已停用~~ → **0.2.15 起重新生效**（默认 3 路错峰 200ms）。
  这条只作用于列表扫描——历史实测 `lanes=2 + replyLanes=4` 时回复请求仍是峰值 4 路、11 次/秒。
  0.2.12~0.2.14 期间「固定单路」的旧结论见上方「0.3.6 新增」与历史记录。
- 被限流的形态是回复接口回 **0 字节**（扩展报 `EMPTY_BODY`），同一时刻列表接口仍正常。
- 连跑两组 4 路（约 650 次请求）后端点进入惩罚态，**160 秒以上**不恢复；撞上后别立刻重跑，
  已采数据不会丢，等几分钟再 `ai_start_collect` 会续采。
- `replyGapMs`（默认 600）只在**同一条评论翻页**时 sleep；单页评论之间的节流由 `replyGlobalGapMs`（0.2.13 起）负责。
- 被拒（`EMPTY_BODY`）**不等于「永久限流」**：2026-10-07 真机 A/B/C/D/x1 五轮显示，同一会话里连撞 108 秒~8.5 分钟都不放行、
  而新会话或十几秒后的窗口就 23/23、28/28 全成 ⇒ **0.2.14 起扩展自己在总预算内分波停顿重试**（单波 12 秒、波间停 15/30/60 秒，
  内置总窗口 120000 ms），不用再靠手动点第二次；收尾文案会报「本轮共等 N 秒、分 M 波」，并说明服务端回的是 HTTP 200 + 0 字节 body。

### 推荐调用顺序

1. `ai_status` — Hub 是否连上、有无抖音 tab、现在是什么设置  
2. 无 tab → 提示打开并登录抖音页  
3. 想调参就先 `ai_set_settings`，或直接在 `ai_start_collect` 里带上  
4. `ai_start_collect` → 看 `phase` / `hint` / `appliedSettings`  
5. 轮询 `ai_live_status` 直到 `done` / `paused` / `error`  
6. `ai_get_comments`（summary）分析，需要文件再 `ai_export`

### 常见 hint

| 信号 | 含义 |
|---|---|
| `NO_DOUYIN_TAB` | 浏览器里没有打开的抖音页 |
| content 未就绪 | 刷新该抖音标签页（扩展重载后必刷） |
| 网格页 waiting-sign | 先点开一条作品变成浮层 |
| `EMPTY_POOL` | 本地没有可导出的数据（该 videoId 是空的；`all: true` 时表示本地一个视频都没采过） |
| `NO_SETTINGS` | `ai_set_settings` 没给设置也没给 `clear` |
| `HUB_TIMEOUT` | 端口不一致 / 扩展禁用 / SW 未轮询 |

---

## 安全

- Hub **仅** `127.0.0.1`，不要改成 `0.0.0.0`  
- 命令通道不经公网；扩展只出站访问本机 Hub  
- **CORS**：Hub 对 `chrome-extension://` 回 `Access-Control-Allow-Origin`；扩展 manifest 亦声明 `http://127.0.0.1/*` host permission（双保险，否则 Chrome 会拦 `fetch`）  
- 采集仍遵守扩展原则：不逆向签名、不绕登录、不伪造身份  
- `ai_clear_storage` 无 `videoId` 会清空全部本地池  

---

## 常见问题补充

| 现象 | 处理 |
|---|---|
| `CORS policy: No Access-Control-Allow-Origin` | 重启 `douyin-mcp`（旧 Hub 无 CORS 头）；扩展点「重新加载」；确认 manifest 含 `127.0.0.1` host 权限 |
| `onAlarm` TypeError / SW registration failed | 扩展需含 `"alarms"` 权限；改完后在扩展页点「重新加载」并刷新抖音页 |

---

## 仓库建议布局（GitHub）

```text
repo/
├─ README.md                 ← 可指向扩展说明
├─ douyin-collector/         ← 扩展本体
└─ douyin-mcp/               ← 本目录
```

上传前删除本机敏感内容：浏览器 profile、`cookies.json`、私钥、真实评论导出、本机绝对路径配置（`config.json`）。

---

## 文件

```text
douyin-mcp/
├─ mcp.js                   Hub + MCP stdIO
├─ test-hub.js              Hub 队列冒烟
├─ test-mcp-handshake.js    initialize / tools/list 冒烟
├─ test-settings.js         设置链路冒烟（ai_get_settings / ai_set_settings / 参数钳位与 max 别名）
├─ config.example.json
├─ douyin-mcp.cmd
├─ package.json
└─ README.md
```
