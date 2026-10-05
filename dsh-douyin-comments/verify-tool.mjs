// 插件自检（离线，不开浏览器）：
//   node verify-tool.mjs            只校验工具定义 + 「自动装扩展」的目录同步
//   node verify-tool.mjs --live <url>  再真跑一次采集（会开浏览器窗口）
//
// 校验点：
//   1) apply() 注册的工具名/参数/必填项/输出 schema 正确；
//   2) execute() 返回的对象键与 output.schema 完全一致（不多不少）；
//   3) installExtension() 真把自带扩展同步到 ~/.dsh/douyin-collector/extension 且版本对得上；
//   4) output.render 成功/失败两条路径都出人话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installExtension, findExtensionSource, DEFAULTS, loginGate, acquireRunLock, resolveOutDir, sessionWorkspaceCwd } from './collector.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ---------- 1) 注册定义 ----------
const registered = [];
const fakeCtx = {
  tools: { register: (def) => { registered.push(def); return () => {}; } },
  effect: () => {},
  logger: { info: () => {} },
};
const mod = await import(new URL('./index.js', import.meta.url).href);
check('插件 name 导出', mod.name === 'dsh-douyin-comments', String(mod.name));
check('inject = ["tools"]', Array.isArray(mod.inject) && mod.inject[0] === 'tools', JSON.stringify(mod.inject));
mod.apply(fakeCtx, {});
check('注册了 1 个工具', registered.length === 1, String(registered.length));

const def = registered[0];
check('工具名 = douyin_comments', def.name === 'douyin_comments', def.name);
// 注意：宿主会把插件里的参数 DSL **编译**成 JSON Schema（properties + required[]），
// 所以这里读的是编译后的形状，不是插件源码里的 `required: true`。
const paramKeys = Object.keys((def.parameters && def.parameters.properties) || {});
check('参数齐全', ['url', 'max', 'lanes', 'replies', 'clearBefore', 'timeoutMs', 'waitLoginSec', 'outDir', 'keepOpen'].every((k) => paramKeys.includes(k)), paramKeys.join(','));
const paramRequired = (def.parameters && def.parameters.required) || [];
check('唯一必填 = url', JSON.stringify(paramRequired) === JSON.stringify(['url']), JSON.stringify(paramRequired));
check('并发不安全', typeof def.isConcurrencySafe === 'function' && def.isConcurrencySafe() === false);

const schemaProps = Object.keys(def.output.schema.properties || {});
const schemaRequired = def.output.schema.required || [];
check('输出 schema 有 error/extensionVersion', schemaProps.includes('error') && schemaProps.includes('extensionVersion'), schemaProps.join(','));
check('输出 schema 全部必填', schemaRequired.length === schemaProps.length && schemaProps.every((k) => schemaRequired.includes(k)), `required=${schemaRequired.length}/${schemaProps.length}`);

// ---------- 2) render 两条路径 ----------
const failText = def.output.render({}, {
  ok: false, error: '本轮从头到尾没拿到页面签名', videoId: '', title: '', count: 0,
  csvPath: '', jsonPath: '', phase: 'waiting-sign', note: '没能自动找到评论入口', durationSec: 12,
  extensionVersion: '0.2.2', extensionInstalled: true, sample: [], lanes: 4,
}).map((x) => x.text).join('\n');
check('render 失败路径含原因', failText.includes('本轮从头到尾没拿到页面签名'), failText.slice(0, 60));
const okText = def.output.render({}, {
  ok: true, error: '', videoId: '123', title: '标题', count: 42, csvPath: 'a.csv', jsonPath: 'a.json',
  phase: 'paused', note: '', durationSec: 9.5, extensionVersion: '0.2.2', extensionInstalled: false, sample: ['甲：好看'], lanes: 4,
}).map((x) => x.text).join('\n');
check('render 成功路径含条数与路径', okText.includes('42 条') && okText.includes('a.csv'), okText.split('\n')[0]);

// ---------- 2b) 登录闸门：没登录就不许开始采集 ----------
const g1 = loginGate({ cookies: [{ name: 'sessionid', value: 'x' }], loginButton: false, mask: false });
check('已登录 → 不拦', g1.hasSession === true && g1.needLogin === false, JSON.stringify(g1));
const g2 = loginGate({ cookies: [], loginButton: true, mask: false });
check('未登录（页面有登录按钮）→ 拦下等扫码', g2.needLogin === true, JSON.stringify(g2));
const g3 = loginGate({ cookies: [{ name: 'sessionid', value: '' }], mask: true });
check('cookie 为空不算登录 → 拦下', g3.hasSession === false && g3.needLogin === true, JSON.stringify(g3));
const g4 = loginGate({ cookies: [{ name: 'passport_csrf_token', value: 'y' }, { name: 'odin_tt', value: 'z' }], loginButton: false, mask: false });
// 实测（2026-10-05）：未登录时抖音页面上经常连登录按钮/弹窗都探不到，只有 passport_csrf_token 之类
// 的匿名 cookie；判据必须是 cookie —— 只看 DOM 会漏判，然后就开始裸采、被限流。
check('只有匿名 cookie（DOM 也无信号）→ 照样拦下', g4.hasSession === false && g4.needLogin === true, JSON.stringify(g4));
const g5 = loginGate({ cookies: [{ name: 'sid_tt', value: 'x' }], loginButton: true, mask: true });
check('有登录 cookie 就放行（DOM 假信号不误拦）', g5.needLogin === false, JSON.stringify(g5));

const needLoginText = def.output.render({}, {
  ok: false, error: '未登录：没检测到抖音登录态', videoId: '', title: '', count: 0,
  csvPath: '', jsonPath: '', phase: 'need-login', note: '等待扫码登录', durationSec: 3,
  extensionVersion: '0.2.1', extensionInstalled: false, sample: [],
}).map((x) => x.text).join('\n');
check('need-login 的返回值会叫人扫码', needLoginText.includes('扫码'), needLoginText.split('\n')[0]);check('工具描述里交代了 need-login 怎么处理', /need-login/.test(String(def.description || '')), '');

// ---------- 2c) 输出目录：默认写进「当前会话的工作区」 ----------
const fakeExec = { agent: { session: { header: { cwd: 'D:\\proj\\demo' } } } };
check('取得到会话工作区（exec.agent.session.header.cwd）', sessionWorkspaceCwd(fakeExec) === 'D:\\proj\\demo', sessionWorkspaceCwd(fakeExec));
check('默认落到 <工作区>/douyin-comments', resolveOutDir({ exec: fakeExec }).replace(/\\/g, '/') === 'D:/proj/demo/douyin-comments', resolveOutDir({ exec: fakeExec }));
check('显式 outDir 优先于会话工作区', resolveOutDir({ explicit: 'D:\\mine', exec: fakeExec }) === 'D:\\mine', resolveOutDir({ explicit: 'D:\\mine', exec: fakeExec }));
check('没有会话工作区 → 退回全局目录', resolveOutDir({ exec: {} }) === DEFAULTS.outDir, resolveOutDir({ exec: {} }));
check('工具描述交代了「结果落在会话工作区」', /工作区/.test(String(def.description || '')));

// ---------- 2d) 插件设置：DSH「设置 → 插件 → dsh-douyin-comments」里的那张表单 ----------
// 机制：cordis 用 Config 校验/解析这个插件的 config；dsh-settings 的 schema(entry) 取
// fiber.runtime.Config，只把 meta.volatile 的字段放进可编辑表单（改完立即生效，不用重启），
// 保存走 configEditor.edit() 写进 profile patch。这里离线复刻它的关键几步。
const Cfg = mod.Config;
check('导出了 Config（设置表单靠它生成）', !!Cfg && 'toJSON' in Cfg && Cfg.type === 'object',
  Cfg ? `type=${Cfg.type} keys=${Object.keys(Cfg.dict || {}).join(',')}` : '没有 Config');
const cfgKeys = Object.keys((Cfg && Cfg.dict) || {});
check('设置项含 max/lanes/timeoutMs/waitLoginSec/clearBefore/replyLanes/replyThrottleSec/replyNoProgressSec',
  ['max', 'lanes', 'timeoutMs', 'waitLoginSec', 'clearBefore', 'replyLanes', 'replyThrottleSec', 'replyNoProgressSec']
    .every((k) => cfgKeys.includes(k)), cfgKeys.join(','));
const volKeys = cfgKeys.filter((k) => Cfg.dict[k].meta && Cfg.dict[k].meta.volatile === true);
check('设置项全部 volatile（改完立即生效、不用重启）', cfgKeys.length === volKeys.length && cfgKeys.length >= 8,
  `${volKeys.length}/${cfgKeys.length}: ${volKeys.join(',')}`);
let rebuiltCfg = null;
let rebuiltErr = '';
try {
  rebuiltCfg = new mod.Schema(Cfg.toJSON());   // = dsh-settings 的 plainSchema(): new Schema(schema.toJSON())
} catch (e) { rebuiltErr = String((e && e.message) || e); }
check('toJSON 往返后字段不丢（设置表单就是这么重建的）',
  !!rebuiltCfg && Object.keys(rebuiltCfg.dict || {}).length === cfgKeys.length,
  rebuiltErr || Object.keys((rebuiltCfg && rebuiltCfg.dict) || {}).join(','));
const setDefaults = { max: Cfg.dict.max.meta.default, lanes: Cfg.dict.lanes.meta.default, timeoutMs: Cfg.dict.timeoutMs.meta.default, waitLoginSec: Cfg.dict.waitLoginSec.meta.default };
check('设置里的出厂默认值 = 80000 / 4 / 1800000 / 180',
  setDefaults.max === 80000 && setDefaults.lanes === 4 && setDefaults.timeoutMs === 1800000 && setDefaults.waitLoginSec === 180,
  JSON.stringify(setDefaults));
const cfgValid = Cfg['~standard'].validate(undefined);
check('没配过也能开（validate(undefined) 落到默认值）', !('issues' in cfgValid) && !!cfgValid.value && 'lanes' in cfgValid.value,
  'issues' in cfgValid ? JSON.stringify(cfgValid.issues) : JSON.stringify(Object.fromEntries(Object.entries(cfgValid.value).map(([k, v]) => [k, v && typeof v.get === 'function' ? v.get() : v]))));
const cfgBad = Cfg['~standard'].validate({ lanes: 99 });
check('越界值被 schema 挡下（表单有 min/max）', 'issues' in cfgBad, 'issues' in cfgBad ? cfgBad.issues[0].message : '居然放过 99');

// volatile 字段会被 cordis 包成「只有 get」的只读引用：execute() 必须现读，不能缓存快照。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const vbox = (v) => ({ get: () => v, [VOLATILE_WRITE]: (next) => { v = next; } });
let lanesBox = 2;
const fakeCfg = { max: vbox(80000), lanes: { get: () => lanesBox, [VOLATILE_WRITE]: (n) => { lanesBox = n; } }, timeoutMs: vbox(1800000), waitLoginSec: vbox(0) };
const s1 = mod.readSettings(fakeCfg);
check('readSettings 读的是 volatile 当前值', s1.max === 80000 && s1.lanes === 2 && s1.waitLoginSec === 0, JSON.stringify(s1));
lanesBox = 7;
check('设置里改完不用重启：同一份 config 现读就变', mod.readSettings(fakeCfg).lanes === 7, String(mod.readSettings(fakeCfg).lanes));
check('readSettings 把路数钳在 1..8', mod.readSettings({ lanes: vbox(99) }).lanes === 8 && mod.readSettings({ lanes: vbox(0) }).lanes === 1,
  `${mod.readSettings({ lanes: vbox(99) }).lanes} / ${mod.readSettings({ lanes: vbox(0) }).lanes}`);
check('插件描述里交代了设置入口', /设置/.test(String(def.description || '')) && /lanes|并发路数/.test(String(def.description || '')));
check('输出 schema 里有 lanes（能看出实际用了几路）', schemaProps.includes('lanes'), schemaProps.join(','));
check('出厂默认 max = 80000（= 扩展评论池上限）', DEFAULTS.max === 80000, String(DEFAULTS.max));
check('出厂默认并发路数 = 4（实测甜点）', DEFAULTS.lanes === 4, String(DEFAULTS.lanes));
check('出厂默认超时 = 30 分钟（够采几万条）', DEFAULTS.timeoutMs === 1800000, String(DEFAULTS.timeoutMs));
check('出厂默认不清空（保住扩展的断点续采）', DEFAULTS.clearBefore === false, String(DEFAULTS.clearBefore));
check('回复类出厂默认：并发 0=跟扩展内置、限流 0=跟内置、无进展 900s',
  DEFAULTS.replyLanes === 0 && DEFAULTS.replyThrottleSec === 0 && DEFAULTS.replyNoProgressSec === 900,
  `${DEFAULTS.replyLanes} / ${DEFAULTS.replyThrottleSec} / ${DEFAULTS.replyNoProgressSec}`);

// ---------- 2e) 报告问题二：三个采集侧缺陷（Mac 报告 /Users/ze 的 runs） ----------
const collSrc = fs.readFileSync(new URL('./collector.mjs', import.meta.url), 'utf8');
check('缺陷1 修好：max 只在一级评论阶段算数（切到 replies 不再当场点暂停）',
  /wantReplies && s\.phase === 'collecting'/.test(collSrc), '');
check('缺陷2 修好：replies 阶段用宽松的无进展上限，不再被 120s 收工',
  /s\.phase === 'replies' \? replyNoProgressMs : 120000/.test(collSrc), '');
check('缺陷3 修好：清空改成可选（默认走 cid 差集，保留断点续采）',
  /o\.clearBefore === undefined \? !!DEFAULTS\.clearBefore : !!o\.clearBefore/.test(collSrc)
  && /只交付本轮新采/.test(collSrc), '');
check('插件把回复限流设置推给扩展（dts_settings 带 replyThrottleMaxWaitMs）',
  /replyThrottleMaxWaitMs/.test(collSrc) && /dts_settings/.test(collSrc), '');
check('品牌版 Chrome 会被识别（137+ 忽略 --load-extension，要提前警告）',
  /function isBrandedBrowser/.test(collSrc) && /load-extension/.test(collSrc), '');
check('命令行扩展兜底：忽略 Playwright 默认的 --disable-extensions',
  /ignoreDefaultArgs: \['--disable-extensions'\]/.test(collSrc), '');
check('扩展缓存目录跨平台（mac ~/Library/Caches/ms-playwright、linux ~/.cache）',
  /Library', 'Caches', 'ms-playwright'/.test(collSrc) && /\.cache/.test(collSrc), '');
check('playwright-core 的查找覆盖各平台全局目录（含便携 node 的 node_global、nvm、NODE_PATH）',
  /node_global/.test(collSrc) && /nvm/.test(collSrc) && /NODE_PATH/.test(collSrc) && /require\.resolve\(n, \{ paths/.test(collSrc), '');

// ---------- 2f) 客户端半身：设置 → 插件 那一行的「配置」按钮靠它 ----------
// 宿主侧 Config 只让设置数据存在（dsh-settings 的 schema/describe 会认它），
// 但入口要由客户端插件注册 plugins.row.config（key = <包名>#<row id>）才出现。
const pkgManifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const clientEntry = pkgManifest.exports && pkgManifest.exports['./client'];
check('package.json 声明了 dsh.client（platform=web）并导出 ./client',
  !!(pkgManifest.dsh && pkgManifest.dsh.client) && pkgManifest.dsh.client.platform === 'web' && typeof clientEntry === 'string',
  JSON.stringify((pkgManifest.dsh && pkgManifest.dsh.client) || null) + ' exports["./client"]=' + String(clientEntry));
const clientFile = path.resolve(here, String(clientEntry || '').replace(/^\.\//, ''));
const clientSrc = fs.existsSync(clientFile) ? fs.readFileSync(clientFile, 'utf8') : '';
check('客户端 bundle 文件存在', clientSrc !== '', clientFile);
check('bundle 用宿主模块表的 classic-script 格式（window.__ModuleLoader__.load + factory）',
  /window\.__ModuleLoader__\.load\(/.test(clientSrc) && /factory:/.test(clientSrc), '');
const clientRequires = [...clientSrc.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const SEEDS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit']);
check('只 require 平台种子模块（其它一律解析不到）',
  clientRequires.length > 0 && clientRequires.every((r) => SEEDS.has(r)), clientRequires.join(', '));
check('注册 plugins.row.config，key = <包名>#<insert id>',
  /plugins\.row\.config/.test(clientSrc) && /ROW_KEY = PACKAGE \+ '#' \+ NS/.test(clientSrc) && /var NS = 'douyin-comments'/.test(clientSrc), '');
check('同时注册 plugins.bundle.config（bundle 自己的配置位）', /plugins\.bundle\.config/.test(clientSrc));
check('通过 configForms 读写设置（getSnapshot/subscribe/set）',
  /configForms/.test(clientSrc) && /getSnapshot\(\)/.test(clientSrc) && /\.set\(/.test(clientSrc), '');
check('configForms 走嵌套 inject（缺了也不至于整个插件不挂载）',
  /exports\.inject = \['slots'\]/.test(clientSrc) && /ctx\.inject\(\['configForms'\]/.test(clientSrc), '');

// 真把 bundle 执行一遍（伪造 window.__ModuleLoader__ / react / ctx）：
// 客户端半身要是语法或运行期出错，Web 端启动会炸，所以这里必须离线跑通。
let registration = null;
const fakeReact = {
  createElement: () => ({}),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};
try {
  new Function('window', clientSrc)({ __ModuleLoader__: { load: (r) => { registration = r; } } });
} catch (e) { registration = { error: String((e && e.message) || e) }; }
check('bundle 执行时把自己注册进模块表（id = 包名）',
  !!registration && registration.id === 'dsh-douyin-comments' && typeof registration.factory === 'function',
  registration && registration.error ? registration.error : String(registration && registration.id));
let clientMod = null;
let modErr = '';
try {
  clientMod = registration.factory((spec) => {
    if (spec === 'react') return fakeReact;
    throw new Error('客户端 bundle require 了表里没有的模块：' + spec);
  });
} catch (e) { modErr = String((e && e.message) || e); }
check('factory 返回 name / inject / apply',
  !modErr && clientMod && clientMod.name === 'dsh-douyin-comments' && Array.isArray(clientMod.inject) && typeof clientMod.apply === 'function',
  modErr || (clientMod ? 'name=' + clientMod.name + ' inject=' + JSON.stringify(clientMod.inject) : ''));
const slotRegs = [];
let pageRender = '';
if (!modErr && clientMod && typeof clientMod.apply === 'function') {
  const controller = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { max: 80000, lanes: 4, timeoutMs: 1800000, waitLoginSec: 180, clearBefore: false, replyLanes: 4, replyThrottleSec: 10, replyNoProgressSec: 900 } }),
    subscribe: () => () => {},
    set: () => Promise.resolve(true),
  };
  const fakeScoped = {
    slots: {
      inject: (name, fn) => { slotRegs.push('inject:' + name); return fn(); },
      register: (opts, render) => { slotRegs.push(String(opts.name) + '|' + String(opts.key)); return () => {}; },
    },
    configForms: {
      get: () => controller,
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'douyin-comments' }] } }) }),
    },
  };
  try {
    clientMod.apply({ inject: (services, cb) => cb(fakeScoped) });
    pageRender = 'apply ok';
  } catch (e) { pageRender = 'apply 抛异常：' + String((e && e.message) || e); }
}
check('apply 注册了 plugins.row.config（key=<包名>#<insert id>）与 plugins.bundle.config',
  slotRegs.includes('plugins.row.config|dsh-douyin-comments#douyin-comments') && slotRegs.includes('plugins.bundle.config|dsh-douyin-comments'),
  pageRender + ' · ' + slotRegs.filter((r) => !r.startsWith('inject')).join(', '));


// ---------- 3) 自动装扩展（真同步） ----------
const src = findExtensionSource();
check('找到扩展源目录', !!src, src ? `${src.why}: ${src.dir}` : '无');
const ext = installExtension({ log: (l) => console.log('   [ext]', l) });
const targetManifest = JSON.parse(fs.readFileSync(path.join(ext.dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
check('安装目录有 manifest.json', fs.existsSync(path.join(ext.dir, 'manifest.json')), ext.dir);
check('安装目录版本 = 源版本', targetManifest.version === ext.version, `target=${targetManifest.version} src=${ext.version}`);
check('六大文件齐全', ['manifest.json', 'hook.js', 'content.js', 'background.js', 'panel.css'].every((f) => fs.existsSync(path.join(ext.dir, f))), ext.files.join(','));
const stamp = path.join(DEFAULTS.home, 'extension.installed.json');
check('写了安装戳', fs.existsSync(stamp), stamp);
check('哈希 16 位', /^[0-9a-f]{16}$/.test(ext.hash), ext.hash);

// ---------- 3a) 扩展侧：真的会读「并发路数」设置 ----------
const contentSrc = fs.readFileSync(path.join(ext.dir, 'content.js'), 'utf8');
check('扩展读运行时设置 dts_settings 且保留内置 MAX_LANES 兜底',
  /loadRuntimeSettings/.test(contentSrc) && /dts_settings/.test(contentSrc) && /MAX_LANES/.test(contentSrc));
check('一轮并发用运行时路数（lanesWanted），不是写死的常量',
  /lanes = Math\.min\(lanesWanted, MAX_PAGES - pages\)/.test(contentSrc));
check('扩展把实际用的路数写回 dts_settings_effective（插件据此回报）', contentSrc.includes('dts_settings_effective'));
// 报告问题二·缺陷4: 回复限流预算写死 10s，撞上「刚轰完列表接口」的拒绝窗口
check('回复限流预算、并发、间隔都能被 dts_settings 覆盖（不再写死）',
  /RS\.replyThrottleMaxWaitMs/.test(contentSrc) && /RS\.replyLanes/.test(contentSrc) && /RS\.replyGapMs/.test(contentSrc)
  && /RS\.replyWarmupMs/.test(contentSrc),
  ['replyThrottleMaxWaitMs', 'replyLanes', 'replyGapMs', 'replyWarmupMs'].filter((k) => contentSrc.includes('RS.' + k)).join(','));
check('内置默认值没被改坏（不装插件单用扩展还是原行为）',
  /const REPLY_LANES = 4;/.test(contentSrc) && /const REPLY_GAP_MS = 600;/.test(contentSrc)
  && /const REPLY_THROTTLE_MAX_WAIT_MS = 10 \* 1000;/.test(contentSrc),
  (contentSrc.match(/const REPLY_LANES = \d+;.*/) || [''])[0]);
check('装出来的扩展 ≥ 0.2.3（0.2.2 不认识回复限流设置）',
  /^0\.2\.(3|[4-9]|\d\d+)$/.test(String(targetManifest.version)) || Number(String(targetManifest.version).split('.')[1]) >= 3,
  targetManifest.version);

// ---------- 3a-2) 面板自己的「设置」入口（v0.2.4 文字按钮 → v0.2.5 标题栏齿轮） ----------
// 用户要的是**扩展面板上的设置按键**（独立装的扩展没有 DSH 设置页），所以入口必须在 content.js 里。
// m02481: 「设置做成齿轮图标、放在「—」左边」+「可调参数没有 max」→ 齿轮 + 第一项标签带 max。
const cssSrc = fs.readFileSync(path.join(ext.dir, 'panel.css'), 'utf8');
check('面板设置入口是齿轮按钮，可写 chrome.storage.local.dts_user_settings',
  /mkBtn\('⚙'/.test(contentSrc) && contentSrc.includes("'dts-btn-gear'")
  && contentSrc.includes("USER_SETTINGS_KEY = 'dts_user_settings'")
  && contentSrc.includes('chrome.storage.local.set({ dts_user_settings: st }'));
check('齿轮在标题栏右侧、排在「—」收起按钮左边（同一行 .dts-tools 里）',
  /tools\.appendChild\(gear\);[\s\S]{0,220}?tools\.appendChild\(mkBtn\('—'/.test(contentSrc)
  && /var gear = mkBtn\('⚙'/.test(contentSrc));
check('齿轮有样式（.dts-btn-gear，透明底、单字符窄按钮）', /\.dts-btn-gear\b/.test(cssSrc));
const iUserPick = contentSrc.indexOf('if (u && u[key] !== undefined');
const iPluginPick = contentSrc.indexOf('if (s && s[key] !== undefined');
check('面板设置优先于 DSH 插件下发的 dts_settings（逐项 pick：面板 > 插件 > 内置）',
  iUserPick > 0 && iPluginPick > iUserPick,
  `user@${iUserPick} plugin@${iPluginPick}`);
check('可调参数里有 max（第一项标签「目标条数 max」），到量自动收工且不掐二级回复',
  /maxCount', label: '目标条数 max'/.test(contentSrc)
  && /RS\.maxCount > 0 && seen\.size >= RS\.maxCount/.test(contentSrc)
  && /resetSettings/.test(contentSrc));
check('浮层里有「当前：…」生效值一行（v0.2.5 从按钮行移入浮层）',
  /'当前：' \+ settingsSummaryText\(\)/.test(contentSrc) && /refs\.summary = sbox\.cur;/.test(contentSrc));
check('设置浮层有样式（.dts-settings / .dts-input / .dts-hidden）',
  /\.dts-settings\b/.test(cssSrc) && /\.dts-input\b/.test(cssSrc) && /\.dts-hidden\b/.test(cssSrc));
check('浮层打开时面板撑高、且浮层子项不被压扁（修「当前：…」被 flex 挤成一条缝）',
  contentSrc.includes("classList.add('dts-settings-open')") && /\.dts-settings-open\b/.test(cssSrc)
  && /\.dts-settings > \*\s*\{[\s\S]{0,90}?flex: 0 0 auto/.test(cssSrc));

// ---------- 3b) DSH 兼容性预检 ----------
// 血案：peerDependencies 里写 `@deepseek-ai/dsh-tools: ^0.1.5-rc.3`，而运行时是 0.2.0-rc.2
// ⇒ DSH 启动时判定 incompatible，**静默跳过整个 bundle**（工具永远不出现，重启多少次都没用），
//    而它的提示文案又写着「retry the installation or restart dsh」，于是所有人都在让用户重启。
const manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const dshPeers = Object.entries(manifest.peerDependencies || {})
  .filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'));
const narrowPeers = dshPeers.filter(([, range]) => !/^\s*(>=|\*)/.test(String(range)));
check('dsh-* peer 用宽范围（>= / *），不用 ^ ~ 卡死运行时', narrowPeers.length === 0,
  (narrowPeers.length ? '收窄了：' + JSON.stringify(Object.fromEntries(narrowPeers)) + '｜' : '')
  + (dshPeers.length ? dshPeers.map(([n, r]) => `${n}@${r}`).join(', ') : '没有 dsh-* peer'));

const loadAppBoot = async () => {
  const tried = [];
  try { return await import('@deepseek-ai/dsh-app-boot'); } catch { tried.push('@deepseek-ai/dsh-app-boot'); }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')];
  if (process.argv[1]) {
    candidates.push(path.join(path.resolve(path.dirname(process.argv[1]), '..'), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'));
  }
  for (const file of candidates) {
    tried.push(file);
    try { if (fs.existsSync(file)) return await import(pathToFileURL(file).href); } catch { /* 继续 */ }
  }
  return { tried };
};
const boot = await loadAppBoot();
if (typeof boot.evaluatePluginCompatibility === 'function') {
  const issue = boot.evaluatePluginCompatibility(manifest);
  check('DSH 兼容性预检通过（peer 范围不排斥当前 dsh）', issue === undefined,
    issue === undefined
      ? `runtime=${boot.getDshRuntimeVersion()}`
      : `不兼容：${JSON.stringify(issue.peers)} @ dsh ${issue.runtimeVersion}（会被静默跳过，重启无效）`);
} else {
  console.log('ℹ️ 跳过 DSH 兼容性预检（本地找不到 @deepseek-ai/dsh-app-boot，试过：' + boot.tried.join('、') + '）');
}

// ---------- 3c) 采集锁：同一个 DSH_HOME 下装了多个 profile（desktop + web）时只能有一个采集 ----------
const lockPath = path.join(DEFAULTS.home, 'collector.lock');
fs.mkdirSync(DEFAULTS.home, { recursive: true });
const savedLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
try {
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: '2000-01-01T00:00:00Z', profile: 'ghost' }));
  const release = acquireRunLock({ log: () => {}, url: 'verify' });
  check('陈旧锁（进程早没了）→ 接管', JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid === process.pid, lockPath);
  release();
  check('释放后锁文件被删掉', !fs.existsSync(lockPath));

  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), profile: 'other-profile' }));
  let blocked = '';
  try { acquireRunLock({ log: () => {}, url: 'verify' }); } catch (e) { blocked = String(e && e.message); }
  check('别的活进程持锁 → 拒绝并说清原因', /已经有一个采集在跑/.test(blocked), blocked.slice(0, 70));
  child.kill();
} finally {
  if (savedLock === null) fs.rmSync(lockPath, { force: true });
  else fs.writeFileSync(lockPath, savedLock);
}

// ---------- 4) 可选：真跑一次 ----------
const liveIdx = process.argv.indexOf('--live');
let liveOk = true;
if (liveIdx > -1) {
  const url = process.argv[liveIdx + 1];
  if (!url) { console.error('--live 后面要跟视频链接'); process.exit(1); }
  const max = Number(process.env.DTS_MAX || 60);
  console.log(`\n=== 真跑：url=${url} max=${max} ===`);
  const value = await def.execute({ url, max }, { signal: new AbortController().signal, callId: 'verify' });
  console.log(JSON.stringify({ ...value, sample: value.sample }, null, 1));
  const keys = Object.keys(value).sort();
  check('execute 返回键与 schema 一致', JSON.stringify(keys) === JSON.stringify([...schemaProps].sort()), keys.join(','));
  check('execute ok=true 且 count>0', value.ok === true && value.count > 0, `ok=${value.ok} count=${value.count}`);
  check('CSV/JSON 真存在', fs.existsSync(value.csvPath) && fs.existsSync(value.jsonPath), `${value.csvPath} | ${value.jsonPath}`);
  if (fs.existsSync(value.csvPath)) {
    const csv = fs.readFileSync(value.csvPath, 'utf8');
    const lines = csv.split('\r\n').filter(Boolean).length - 1;
    check('CSV 行数 = count', lines === value.count, `rows=${lines} count=${value.count}`);
    check('CSV 带 BOM', csv.charCodeAt(0) === 0xFEFF);
  }
  liveOk = value.ok === true && value.count > 0;
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length === 0 ? '全绿' : '有失败'}：${results.length - bad.length}/${results.length}`);
process.exit(bad.length === 0 && liveOk ? 0 : 1);
