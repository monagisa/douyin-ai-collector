# douyin-collector MCP

让 AI（MiMo Desktop / Claude / 任意 MCP 客户端）调用「抖音评论采集器」扩展，**不必会 Playwright、不必手点面板**。

| 项 | 说明 |
|---|---|
| 角色 | **控制面**：状态 / 开采 / 读评论 / 导出 |
| 不改 | 扩展的签名语义、限速、落库逻辑 |
| 传输 | AI ↔ 本进程：**stdio**（JSON-RPC）；扩展 ↔ Hub：**HTTP 127.0.0.1** |
| 依赖 | Node ≥ 18，**无 npm 包** |

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
| `ai_status` | 存储摘要 + 最近页面快照 + 抖音 tab + Hub 状态 |
| `ai_list_videos` | 已采集视频列表 |
| `ai_start_collect` | 当前页开始采集（需已打开具体视频） |
| `ai_pause_collect` | 暂停 |
| `ai_live_status` | 当前页采集器只读快照 |
| `ai_get_comments` | `mode=summary`（默认）或 `mode=page` |
| `ai_export` | 导出 CSV/JSON，返回 filename / path / bytes |
| `ai_clear_storage` | 清空（`videoId` 可选；不传清全部，危险） |

### 推荐调用顺序

1. `ai_status` — Hub 是否连上、有无抖音 tab  
2. 无 tab → 提示打开并登录抖音页  
3. `ai_start_collect` → 看 `phase` / `hint`  
4. 轮询 `ai_live_status` 直到 `done` / `paused` / `error`  
5. `ai_get_comments`（summary）分析，需要文件再 `ai_export`

### 常见 hint

| 信号 | 含义 |
|---|---|
| `NO_DOUYIN_TAB` | 浏览器里没有打开的抖音页 |
| content 未就绪 | 刷新该抖音标签页（扩展重载后必刷） |
| 网格页 waiting-sign | 先点开一条作品变成浮层 |
| `EMPTY_POOL` | 该 videoId 本地还没有数据 |
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
├─ config.example.json
├─ douyin-mcp.cmd
├─ package.json
└─ README.md
```
