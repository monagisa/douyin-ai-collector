# 安装 · 使用 · 打包

> 抖音评论采集器 **v0.2.5** — 无 npm 依赖、无构建步骤。  
> **适用浏览器：Chrome 111+ / Edge（Chromium）**；**不支持** Firefox / Safari（详见 README「适用范围」）。  
> v0.2.x：AI Bridge（本地 MCP，见 `../douyin-mcp/README.md`）；采集核心仍为「复用页面签名、只改 cursor」。  
> 历史要点：v0.1.5 起采二级回复；v0.1.11 起面板绝对坐标拖动 + 开始采集时自动打开评论区；  
> v0.1.12 起按 DOM 判页面形态（关注/朋友/我的可用）；v0.1.13 起换视频/清空后自动重取签名、  
> `hook.js` 由 manifest 在主世界 `document_start` 注入；v0.1.15 起面板固定紧凑档（宽约 236px）；  
> v0.2.2 起并发路数可由 `chrome.storage.local.dts_settings = {lanes}` 设置（1~8，默认 4，见 PROTOCOL §3.9）；  
> v0.2.3 起二级回复的四档限速也能从 `dts_settings` 覆盖（`replyLanes` / `replyGapMs` / `replyWarmupMs` / `replyThrottleMaxWaitMs`，默认值不变，见 PROTOCOL §3.9）；  
> v0.2.4 起面板自带「设置」按钮（改 目标条数/并发路数/回复并发/回复间隔/限流等待），存 `dts_user_settings`，**优先级：面板 > `dts_settings` > 内置默认**；  
> v0.2.5 起入口改为**标题栏齿轮 ⚙**（在「—」左边，不占按钮行），浮层第一项标签就是 `max` 目标条数，当前生效值显示在浮层顶部。

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
| `dts_settings` | v0.2.2 起：外部写进来的运行时设置（`{lanes, replyLanes, replyGapMs, replyWarmupMs, replyThrottleMaxWaitMs}`，都可选）；缺字段就用内置默认（`lanes=4`、`replyLanes=4`、`replyGapMs=600`、`replyWarmupMs=1500`、`replyThrottleMaxWaitMs=10000`） |
| `dts_user_settings` | v0.2.4 起：**面板「设置」按钮**写进去的用户设置（`{maxCount, lanes, replyLanes, replyGapMs, replyThrottleMaxWaitMs}`）；优先级高于 `dts_settings`，删掉它就回到插件/内置值（`maxCount=0` 表示不限条数） |
| `dts_settings_effective` | v0.2.3：本轮**实际**用的值 `{lanes, maxCount, replyLanes, replyGapMs, replyThrottleMaxWaitMs, from: 'panel'\|'plugin', at}`，回写给调用方核对 |

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

### ④ 清库

`dts-clear`：传 `videoId` 只清该视频，不传清空全部；角标归零。

---

## 2. 五分钟上手

```text
1. chrome://extensions → 开发者模式 → 加载已解压的扩展程序
2. 选择本目录（含 manifest.json 的那一层，不要选上级）
3. 浏览器登录抖音
4. 打开 https://www.douyin.com/video/<id>
5. 右下角出现面板；必要时按提示打开评论区
6. 点「开始采集」→ 等待完成/暂停
7. 点「导出 CSV」或「导出 JSON」
```

**改过代码后**：在 `chrome://extensions` 点扩展的 **重新加载**，再 **F5 刷新抖音页**。

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
