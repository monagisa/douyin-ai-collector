# douyin-collector MCP

让 AI（MiMo Desktop / Claude / 任意 MCP 客户端）调用「抖音评论采集器」扩展，**不必会 Playwright、不必手点面板**。

| 项 | 说明 |
|---|---|
| 角色 | **控制面**：状态 / 开采 / 读评论 / 导出 / **读改采集设置** |
| 不改 | 扩展的签名语义、限速、落库逻辑 |
| 传输 | AI ↔ 本进程：**stdio**（JSON-RPC）；扩展 ↔ Hub：**HTTP 127.0.0.1** |
| 依赖 | Node ≥ 18，**无 npm 包** |
| 版本 | `0.3.0`（新增 `ai_get_settings` / `ai_set_settings`，`ai_start_collect` 可带设置） |

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
- Hub：`http://127.0.0.1:18765/api/v1`（仅 `127.0.0.1`）  
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
| `ai_export` | 导出 CSV/JSON，返回 filename / path / bytes |
| `ai_clear_storage` | 清空（`videoId` 可选；不传清全部，危险） |

### 采集设置（AI 可调）

七个参数（`ai_start_collect` 与 `ai_set_settings` 通用，都可选）:

| 参数 | 含义 | 范围 | 面板齿轮上的名字 |
|---|---|---|---|
| `max` | 目标条数上限（**AI 别名**） | 0–1000000 | 目标条数 max |
| `maxCount` | 同上（原生字段名；与 `max` 同时给时 `max` 优先） | 0–1000000 | 目标条数 max |
| `lanes` | 并发路数 | 1–8 | 并发路数 |
| `replyLanes` | 二级回复并发 | 1–8 | 回复并发 |
| `replyGapMs` | 回复请求间隔 | 0–60000 | 回复间隔 ms |
| `replyWarmupMs` | 回复阶段暖场等待 | 0–600000 | — |
| `replyThrottleMaxWaitMs` | 限流退避最长等待 | 10000–600000 | 限流等待 s |

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
| `EMPTY_POOL` | 该 videoId 本地还没有数据 |
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
