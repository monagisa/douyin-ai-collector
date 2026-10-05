// 抖音评论采集核心（DSH 插件专用「司机」）
//
// 分工：
//   · Chrome 扩展（douyin-collector）= 唯一能拿到 a_bogus 签名的东西（hook.js 必须在页面
//     主世界里抢 window.fetch），它负责「拿签名 → 重放分页 → 按 cid 落库」。
//   · 本文件 = 司机：自动把扩展装进浏览器 → 灌 cookies（可选）→ 打开视频页 → 点面板
//     「开始采集」→ 盯着签名/条数 → 到量点「暂停」→ 从 chrome.storage.local 取结构化数据
//     → 写 CSV/JSON。
//
// 两条硬要求（都是踩过坑之后加的）：
//   1) **自动装扩展**：插件自带扩展副本，运行时同步到 ~/.dsh/douyin-collector/extension，
//      再用 --load-extension 把它装进本次启动的浏览器。使用者不需要手动去 chrome://extensions
//      加载，AI 第一次调用就装好了。
//   2) **只交付本次新采的数据**：开始前快照 + 清空，结束时把「开始前就存在」的 cid 全部剔掉；
//      一条新数据都没有 ⇒ 返回失败并说明原因，绝不给上一轮的残留。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url));

// ---------- 可配置项（都有默认值，env / 插件 config 可覆盖） ----------

export const DEFAULTS = {
  /** 显式指定扩展目录（留空 = 自动：插件自带副本 → 已安装副本 → 开发目录） */
  extDir: process.env.DOUYIN_EXT_DIR || '',
  /** cookies.json（可选；留空则试 ~/.dsh/douyin-collector/cookies.json） */
  cookies: process.env.DOUYIN_COOKIES || '',
  profile: process.env.DOUYIN_PROFILE
    || path.join(os.homedir(), '.dsh', 'douyin-collector', 'chrome-profile'),
  chrome: process.env.DOUYIN_CHROME || '',
  port: Number(process.env.DOUYIN_CDP_PORT || 9510),
  outDir: process.env.DOUYIN_OUT_DIR || path.join(os.homedir(), '.dsh', 'douyin-collector', 'out'),
  /** 插件工作目录（扩展安装位置、默认 cookies、默认输出都在这下面） */
  home: process.env.DOUYIN_HOME || path.join(os.homedir(), '.dsh', 'douyin-collector'),
  /**
   * 检测到未登录时，默认等使用者扫码的秒数（工具参数 waitLoginSec 优先；显式传 0 = 不等）。
   * 以前默认 0：没登录也照采，被限流后数据是残的 —— 默认值必须等得住人。
   */
  waitLoginSec: Number(process.env.DOUYIN_WAIT_LOGIN_SEC ?? 180),
  /**
   * 明知未登录也照采（默认关）。开了就退回「裸采」：抖音对匿名评论接口限流很凶，
   * 采到的可能是残的，只有明确知道自己在干什么时才打开。
   */
  allowAnonymous: process.env.DOUYIN_ALLOW_ANONYMOUS === '1',
  /**
   * 目标条数上限（工具参数 max 优先）。默认 8 万 = 扩展单视频评论池的防御上限
   * （douyin-collector/background.js:22 MAX_COMMENTS_PER_VIDEO = 80000），到量即暂停落盘。
   */
  max: Number(process.env.DOUYIN_MAX || 0) || 80000,
  /**
   * 并发路数：一轮同时发几路分页重放请求（每路一个 cursor）。4 = 实测甜点
   * （1 路 698ms / 2 路 561ms / 4 路 366ms / 6 路 515ms：6 路服务端开始排队，更慢且有风控风险）。
   * 运行时写进扩展的 chrome.storage.local.dts_settings，扩展侧还会再钳到 1..8。
   */
  lanes: Number(process.env.DOUYIN_LANES || 0) || 4,
  /**
   * 单次采集总超时（工具参数 timeoutMs 优先）。默认 30 分钟：max 默认 8 万，
   * 原先的 4 分钟根本采不到，会让人误以为已经「采到底」。
   */
  timeoutMs: Number(process.env.DOUYIN_TIMEOUT_MS || 0) || 1800000,
  /**
   * 采集前是否清空扩展里已有的数据（默认**不清空**）。
   * 以前默认清空，会把扩展的「断点续采」进度一起抹掉（清空会重置去重表和 cursor）：
   * 二级回复采到一半失败后再跑一轮，前面的进度全白费 —— 这正是用户报告里回复采不到的成因之一。
   * 不清空时靠结束时按 cid 差集剔除旧数据，交付的仍然只有本轮新采的。
   */
  clearBefore: process.env.DOUYIN_CLEAR_BEFORE === '1',
  /**
   * 二级回复阶段的并发线程数（写进扩展 dts_settings）。0 = 不指定，用扩展内置的 4。
   * 回复接口比列表接口更容易被限流（实测 4 路 × 600ms 就会撞窗口），所以单独留一个档位。
   */
  replyLanes: Number(process.env.DOUYIN_REPLY_LANES || 0) || 0,
  /**
   * 二级回复「等限流窗口」的墙钟预算（秒，写进扩展 dts_settings）。0 = 扩展内置的 10 秒。
   * 10 秒是原作者按「十秒不行就停」定的；报告实测限流窗口往往几秒才开、10 秒经常整轮白跑，
   * 所以这里可以放宽（比如 60）后用「再点一次开始采集」断点续采，而不是一次撞死。
   */
  replyThrottleSec: Number(process.env.DOUYIN_REPLY_THROTTLE_SEC || 0) || 0,
  /**
   * 二级回复阶段「多久没有新数据就收工」的秒数（默认 15 分钟）。
   * 原来只有 120 秒：回复被限流、退避重试的过程中条数自然会长时间不动，
   * 结果刚进回复阶段就被判定「没有新评论」直接收工 —— 回复永远是 0 条。
   */
  replyNoProgressSec: Number(process.env.DOUYIN_REPLY_NOPROGRESS_SEC || 0) || 900,
};

/**
 * 抖音登录态 cookie：任意一个非空值就说明这个 profile 已经登录过（实测 2026-10-05：
 * 日常已登录 profile 有 sessionid / sessionid_ss / sid_tt / sid_guard / uid_tt / login_time，
 * 全新未登录 profile 只有 passport_csrf_token、odin_tt、ttwid、passport_auth_mix_state）。
 */
export const SESSION_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt'];

/**
 * 登录闸门：**没登录就不开始采集**。
 * 判据是 cookie，不是 DOM —— 实测未登录时抖音页面上经常连登录按钮/弹窗都探不到
 * （`[data-e2e="login-button"]`、`.trust-login-dialog-mask` 全空），只看 DOM 会漏判，
 * 然后就开始裸采、被限流、拿到残缺数据。
 * @param {{cookies?: Array<{name?: string, value?: string}>, loginButton?: boolean, mask?: boolean}} [signals]
 * @returns {{hasSession: boolean, needLogin: boolean, dialog: boolean}}
 */
export function loginGate({ cookies = [], loginButton = false, mask = false } = {}) {
  const hasSession = (Array.isArray(cookies) ? cookies : [])
    .some((c) => c && SESSION_COOKIE_NAMES.includes(c.name) && String(c.value || '') !== '');
  const dialog = loginButton === true || mask === true;
  return { hasSession, dialog, needLogin: !hasSession };
}

/** playwright-core 可能在插件自己的 node_modules、也可能在全局；找不到就报清楚的错 */
function loadChromium() {
  const names = ['playwright-core', 'playwright'];
  const home = os.homedir();
  const execDir = path.dirname(process.execPath);
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
  const tried = [];

  // 0) 显式指定优先（可以是模块目录，也可以是含有它的 node_modules 根）
  const explicit = process.env.DOUYIN_PLAYWRIGHT;
  if (explicit) {
    try { return require(explicit).chromium; } catch (e) { tried.push(explicit); }
  }
  // 1) 宿主/插件自己的解析（插件 node_modules、profile node_modules 的逐级向上查找）
  for (const n of names) {
    try { return require(n).chromium; } catch (e) { tried.push(n); }
  }
  // 2) 全局安装位置。这一堆候选都是「node_modules 的父目录」，最后用 require.resolve(name, {paths}) 让 Node 自己走。
  const roots = [
    path.join(execDir, 'node_modules'),                       // 便携版 node：<node>/node_modules
    path.join(execDir, 'node_global', 'node_modules'),        // 便携版 node + npm prefix=<node>/node_global（本机就是这种）
    path.join(execDir, '..', 'lib', 'node_modules'),          // npm 默认 prefix：/usr/local/lib、/opt/homebrew/lib
    path.join(execDir, '..', 'node_modules'),
    path.join(appData, 'npm', 'node_modules'),                // Windows：npm i -g
    path.join(home, '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    '/usr/lib/node_modules',
    path.join(dshHome, 'profiles', 'node_modules'),           // 装在 DSH profile 里
  ];
  try { // nvm 每个版本一个 prefix（mac/linux）
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvm)) roots.push(path.join(nvm, v, 'lib', 'node_modules'));
  } catch (e) { /* 没有 nvm 就算了 */ }
  for (const p of String(process.env.NODE_PATH || '').split(path.delimiter)) if (p) roots.push(p);
  for (const n of names) {
    for (const root of roots) {
      try { return require(require.resolve(n, { paths: [root] })).chromium; } catch (e) { tried.push(path.join(root, n)); }
    }
  }
  throw new Error('找不到 playwright-core（试过：' + tried.join('、') + '）。'
    + '装一个即可：npm i -g playwright-core，或在本 profile 里 pnpm add playwright-core；'
    + '也可以用环境变量 DOUYIN_PLAYWRIGHT 直接指定模块目录。');
}

/** ms-playwright 的浏览器缓存在各平台的默认位置（playwright 自己就是按这个顺序找的） */
function msPlaywrightCaches() {
  const home = os.homedir();
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : path.join(home, 'AppData', 'Local', 'ms-playwright'), // Windows
    path.join(home, 'Library', 'Caches', 'ms-playwright'), // macOS
    path.join(home, '.cache', 'ms-playwright'), // Linux
    '/ms-playwright', // 官方 playwright docker 镜像
  ].filter(Boolean);
}

/** 一个 ms-playwright 缓存目录里 Chromium 的相对路径：新老目录结构（mac 新结构是 Google Chrome for Testing）都认 */
const CHROMIUM_REL_PATHS = [
  'chrome-win64/chrome.exe',
  'chrome-win/chrome.exe',
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
];

/** 系统里可能已经装好的 Chrome / Edge（不用下 playwright 的浏览器也能跑；注意品牌版装不了扩展） */
function systemBrowsers() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const home = os.homedir();
  return [
    // 非品牌版优先：Chromium / Google Chrome for Testing（mac 上 brew 装的 Chromium 也在这里）
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    path.join(home, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    // 品牌版兜底（137+ 忽略命令行 --load-extension，见 isBrandedBrowser）
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
  ];
}

/**
 * 品牌版 Chrome / Edge 从 137 起忽略命令行 `--load-extension`，扩展装不进去
 * （playwright 的默认参数也换不来）；非品牌版（Chromium / Google Chrome for Testing）不受影响。
 * 只按路径特征判断，用来给用户一句能对症的提示。
 */
function isBrandedBrowser(exe) {
  const p = String(exe || '').replace(/\\/g, '/').toLowerCase();
  if (!p) return false;
  if (p.includes('for testing')) return false;
  if (p.includes('chromium.app') || p.includes('/chrome-linux') || p.includes('chromium-')) return false;
  return /google\/chrome\/application\/chrome\.exe$/.test(p)
    || /google chrome\.app\/contents\/macos\/google chrome$/.test(p)
    || /microsoft\/edge\/application\/msedge\.exe$/.test(p)
    || /microsoft edge\.app\/contents\/macos\/microsoft edge$/.test(p)
    || /\/google-chrome(-stable)?$/.test(p);
}

/**
 * 找可用的 Chromium 可执行文件（playwright 的 chromium 不一定会下载浏览器，
 * 所以先看各平台的 ms-playwright 缓存，再退到系统已装的 Chromium / Chrome / Edge）。
 */
function findChrome() {
  const ok = (p) => p && fs.existsSync(p);
  if (ok(DEFAULTS.chrome)) return String(DEFAULTS.chrome).replace(/\\/g, '/');

  for (const base of msPlaywrightCaches()) {
    if (!fs.existsSync(base)) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)); } catch (e) { continue; }
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); // 版本号大的优先
    for (const d of dirs) {
      for (const rel of CHROMIUM_REL_PATHS) {
        const exe = path.join(base, d, ...rel.split('/'));
        if (ok(exe)) return exe.replace(/\\/g, '/');
      }
    }
  }
  for (const exe of systemBrowsers()) if (ok(exe)) return exe.replace(/\\/g, '/');
  return '';
}

/**
 * 上一次调用为了「等扫码」故意留下的浏览器窗口：这次别再抢 profile 锁，直接接上去。
 * 先用调试端口问一句，只认「开着 douyin.com 页面的窗口」——不是我们的就绝不碰。
 * @returns {Promise<{browser: object, ctx: object, page: object}|null>}
 */
async function attachRunningBrowser(chromium, log) {
  const endpoint = `http://127.0.0.1:${DEFAULTS.port}`;
  const targets = await fetch(`${endpoint}/json/list`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const mine = (Array.isArray(targets) ? targets : [])
    .find((t) => t && t.type === 'page' && /^https:\/\/www\.douyin\.com\//.test(String(t.url || '')));
  if (!mine) return null;
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
  } catch (e) {
    log('接上一次的浏览器窗口失败（' + e.message + '），重新开一个');
    return null;
  }
  const ctx = browser.contexts()[0];
  const page = ctx && (ctx.pages().find((p) => !p.isClosed() && /^https:\/\/www\.douyin\.com\//.test(p.url())) || ctx.pages()[0]);
  if (!ctx || !page) {
    await browser.close().catch(() => {});
    return null;
  }
  log(`接上上一次留下的浏览器窗口（CDP :${DEFAULTS.port}）：${page.url()}`);
  return { browser, ctx, page };
}

/**
 * 采集锁：同一个浏览器 profile 同一时刻只能有一个采集在跑。
 * 工具上的 `isConcurrencySafe=false` 只管得住**同一个宿主进程**；同一个 DSH_HOME 下可以装好几个
 * profile（比如 desktop + web），两边的 agent 可能同时调这个工具 —— 后来者会「接上」前一个的
 * 浏览器窗口，两个采集互相踩。所以锁必须落到文件系统上（`~/.dsh/douyin-collector/collector.lock`）。
 * @returns {() => void} 释放函数（幂等，可重复调用）
 */
export function acquireRunLock({ log, url }) {
  const lockPath = path.join(DEFAULTS.home, 'collector.lock');
  fs.mkdirSync(DEFAULTS.home, { recursive: true });
  const read = () => { try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; } };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };
  const held = read();
  const heldPid = held && Number(held.pid);
  if (heldPid && heldPid !== process.pid && alive(heldPid)) {
    throw new Error('已经有一个采集在跑（pid ' + heldPid
      + (held.profile ? '，profile ' + held.profile : '')
      + (held.startedAt ? '，开始于 ' + held.startedAt : '')
      + '）：同一个浏览器 profile 同一时刻只能跑一个采集，等它结束（或关掉它留下的浏览器窗口）再试。'
      + '锁文件：' + lockPath);
  }
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    profile: process.env.DSH_PROFILE || '',
    url,
  }, null, 2) + '\n');
  log('拿到采集锁（' + lockPath + '，pid ' + process.pid + '）');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = read();
      if (current === null || Number(current.pid) === process.pid) fs.rmSync(lockPath, { force: true });
    } catch { /* 放锁失败不影响本次结果 */ }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 结果默认落在「当前会话工作区」下的这个子目录里（不污染工作区根目录；可用 outDir 覆盖）。 */
export const WORKSPACE_OUT_SUBDIR = 'douyin-comments';

/**
 * 当前会话的工作区目录。DSH 把每个会话的工作区放在 `exec.agent.session.header.cwd`
 * （实测 dsh 0.1.7-rc.2 与 0.2.0-rc.2 同形；内置 fs 工具也是这么取 cwd 的）。
 * @param {object} [exec] 工具执行上下文
 * @returns {string} 工作区绝对路径，取不到时空串
 */
export function sessionWorkspaceCwd(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined;
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : '';
}

/**
 * 本次调用的输出目录：显式 outDir > 当前会话工作区/`douyin-comments` > 全局默认目录。
 * 「别人的机器上采完的数据就在自己的工作区里」——不用去 `~/.dsh/douyin-collector/out` 里翻。
 * @param {{explicit?: string, exec?: object, fallback?: string}} [o]
 * @returns {string}
 */
export function resolveOutDir({ explicit, exec, fallback } = {}) {
  const asked = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : '';
  if (asked) return asked;
  const workspace = sessionWorkspaceCwd(exec);
  if (workspace) return path.join(workspace, WORKSPACE_OUT_SUBDIR);
  return fallback || DEFAULTS.outDir;
}

export function videoIdFromUrl(u) {
  const s = String(u || '');
  let m = /\/video\/(\d{15,25})/.exec(s);
  if (m) return m[1];
  m = /[?&]modal_id=(\d{15,25})/.exec(s);
  if (m) return m[1];
  m = /(\d{15,25})/.exec(s);
  return m ? m[1] : null;
}

// ---------- 扩展：定位 + 自动安装 ----------

/** 扩展运行必需的文件（manifest 里引用到的） */
const EXT_FILES = ['manifest.json', 'hook.js', 'content.js', 'background.js', 'panel.css', 'app.js'];

function readManifest(dir) {
  try {
    // manifest.json 可能带 UTF-8 BOM（Chrome 不在意，JSON.parse 会炸）——统一去掉再解析
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { return null; }
}

/** 未打包扩展的 ID：SHA256(绝对路径的 UTF-16LE 字节) 前 16 字节，每个半字节 0-f 映射到 a-p（Chromium 定法） */
export function extensionIdFromPath(dir) {
  const h = crypto.createHash('sha256').update(Buffer.from(path.resolve(dir), 'utf16le')).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (h[i] >> 4)) + String.fromCharCode(97 + (h[i] & 15));
  }
  return id;
}

/** 目录指纹（内容哈希），用来判断要不要重新安装 */
function dirSignature(dir) {
  const manifest = readManifest(dir);
  const files = EXT_FILES.filter((f) => fs.existsSync(path.join(dir, f)));
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update(fs.readFileSync(path.join(dir, f)));
  }
  return { version: (manifest && manifest.version) || '0', name: (manifest && manifest.name) || '', files, hash: h.digest('hex').slice(0, 16) };
}

/** 按优先级找扩展源目录：显式指定 → 插件自带 → 已安装副本 → 开发目录 */
export function findExtensionSource() {
  const cands = [];
  if (DEFAULTS.extDir) cands.push({ dir: DEFAULTS.extDir, why: 'DOUYIN_EXT_DIR / 插件配置' });
  cands.push({ dir: path.join(PLUGIN_DIR, 'extension'), why: '插件自带（随包分发）' });
  cands.push({ dir: path.join(DEFAULTS.home, 'extension'), why: '上次安装的副本' });
  cands.push({ dir: 'D:\\dycopy\\douyin-collector', why: '开发目录' });
  for (const c of cands) {
    if (fs.existsSync(path.join(c.dir, 'manifest.json'))) return c;
  }
  return null;
}

function copyExtFiles(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, f);
    if (!fs.statSync(s).isFile()) continue;
    if (!/\.(json|js|css|html)$/i.test(f)) continue;
    fs.copyFileSync(s, path.join(dstDir, f));
  }
}

/**
 * 把扩展「装进浏览器」。
 *
 * 背景：MV3 未打包扩展只能靠 `--load-extension=<目录>` 让 Chrome 加载，没有别的官方
 * 自动化入口。所以「自动安装」= 本插件自带一份扩展 → 同步到一个稳定目录 →
 * 每次启动浏览器都用它加载。使用者视角就是：AI 第一次调用时扩展已经装好了。
 *
 * @returns {{dir:string, version:string, name:string, source:string, sourceWhy:string,
 *            copied:boolean, hash:string, files:string[]}}
 */
export function installExtension({ log = () => {} } = {}) {
  const src = findExtensionSource();
  if (!src) {
    throw new Error('找不到抖音评论采集扩展（manifest.json）：'
      + '插件自带副本缺失，也没在 ' + path.join(DEFAULTS.home, 'extension') + ' 或 D:\\dycopy\\douyin-collector 找到。');
  }
  const target = path.join(DEFAULTS.home, 'extension');
  const sSrc = dirSignature(src.dir);
  const sDst = fs.existsSync(path.join(target, 'manifest.json')) ? dirSignature(target) : null;
  let copied = false;

  if (path.resolve(src.dir) !== path.resolve(target)) {
    if (!sDst || sDst.hash !== sSrc.hash) {
      fs.rmSync(target, { recursive: true, force: true });
      copyExtFiles(src.dir, target);
      copied = true;
    }
  }
  const sig = dirSignature(target);
  fs.mkdirSync(DEFAULTS.home, { recursive: true });
  fs.writeFileSync(path.join(DEFAULTS.home, 'extension.installed.json'), JSON.stringify({
    installedAt: new Date().toISOString(), dir: target,
    from: src.dir, why: src.why, version: sig.version, hash: sig.hash, copiedAtThisRun: copied,
  }, null, 2), 'utf8');

  log(`扩展就绪：v${sig.version}${sig.name ? '（' + sig.name + '）' : ''}`
    + ` @ ${target}` + (copied ? `（本次从「${src.why}」安装）` : '（已是最新，无需重装）'));
  return { dir: target, version: sig.version, name: sig.name, source: src.dir, sourceWhy: src.why, copied, hash: sig.hash, files: sig.files };
}

/** 记录「上一次启动浏览器时用的扩展 hash」，用来判断扩展文件有没有变过 */
const LAUNCH_STATE_FILE = 'extension.launched.json';

export function readLaunchState() {
  try { return JSON.parse(fs.readFileSync(path.join(DEFAULTS.home, LAUNCH_STATE_FILE), 'utf8')) || {}; } catch { return {}; }
}

export function writeLaunchState(next) {
  fs.mkdirSync(DEFAULTS.home, { recursive: true });
  fs.writeFileSync(path.join(DEFAULTS.home, LAUNCH_STATE_FILE), JSON.stringify(next, null, 2), 'utf8');
}

/**
 * 清掉浏览器 profile 里对「未打包扩展脚本」的缓存。
 *
 * 实测坑（v0.2.6 排查了两小时）：Chrome 把扩展的脚本/代码缓存在 profile 里
 * （`Default/Code Cache`、`Default/Service Worker/ScriptCache`）。扩展目录里的
 * background.js 换了新代码、`chrome.runtime.getManifest().version` 也是新版本，
 * 但**新开的浏览器里跑的 `executeAiCommand` 还是旧代码**（AI 桥回 UNKNOWN_COMMAND），
 * 只有把这两个目录挪走才生效。所以扩展内容一变，启动前先清一次。
 *
 * @returns {string[]} 真正删掉的目录
 */
export function clearStaleScriptCaches(profileDir, { log = () => {} } = {}) {
  const targets = [
    path.join(profileDir, 'Default', 'Code Cache'),
    path.join(profileDir, 'Default', 'Service Worker', 'ScriptCache'),
  ];
  const cleared = [];
  for (const t of targets) {
    try {
      if (fs.existsSync(t)) { fs.rmSync(t, { recursive: true, force: true }); cleared.push(t); }
    } catch (e) {
      log('清浏览器脚本缓存失败（继续跑，但可能还在用旧扩展代码）：' + t + ' — ' + e.message);
    }
  }
  return cleared;
}

// ---------- CSV（列契约抄自扩展 background.js，顺序不变） ----------

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function cleanText(t) {
  if (!t) return '';
  return String(t)
    .replace(/\[[^\[\]]{1,12}\]/g, '')
    .replace(/@[^\s@]{1,30}/g, '')
    .replace(/#[^\s#]{1,40}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toCsv(comments) {
  const cols = [
    'cid', 'create_time', 'create_time_str', 'text', 'text_clean', 'text_len',
    'digg_count', 'reply_comment_total', 'ip_label', 'is_hot', 'is_folded',
    'level', 'stick_position', 'user_nickname', 'user_uid',
    'is_reply', 'parent_cid',
  ];
  const rows = [cols.join(',')];
  for (const c of comments) {
    const t = c.text || '';
    const ct = c.create_time ? new Date(c.create_time * 1000).toISOString() : '';
    const u = c.user || {};
    rows.push([
      csvCell(c.cid), csvCell(c.create_time), csvCell(ct), csvCell(t), csvCell(cleanText(t)),
      csvCell([...String(t)].length),
      csvCell(c.digg_count), csvCell(c.reply_comment_total), csvCell(c.ip_label),
      csvCell(c.is_hot), csvCell(c.is_folded), csvCell(c.level), csvCell(c.stick_position),
      csvCell(u.nickname), csvCell(u.uid),
      csvCell(c.is_reply ? 1 : 0), csvCell(c.parent_cid),
    ].join(','));
  }
  return rows.join('\r\n');
}

// ---------- 主流程 ----------

/**
 * 采一个抖音视频的公开评论。
 * @param {object} o
 * @param {string} o.url        视频链接（/video/<id>、带 modal_id 的浮层链接、或含 id 的分享文本）
 * @param {number} [o.max]      目标条数上限（默认 DEFAULTS.max = 80000，到量即暂停）
 * @param {boolean} [o.replies] 是否等二级回复补采（默认 true）
 * @param {number} [o.timeoutMs] 总超时（默认 DEFAULTS.timeoutMs = 1800000）
 * @param {number} [o.lanes]    并发路数（默认 DEFAULTS.lanes = 4；1..8，写进扩展设置）
 * @param {number} [o.waitLoginSec] 检测到未登录时等使用者扫码的秒数（不传用 DEFAULTS.waitLoginSec，默认 180；显式 0 = 不等）
 * @param {string} [o.outDir]   输出目录
 * @param {boolean} [o.keep]    采完不关浏览器（调试用）
 * @param {AbortSignal} [o.signal] 调用方取消
 * @param {(s:string)=>void} [o.onLog]
 */
export async function collectDouyinComments(o = {}) {
  const log = o.onLog || (() => {});
  const url = String(o.url || '').trim();
  if (!url) throw new Error('缺少 url');
  const max = Number(o.max) > 0 ? Number(o.max) : (Number(DEFAULTS.max) > 0 ? Number(DEFAULTS.max) : 80000);
  const wantReplies = o.replies !== false;
  const timeoutMs = Number(o.timeoutMs) > 0
    ? Number(o.timeoutMs)
    : (Number(DEFAULTS.timeoutMs) > 0 ? Number(DEFAULTS.timeoutMs) : 1800000);
  // 并发路数：工具参数 > 插件设置（DEFAULTS.lanes）> 4；这里先钳到 1..8，扩展侧还会再钳一次
  const lanes = Math.max(1, Math.min(8, Math.round(
    Number(o.lanes) > 0 ? Number(o.lanes) : (Number(DEFAULTS.lanes) > 0 ? Number(DEFAULTS.lanes) : 4),
  )));
  // 采集前清空扩展缓存：默认不清（清空会毁掉扩展的断点续采进度）
  const clearBefore = o.clearBefore === undefined ? !!DEFAULTS.clearBefore : !!o.clearBefore;
  // 二级回复阶段的三档设置（0/空 = 用扩展内置值）
  const numOr = (v, d) => {
    const n = Number(v);
    if (isFinite(n) && n > 0) return n;
    const dn = Number(d);
    return isFinite(dn) && dn > 0 ? dn : 0;
  };
  const replyLanes = Math.max(0, Math.min(8, Math.round(numOr(o.replyLanes, DEFAULTS.replyLanes))));
  const replyThrottleSec = numOr(o.replyThrottleSec, DEFAULTS.replyThrottleSec);
  const replyNoProgressMs = Math.max(60000, Math.round(
    (numOr(o.replyNoProgressSec, DEFAULTS.replyNoProgressSec) || 900) * 1000,
  ));
  const waitLoginSec = o.waitLoginSec === undefined || o.waitLoginSec === null || o.waitLoginSec === ''
    ? Math.max(0, Number(DEFAULTS.waitLoginSec) || 0)
    : Math.max(0, Number(o.waitLoginSec) || 0);
  const outDir = o.outDir || DEFAULTS.outDir;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const rest = () => deadline - Date.now();
  const aborted = () => !!(o.signal && o.signal.aborted);

  // ① 自动装扩展（插件自带副本 → 稳定目录）
  const ext = installExtension({ log });

  const chromium = loadChromium();
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chromium 可执行文件：ms-playwright 缓存里没有 chromium-*'
    + '（Windows 在 %LOCALAPPDATA%\\ms-playwright，macOS 在 ~/Library/Caches/ms-playwright，Linux 在 ~/.cache/ms-playwright），'
    + '系统里也没发现 Chromium / Chrome / Edge。用 DOUYIN_CHROME 指定可执行文件的绝对路径，'
    + '或先跑一次 `npx playwright install chromium`。');
  if (isBrandedBrowser(chrome)) {
    log('⚠ 选中的是品牌版 Chrome / Edge：' + chrome);
    log('  品牌版 Chrome 137 起会忽略命令行的 --load-extension，插件自带的那份扩展装不进去（面板不会出现）。');
    log('  非品牌版不受影响，装一个即可：npx playwright install chromium（或 brew install --cask chromium），');
    log('  然后用 DOUYIN_CHROME 指向它（例如 "…/Chromium.app/Contents/MacOS/Chromium"），或在设置里填浏览器路径。');
  }

  const profile = DEFAULTS.profile;
  fs.mkdirSync(profile, { recursive: true });

  // 采集锁：先拿锁再碰浏览器 —— 同一个 DSH_HOME 下装了多个 profile 时，两边同时调用要立刻失败，
  // 而不是都去接同一个浏览器窗口互相踩。
  const releaseLock = acquireRunLock({ log, url });

  // 上一次为了等扫码把窗口留着了？那就接上去：同一个 profile 目录不能再开第二个进程。
  let running = await attachRunningBrowser(chromium, log);

  // 扩展文件变过（或第一次记录）→ profile 里的旧脚本缓存会让新窗口继续跑旧代码。
  // 接了旧窗口也一样（它的扩展代码是启动那一刻的），先关掉它再重开。
  const launchState = readLaunchState();
  const extChanged = launchState.hash !== ext.hash;
  if (running && extChanged) {
    log('扩展文件跟上次启动时不一样（' + (launchState.hash || '没有记录') + ' → ' + ext.hash + '）：'
      + '旧窗口里跑的还是旧扩展代码，关掉它重新开一个');
    await running.browser.close().catch(() => {});
    running = null;
  }
  const adopted = running ? running.browser : null;
  if (!running) {
    if (extChanged) {
      const cleared = clearStaleScriptCaches(profile, { log });
      if (cleared.length) {
        log('清掉浏览器里缓存的旧扩展脚本（扩展更新过，不清的话新窗口还在跑旧代码）：'
          + cleared.map((p) => path.relative(profile, p) || p).join('、'));
      }
    }
    log('启动 Chromium（已装入扩展 v' + ext.version + '）…');
  }
  let ctx;
  try {
    ctx = running ? running.ctx : await chromium.launchPersistentContext(profile, {
      headless: false,
      executablePath: chrome,
      // playwright 默认会加 --disable-extensions，那会盖掉我们的 --disable-extensions-except
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${ext.dir}`,
        `--load-extension=${ext.dir}`,
        `--remote-debugging-port=${DEFAULTS.port}`,
        '--no-first-run', '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=ExtensionManifestV2Disabled,DisableLoadExtensionCommandLineSwitch',
      ],
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
  } catch (e) {
    releaseLock();
    throw new Error('打开浏览器失败：' + (e && e.message)
      + '（如果上一次采集留了个窗口没关，先关掉它，或用 DOUYIN_PROFILE 换一个 profile 目录）');
  }
  // 记下这次启动用的扩展 hash：下次扩展一变，就先清 profile 里的旧脚本缓存
  writeLaunchState({
    hash: ext.hash, version: ext.version, profile,
    adopted: !!running, launchedAt: new Date().toISOString(),
  });

  let closed = false;
  let keepForLogin = false;      // 「没登录，窗口留给你扫码」时不许关窗口
  let extHelperPage = null;      // 扩展 SW 睡着时开的兜底扩展页（读/写 chrome.storage 用）
  const close = async () => {
    if (closed) return;
    closed = true;
    releaseLock();
    try { if (extHelperPage && !extHelperPage.isClosed()) await extHelperPage.close(); } catch (e) { /* 忽略 */ }
    extHelperPage = null;
    if (o.keep || keepForLogin) {
      log('浏览器窗口保持打开（' + (keepForLogin ? '等你扫码登录' : 'keepOpen=true') + '）');
      return;
    }
    if (adopted) await adopted.close().catch(() => {});
    else await ctx.close().catch(() => {});
  };

  try {
    // ② cookies（可选）：没有就靠持久化 profile 里的登录态
    const cookieFiles = [DEFAULTS.cookies, path.join(DEFAULTS.home, 'cookies.json')].filter(Boolean);
    const cookieFile = cookieFiles.find((f) => fs.existsSync(f));
    if (cookieFile) {
      try {
        await ctx.addCookies(JSON.parse(fs.readFileSync(cookieFile, 'utf8')));
        log('已灌入 cookies：' + cookieFile);
      } catch (e) { log('cookies 灌入失败（继续）：' + e.message); }
    } else {
      log('没用 cookies 文件，用浏览器 profile 里的登录态：' + profile);
    }

    const page = running ? running.page : (ctx.pages()[0] || (await ctx.newPage()));
    const vid = videoIdFromUrl(url);
    const target = vid ? `https://www.douyin.com/video/${vid}` : url;
    if (running) {
      // 沿用的窗口可能停在别的视频上：请求的不是同一个就导航过去，否则原地继续（保住登录态）。
      if (vid && !page.url().includes(`/video/${vid}`)) {
        log('沿用浏览器窗口，换到 ' + target);
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('goto: ' + e.message));
      } else {
        log('沿用已在打开的页面，不重新导航：' + page.url());
      }
    } else {
      log('打开 ' + target);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('goto: ' + e.message));
    }

    // ③ 确认扩展真的装进浏览器了（面板是扩展注入的）
    await page.waitForSelector('#dts-collector-panel', { timeout: 30000 }).catch(() => null);
    if (!(await page.$('#dts-collector-panel'))) {
      const sws = ctx.serviceWorkers().map((s) => s.url());
      throw new Error('扩展面板没出现（装进去的扩展没生效）：' + ext.dir
        + '；用的浏览器=' + chrome
        + (isBrandedBrowser(chrome) ? '（这是品牌版 Chrome/Edge：137 起忽略 --load-extension，请换成非品牌版 Chromium，见上面的提示）' : '')
        + '；serviceWorkers=' + JSON.stringify(sws)
        + '；可试 DOUYIN_PROFILE 换一个 profile 目录重来。');
    }
    log('扩展已在浏览器里生效（面板已注入）');

    // ④ 登录闸门：**没登录就不开始采集**。
    //    未登录时抖音对评论接口限流很凶，硬采只会拿到残缺数据，还提前把限流额度耗掉。
    //    正确姿势：把二维码留着/叫出来 → 等使用者扫码 → 登上了才继续；等不到就明确失败。
    const loginProbe = () => page.evaluate(() => ({
      loginButton: !!document.querySelector('[data-e2e="login-button"], [data-e2e="login"]'),
      mask: !!document.querySelector('.trust-login-dialog-mask'),
    })).catch(() => ({ loginButton: false, mask: false }));
    const readLoginSignals = async () => {
      const dom = await loginProbe();
      const jar = await ctx.cookies('https://www.douyin.com').catch(() => []);
      return { ...loginGate({ cookies: jar, loginButton: dom.loginButton, mask: dom.mask }), dom };
    };
    /** 把二维码叫出来：已经有弹窗就别动它（动一下二维码就没了），没有就点页面上的「登录」 */
    const ensureLoginDialog = async () => {
      const dom = await loginProbe();
      if (dom.mask) return true;
      if (dom.loginButton) {
        await page.evaluate(() => {
          const b = document.querySelector('[data-e2e="login-button"], [data-e2e="login"]');
          if (b) b.click();
        }).catch(() => {});
        await sleep(1500);
      }
      return (await loginProbe()).mask;
    };
    /** 已经登录时，顺手把挡着页面的弹窗点掉 */
    const dismissOverlays = async () => {
      for (const label of ['取消', '关闭', '稍后', '我知道了', '暂不']) {
        const mask = await page.evaluate(() => !!document.querySelector('.trust-login-dialog-mask'));
        if (!mask) break;
        await page.evaluate((l) => {
          const cs = [...document.querySelectorAll('button,div[role="button"],span')].filter((x) => (x.innerText || '').trim() === l);
          if (cs.length) cs[cs.length - 1].click();
        }, label).catch(() => {});
        await sleep(1200);
      }
    };

    let gate = await readLoginSignals();
    if (gate.hasSession) {
      await dismissOverlays();          // 已登录：顺手把可能挡着页面的弹窗点掉
    } else if (DEFAULTS.allowAnonymous) {
      log('未登录（没有 sessionid / sid_tt），但 DOUYIN_ALLOW_ANONYMOUS=1：按匿名继续 —— 匿名评论接口随时可能限流，采到的可能不完整');
      await dismissOverlays();
    } else {
      log('页面未登录（没有 sessionid / sid_tt 登录 cookie）—— 先不开始采集：未登录调评论接口会被限流，采出来是残的');
      await ensureLoginDialog();
      if (waitLoginSec > 0) {
        log(`请在浏览器窗口里用抖音 App 扫码登录（最多等 ${waitLoginSec}s）…`);
        const loginDeadline = Date.now() + waitLoginSec * 1000;
        let nextLog = Date.now() + 30000;
        while (Date.now() < loginDeadline && rest() > 0 && !aborted()) {
          await sleep(2000);
          gate = await readLoginSignals();
          if (gate.hasSession) break;
          if (Date.now() >= nextLog) {
            nextLog = Date.now() + 30000;
            log(`还没扫码，继续等（剩 ${Math.max(0, Math.round((loginDeadline - Date.now()) / 1000))}s）…`);
          }
        }
      }
      if (!gate.hasSession) {
        keepForLogin = true;   // 窗口留着，使用者还能接着扫
        const why = '未登录：没检测到抖音登录态，本次**没有开始采集**（未登录采集会被限流，数据残缺）。'
          + '请在已经打开的浏览器窗口里用抖音 App 扫码登录，然后**再调用一次** douyin_comments；'
          + `登录态保存在 ${profile}，扫一次以后都不用再扫。`;
        log('❌ ' + why);
        return {
          ok: false, error: why, videoId: vid || '', title: '', count: 0,
          csvPath: '', jsonPath: '', phase: 'need-login', note: '等待扫码登录',
          durationSec: Number(((Date.now() - started) / 1000).toFixed(1)),
          outDir, url: target, sample: [], extension: ext, paused: false,
        };
      }
      log('已登录（检测到登录 cookie），继续采集');
      // 扫码后抖音常常整页刷新：等扩展面板回来再往下走
      await page.waitForSelector('#dts-collector-panel', { timeout: 30000 }).catch(() => null);
    }

    // ⑤ 状态/按钮工具
    const st = () => page.evaluate(() => {
      const c = window.__DTS_COLLECTOR__;
      const s = (c && c.getStatus) ? c.getStatus() : null;
      const sig = (c && c.getSigned) ? c.getSigned() : null;
      let sigAweme = null;
      try { sigAweme = new URL(sig.url).searchParams.get('aweme_id'); } catch (e) { /* 忽略 */ }
      const p = document.getElementById('dts-collector-panel');
      return {
        phase: s && s.phase, videoId: s && s.videoId, unique: s && s.unique,
        savedCount: s && s.savedCount, total: s && s.total, note: s && s.note,
        error: s && s.error, liveVideoId: s && s.liveVideoId,
        autoOpen: s && s.autoOpen, commentAreaOpen: s && s.commentAreaOpen, hint: s && s.hint,
        hasSig: !!(sig && sig.url), sigAweme,
        panel: p ? p.innerText.replace(/\s+/g, ' ') : '',
      };
    });
    const clickPanel = (re) => page.evaluate((src) => {
      const p = document.getElementById('dts-collector-panel');
      const b = p && [...p.querySelectorAll('button')].find((x) => new RegExp(src).test(x.innerText));
      if (b) { b.click(); return true; }
      return false;
    }, re.source);
    /**
     * 只在「扩展自己的」service worker / 扩展页里 eval。
     * 不能用 ctx.serviceWorkers()[0]：抖音页面自己也注册了 sw.js，清过脚本缓存后它可能排在前面，
     * 在里面 eval chrome.storage 会直接 `ReferenceError: chrome is not defined`（实测踩过：
     * 设置没写进去、落库读成 0 条、明明采到了却判「没本轮新数据」）。
     * 扩展 SW 睡着时开一个扩展自己的页面兜底（扩展页同样有 chrome.* 权限，顺手把 SW 唤醒）。
     */
    const isExtWorker = (s) => /^chrome-extension:\/\//.test(s.url());
    const extEval = async (fn, arg) => {
      const sw = ctx.serviceWorkers().find(isExtWorker)
        || await ctx.waitForEvent('serviceworker', { timeout: 8000, predicate: isExtWorker }).catch(() => null);
      if (sw) {
        try { return await sw.evaluate(fn, arg); } catch (e) { if (!/chrome is not defined/.test(String(e))) throw e; }
      }
      if (!extHelperPage || extHelperPage.isClosed()) {
        extHelperPage = await ctx.newPage();
        await extHelperPage.goto('chrome-extension://' + extensionIdFromPath(ext.dir) + '/index.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
        const back = ctx.serviceWorkers().find(isExtWorker);
        if (back) { try { return await back.evaluate(fn, arg); } catch (e) { /* 落到扩展页兜底 */ } }
      }
      return extHelperPage.evaluate(fn, arg);
    };

    /** 从扩展 SW 读该视频的落库快照 */
    const readBucket = async (videoId) => {
      const r = await extEval(async (id) => {
        const store = await chrome.storage.local.get(['dts_c_' + id, 'dts_videos']);
        const bucket = store['dts_c_' + id] || {};
        const meta = (store.dts_videos || {})[id] || {};
        return { keys: Object.keys(bucket), title: meta.title || '' };
      }, videoId).catch(() => null);
      if (!r) return { ok: false, keys: [], title: '' };
      return { ok: true, keys: r.keys || [], title: r.title || '' };
    };
    const readComments = async (videoId) => {
      const r = await extEval(async (id) => {
        const store = await chrome.storage.local.get(['dts_c_' + id, 'dts_videos']);
        const bucket = store['dts_c_' + id] || {};
        const meta = (store.dts_videos || {})[id] || {};
        return { list: Object.values(bucket), title: meta.title || '' };
      }, videoId).catch(() => null);
      if (!r) return { list: [], title: '' };
      return { list: Array.isArray(r.list) ? r.list : [], title: r.title || '' };
    };
    /**
     * 把本轮的运行时设置写进扩展（chrome.storage.local.dts_settings）。
     * 扩展在每次「开始采集」时读一次 → 改并发路数不用重开浏览器、也不用重装扩展。
     * 写不进去不算致命：扩展会退回内置的 4 路，只是设置没生效，所以只记日志。
     */
    const pushExtensionSettings = async (settings) => {
      const r = await extEval(async (value) => {
        await chrome.storage.local.set({ dts_settings: value });
        const back = await chrome.storage.local.get(['dts_settings']);
        return back.dts_settings || null;
      }, settings).catch((e) => ({ error: String((e && e.message) || e) }));
      if (!r) return { ok: false, error: '没拿到扩展的 service worker（设置没写进去，扩展用内置默认值）' };
      if (r.error) return { ok: false, error: r.error };
      return { ok: true, value: r };
    };
    /**
     * 读回扩展「实际用了几路」：content.js 每次开始采集都会写 dts_settings_effective。
     * 拿不到就返回 null（只是诊断信息，不影响采集结果）。
     */
    const readEffectiveLanes = async () => {
      const r = await extEval(async () => {
        const o = await chrome.storage.local.get(['dts_settings_effective']);
        return o.dts_settings_effective || null;
      }).catch(() => null);
      return r && Number(r.lanes) > 0 ? r : null;
    };

    let s = await st();
    log('面板就绪：phase=' + s.phase + ' videoId=' + s.videoId + ' 现有条数=' + (s.unique || 0));

    // ⑥ 新鲜度：先记下「开始前就存在」的 cid。
    //    默认**不清空**扩展缓存 —— 清空会重置去重表和 cursor，把扩展的「断点续采」进度一起抹掉
    //    （二级回复采到一半被限流时，下一次再跑本该接着采，旧版却是从零开始）。
    //    不清空时靠结束时按 cid 差集剔除旧数据，交付的仍然只有本轮新采的。
    const before = await readBucket(s.videoId || s.liveVideoId || vid);
    const beforeCids = new Set(before.keys);
    if (clearBefore) {
      if (beforeCids.size > 0) log('扩展里已有上一轮残留 ' + beforeCids.size + ' 条，按要求先清空（这会丢掉断点续采进度）…');
      const cleared = await clickPanel(/清空/);
      if (cleared) {
        await sleep(1800);
        const after = await readBucket(s.videoId || s.liveVideoId || vid);
        if (after.keys.length > 0) {
          log('清空后仍有 ' + after.keys.length + ' 条（扩展清空没生效），结束时按 cid 差集剔除旧数据');
        } else {
          beforeCids.clear();   // 清空成功：开始前不存在任何数据，结束时的任何数据都是本轮新采
        }
        s = await st();
      } else {
        log('面板上没有「清空」按钮，改用 cid 差集保证只交付本轮新采');
      }
    } else if (beforeCids.size > 0) {
      log('扩展里已有上一轮 ' + beforeCids.size + ' 条：不清空（保留断点续采进度），结束时按 cid 差集只交付本轮新采');
    }

    if (!s.liveVideoId && !s.videoId) log('提示：页面还没识别到视频 ID，仍会点「开始采集」让扩展自己判形态');

    // ⑥.5 把运行时设置推给扩展（DSH「设置 → 插件」里可改；写不进去就用扩展内置值）
    const extSettings = { lanes };
    if (replyLanes > 0) extSettings.replyLanes = replyLanes;
    if (replyThrottleSec > 0) extSettings.replyThrottleMaxWaitMs = Math.round(replyThrottleSec * 1000);
    const pushed = await pushExtensionSettings(extSettings);
    if (pushed.ok) log('已把设置写进扩展：dts_settings=' + JSON.stringify(pushed.value));
    else log('写扩展设置失败（改用扩展内置值）：' + pushed.error);

    // ⑦ 点开始采集，并确保拿到签名（拿不到就助推/重试）
    const startedPhases = new Set(['collecting', 'replies', 'done']);
    const progressing = (x) => x.hasSig || (x.unique || 0) > 0 || startedPhases.has(x.phase);
    const waitFor = async (ms, what) => {
      const until = Date.now() + ms;
      while (Date.now() < until && rest() > 0 && !aborted()) {
        const x = await st();
        if (progressing(x)) return x;
        if (x.phase === 'error') throw new Error('扩展报错：' + (x.error || x.note || '(无详情)'));
        await sleep(1500);
      }
      log('等了 ' + Math.round(ms / 1000) + 's 还没' + what);
      return null;
    };
    const nudgeCommentEntry = async () => {
      const cands = await page.evaluate(() => {
        const sels = ['[data-e2e="comment-icon"]', '[data-e2e="feed-comment-icon"]', '[data-e2e="comment"]',
          'span[data-e2e*="comment"]', '.comment-icon', '[class*="commentIcon"]', '[class*="comment-icon"]'];
        const out = [];
        for (const q of sels) {
          for (const el of document.querySelectorAll(q)) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) out.push({ sel: q, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          }
        }
        return out.slice(0, 4);
      }).catch(() => []);
      for (const c of cands) {
        log('助推：点页面评论入口 ' + c.sel);
        await page.mouse.click(c.x, c.y).catch(() => {});
        const r = await waitFor(8000, '拿到签名');
        if (r) return true;
      }
      return false;
    };
    const nudgeScroll = async () => {
      log('助推：在页面上小幅滚动，让页面自己发评论请求');
      for (let i = 0; i < 3; i++) {
        await page.mouse.move(420, 700).catch(() => {});
        await page.mouse.wheel(0, 500).catch(() => {});
        const r = await waitFor(6000, '拿到签名');
        if (r) return true;
      }
      return false;
    };
    /** 点「暂停」后等扩展把手上的页收尾：条数连续两次不变（≈2.4s）才算稳定 */
    const settle = async (cappedMs = 15000) => {
      let prev = -1, stable = 0;
      const until = Date.now() + cappedMs;
      while (Date.now() < until) {
        const x = await st();
        const u = x.unique || 0;
        if (u === prev) stable++; else stable = 0;
        prev = u;
        if (stable >= 2) return x;
        await sleep(1200);
      }
      return await st();
    };

    log('点「开始采集」…');
    if (!(await clickPanel(/开始采集/))) throw new Error('面板上没找到「开始采集」按钮');

    let sig = await waitFor(20000, '拿到签名');
    if (!sig) {
      if (!(await nudgeCommentEntry())) {
        if (!(await nudgeScroll())) {
          log('仍未拿到签名：刷新页面后重试一次…');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.waitForSelector('#dts-collector-panel', { timeout: 20000 }).catch(() => null);
          await sleep(3000);
          await clickPanel(/开始采集/);
          sig = await waitFor(25000, '拿到签名（reload 后）');
        }
      }
    }

    // ---- 轮询：到量 / 采完 / 报错 / 超时 ----
    // sawSig：本轮是否真的拿到过页面签名。没拿到 = 扩展根本没发出评论请求，
    // 那 storage 里出现的东西只可能是上一轮残留 ⇒ 必须判失败，绝不能当成本轮结果。
    let sawSig = !!(sig && sig.hasSig);
    if (sawSig) log('已拿到页面签名（扩展能自己发评论请求了）');
    else if (sig) log('扩展已在采集（phase=' + sig.phase + '），继续观察是否拿到签名');
    let lastUnique = -1, stallSince = Date.now();
    let paused = false;
    let topCapLogged = false;
    while (rest() > 0 && !aborted()) {
      s = await st();
      const u = s.unique || 0;
      if (s.hasSig) sawSig = true;
      if (s.phase === 'error') throw new Error('扩展报错：' + (s.error || s.note || '(无详情)'));
      if (u !== lastUnique) { lastUnique = u; stallSince = Date.now(); }

      // max 只算「一级评论」：到量后如果还要二级回复，就继续让扩展补采。
      // 旧版不分阶段地 u >= max 就点暂停 —— 一级评论早就超过 max 的那种视频，
      // 一进回复阶段就被掐掉，回复永远是 0 条（报告里的实测正是如此）。
      if (u >= max) {
        if (wantReplies && s.phase === 'collecting') {
          if (!topCapLogged) {
            log('一级评论已到目标 ' + max + ' 条（当前 ' + u + ' 条），继续等二级回复补采…');
            topCapLogged = true;
          }
        } else {
          log('已到目标 ' + max + ' 条（当前 ' + u + ' 条），点「暂停」…');
          await clickPanel(/暂停/);
          paused = true;
          s = await settle();
          break;
        }
      }
      if (!wantReplies && s.phase === 'replies') {
        log('顶层评论采完（' + u + ' 条），按要求不等二级回复，点「暂停」…');
        await clickPanel(/暂停/);
        paused = true;
        s = await settle();
        break;
      }
      if (s.phase === 'done') { log('采集完成：' + u + ' 条'); break; }

      if (Date.now() - stallSince > 60000 && !['collecting', 'replies', 'waiting-sign'].includes(s.phase)) {
        log('60s 没动静（phase=' + s.phase + '），收工');
        break;
      }
      // 无进展收工：二级回复阶段的退避重试本来就会让条数长时间不动，
      // 所以那个阶段用宽松得多的上限（默认 900s，可配置），别刚进回复就收工。
      const stallLimit = s.phase === 'replies' ? replyNoProgressMs : 120000;
      if (Date.now() - stallSince > stallLimit) {
        log(Math.round(stallLimit / 1000) + 's 没有新评论（phase=' + s.phase + '），收工（当前 ' + u + ' 条）');
        break;
      }
      await sleep(1000);
    }

    if (aborted() && !paused) {
      log('调用方已取消，点「暂停」并落盘已采到的部分…');
      await clickPanel(/暂停/).catch(() => {});
      paused = true;
      s = await settle(8000);
    }

    const finalStatus = await st();
    const videoId = finalStatus.videoId || finalStatus.liveVideoId || vid;

    // 扩展侧实际用了几路（content.js 每次开始采集都会把 dts_settings_effective 写回 storage）
    const effLanes = await readEffectiveLanes();
    if (effLanes) log('扩展实际并发路数：' + effLanes.lanes + '（本次请求 ' + lanes + ' 路）');

    // ⑧ 取数据 + 剔除「开始前就有」的 cid（只交付本轮新采）
    const got = await readComments(videoId);
    const all = got.list;
    const fresh = beforeCids.size > 0 ? all.filter((c) => c && !beforeCids.has(String(c.cid))) : all;
    let title = got.title || '';
    log('扩展里本轮落库 ' + all.length + ' 条，剔除开始前就存在的 ' + (all.length - fresh.length) + ' 条，交付 ' + fresh.length + ' 条');

    if (!sawSig) {
      const why = '本轮从头到尾没拿到页面签名（' + (finalStatus.note || '评论区没能打开') + '），扩展没有真正发出评论请求；'
        + '为避免把上一轮残留当成本轮结果，本次不返回数据';
      log('❌ ' + why);
      return {
        ok: false, error: why, videoId: videoId || '', title, count: 0,
        csvPath: '', jsonPath: '', phase: String(finalStatus.phase || ''),
        note: String(finalStatus.note || ''), durationSec: Number(((Date.now() - started) / 1000).toFixed(1)),
        outDir, url: target, sample: [], extension: ext, paused,
      };
    }

    if (fresh.length === 0) {
      const why = '拿到了签名但没采到任何新评论（可能该视频评论已全部采过、或评论接口返回空）';
      log('❌ 没有本轮新数据：' + why);
      return {
        ok: false, error: why, videoId: videoId || '', title, count: 0,
        csvPath: '', jsonPath: '', phase: String(finalStatus.phase || ''),
        note: String(finalStatus.note || ''), durationSec: Number(((Date.now() - started) / 1000).toFixed(1)),
        outDir, url: target, sample: [], extension: ext, paused,
        extLanes: effLanes ? Number(effLanes.lanes) || 0 : 0,
      };
    }

    // ⑨ 落盘
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = path.join(outDir, `douyin-comments-${videoId || 'unknown'}-${stamp}`);
    const csvPath = base + '.csv';
    const jsonPath = base + '.json';
    fs.writeFileSync(csvPath, '\uFEFF' + toCsv(fresh), 'utf8');   // BOM：Excel 直接开中文
    fs.writeFileSync(jsonPath, JSON.stringify({
      videoId, title, url: target, collectedAt: new Date().toISOString(),
      count: fresh.length, phase: finalStatus.phase, note: finalStatus.note || '',
      extension: { dir: ext.dir, version: ext.version, source: ext.sourceWhy },
      freshOnly: true, comments: fresh,
    }, null, 2), 'utf8');

    const dur = ((Date.now() - started) / 1000).toFixed(1);
    log(`写盘完成：${fresh.length} 条（本轮新采）→ ${csvPath}`);

    return {
      ok: true, error: '', videoId, title, count: fresh.length, csvPath, jsonPath,
      phase: finalStatus.phase, paused, note: finalStatus.note || '',
      panel: finalStatus.panel, durationSec: Number(dur), outDir, url: target,
      extLanes: effLanes ? Number(effLanes.lanes) || 0 : 0,
      sample: fresh.slice(0, 5).map((c) => (c.user && c.user.nickname ? c.user.nickname + '：' : '') + cleanText(c.text)),
      extension: ext,
    };
  } finally {
    await close();
  }
}

export default { collectDouyinComments, videoIdFromUrl, toCsv, cleanText, DEFAULTS, installExtension, findExtensionSource, loginGate, SESSION_COOKIE_NAMES, acquireRunLock, clearStaleScriptCaches, readLaunchState, writeLaunchState };
