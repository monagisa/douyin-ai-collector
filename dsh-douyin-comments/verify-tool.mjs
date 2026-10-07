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
import { installExtension, findExtensionSource, DEFAULTS, loginGate, acquireRunLock, resolveOutDir, sessionWorkspaceCwd, clearStaleScriptCaches, readLaunchState, writeLaunchState, extensionIdFromPath } from './collector.mjs';

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
check('设置项含 max/lanes/timeoutMs/waitLoginSec/clearBefore/replyLanes/replyGlobalGapMs/replyThrottleSec/replyNoProgressSec',
  ['max', 'lanes', 'timeoutMs', 'waitLoginSec', 'clearBefore', 'replyLanes', 'replyGlobalGapMs', 'replyThrottleSec', 'replyNoProgressSec']
    .every((k) => cfgKeys.includes(k)), cfgKeys.join(','));
const volKeys = cfgKeys.filter((k) => Cfg.dict[k].meta && Cfg.dict[k].meta.volatile === true);
check('设置项全部 volatile（改完立即生效、不用重启）', cfgKeys.length === volKeys.length && cfgKeys.length >= 9,
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
check('设置里的出厂默认值 = 80000 / 3（顶层错峰多路，1 = 老单路）/ 1800000 / 180',
  setDefaults.max === 80000 && setDefaults.lanes === 3 && setDefaults.timeoutMs === 1800000 && setDefaults.waitLoginSec === 180,
  JSON.stringify(setDefaults));
const cfgValid = Cfg['~standard'].validate(undefined);
check('没配过也能开（validate(undefined) 落到默认值）', !('issues' in cfgValid) && !!cfgValid.value && 'lanes' in cfgValid.value,
  'issues' in cfgValid ? JSON.stringify(cfgValid.issues) : JSON.stringify(Object.fromEntries(Object.entries(cfgValid.value).map(([k, v]) => [k, v && typeof v.get === 'function' ? v.get() : v]))));
const cfgBad = Cfg['~standard'].validate({ lanes: 99 });
check('越界值被 schema 挡下（表单有 min/max）', 'issues' in cfgBad, 'issues' in cfgBad ? cfgBad.issues[0].message : '居然放过 99');

// 2d-1) 回归护栏（2026-10-06 发布验收踩过）：全新 profile 里 pnpm 可能给这个插件装一份**旧版**
// @deepseek-ai/schemastery（实测 3.18.2，没有 Schema.prototype.volatile）。若 Config 直接链式
// .volatile()，插件 import 会整个抛 TypeError: ...volatile is not a function，dsh 只打印
// 「1 entry did not activate / failed to import」，工具直接消失（用户看到的是「插件装了但没工具」）。
// 所以两件事都要保住：① 字段走 vol() 兜底；② loadSchema() 先拿宿主那份、裸说明符放最后。
const indexSrc = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const indexCode = indexSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const directVolatile = indexCode.match(/\.volatile\(\)/g) || [];
check('Config 走 vol() 兜底，不直接链式 .volatile()（旧版 schemastery 会让插件 import 崩）',
  directVolatile.length === 1 && /if \(schema && typeof schema\.volatile === 'function'\) return schema\.volatile\(\);/.test(indexCode),
  `非注释代码里 .volatile() 出现 ${directVolatile.length} 次（应只在 vol() 兜底里 1 次）`);
const hostCandAt = indexSrc.indexOf("'profiles', 'node_modules'");
const bareImportAt = indexSrc.indexOf("await import('@deepseek-ai/schemastery')");
check('loadSchema 先试宿主副本、最后才裸说明符（插件自己的 node_modules 里可能是旧版）',
  hostCandAt > 0 && bareImportAt > hostCandAt,
  `宿主候选@${hostCandAt} / 裸说明符@${bareImportAt}`);

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
check('出厂默认顶层路数 = 3（v0.2.15 错峰多路；1 = 老单路）', DEFAULTS.lanes === 3, String(DEFAULTS.lanes));
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
check('collector 日志如实报「顶层列表实际路数」并把扩展的 lanesNote（含降路原因）带出来',
  /顶层列表实际路数/.test(collSrc) && /effLanes\.lanesNote/.test(collSrc), '');
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

// ---------- 3a) 扩展侧：顶层列表「错峰多路」（v0.2.15），1 路 = 老单路 ----------
// 2026-10-06 真机实测（视频 7692405235813272867）：4 路**同时**发只有 492 条唯一一级评论
// （c50/c100/c150 拿到同一页），单路串行 714~744 条 ⇒ 0.2.12 固定单路。
// 2026-10-07 复现并量化（临时探针 _lanes_probe.mjs / _lanes_probe2.mjs）：
//   · 同时发 4 个 cursor：Σ200 条、去重后只有 56 条，next 字段还对（静默少采）；
//   · 错峰 200ms / 500ms：唯一 200/200；
//   · 扫完整个列表（21 页）：单路含 400ms 间隔 15.79s vs 错峰 4 路 7.72s，唯一 907 vs 912。
// 所以 v0.2.15 改成错峰多路（默认 3 路），并加「两路同页 ⇒ 当轮降回单路」兜底。
const contentSrc = fs.readFileSync(path.join(ext.dir, 'content.js'), 'utf8');
check('扩展读运行时设置 dts_settings 且保留内置 MAX_LANES 兜底',
  /loadRuntimeSettings/.test(contentSrc) && /dts_settings/.test(contentSrc) && /MAX_LANES/.test(contentSrc));
check('顶层列表错峰多路：内置默认 3 路 + 每路错峰 200ms + 硬上限 8',
  /const MAX_LANES = 3;/.test(contentSrc) && /const LANE_STAGGER_MS = 200;/.test(contentSrc)
  && /const LANES_HARD_MAX = 8;/.test(contentSrc));
check('一轮按 laneBudget 组 cursor 并逐路错峰发（cursor + i*COUNT / sleep LANE_STAGGER_MS）',
  /cursors\.push\(cursor \+ i \* COUNT\)/.test(contentSrc)
  && /await sleep\(LANE_STAGGER_MS \+ Math\.round\(Math\.random\(\) \* 60\)\)/.test(contentSrc)
  && !/var cursors = \[cursor\];/.test(contentSrc),
  (contentSrc.match(/var lanes = [^\n]*/) || [''])[0]);
check('单路礼貌间隔 400 → 150ms（单路模式每轮最小间隔）',
  /const MIN_INTERVAL_MS = 150;/.test(contentSrc));
check('合并兜底：两路返回同一页 ⇒ 当轮降回单路，并写进 effective 的 lanesNote',
  /var mergedLanes = false;/.test(contentSrc) && /String\(ai\[m\]\.cid\) !== String\(bi\[m\]\.cid\)/.test(contentSrc)
  && /laneBudget = 1;/.test(contentSrc) && contentSrc.includes('发现两路返回了同一页')
  && /effSettings\.lanes = 1;/.test(contentSrc) && contentSrc.includes('writeEffective'));
check('多路时「某路越界返回空页」不算触底（anyLaneHasMore 修正 laneEnd）',
  /var anyLaneHasMore = false;/.test(contentSrc)
  && /if \(laneEnd && anyLaneHasMore\) laneEnd = false;/.test(contentSrc));
check('laneShort 触底保护同时把 laneBudget 降回 1（下一轮起单路收尾）',
  /if \(laneShort\) \{\s*\n\s*laneBudget = 1;/.test(contentSrc));
check('源码里留着实测依据（静默少给的 56 条 + 2.04× / 15.79s vs 7.72s）',
  contentSrc.includes('56') && contentSrc.includes('15.79') && contentSrc.includes('7.72')
  && contentSrc.includes('错峰'));
check('dts_settings_effective 如实写 lanes / lanesWanted / lanesNote（被降路时就地改写）',
  /lanes: lanesWanted,/.test(contentSrc) && /lanesWanted: lanesWanted,/.test(contentSrc)
  && contentSrc.includes('lanesNote'));
check('面板设置摘要如实写「顶层 N 路错峰」（不再显示「已停用」）',
  contentSrc.includes("'顶层 ' + (RS.lanes > 1 ? RS.lanes + ' 路错峰（'") && contentSrc.includes('顶层并发路数')
  && !contentSrc.includes('并发路数（已停用）'));
check('扩展把实际用的路数写回 dts_settings_effective（插件据此回报）', contentSrc.includes('dts_settings_effective'));
// 报告问题二·缺陷4: 回复限流预算写死 10s，撞上「刚轰完列表接口」的拒绝窗口
check('回复限流预算、并发、间隔都能被 dts_settings 覆盖（不再写死）',
  /RS\.replyThrottleMaxWaitMs/.test(contentSrc) && /RS\.replyLanes/.test(contentSrc) && /RS\.replyGapMs/.test(contentSrc)
  && /RS\.replyWarmupMs/.test(contentSrc),
  ['replyThrottleMaxWaitMs', 'replyLanes', 'replyGapMs', 'replyWarmupMs'].filter((k) => contentSrc.includes('RS.' + k)).join(','));
check('内置默认：回复并发 4、间隔 600ms、等窗口总预算 120 秒（v0.2.14；面板可设回 10 秒）',
  /const REPLY_LANES = 4;/.test(contentSrc) && /const REPLY_GAP_MS = 600;/.test(contentSrc)
  && /const REPLY_THROTTLE_MAX_WAIT_MS = 120 \* 1000;/.test(contentSrc),
  (contentSrc.match(/const REPLY_LANES = \d+;.*/) || [''])[0]);
check('装出来的扩展 ≥ 0.2.3（0.2.2 不认识回复限流设置）',
  /^0\.2\.(3|[4-9]|\d\d+)$/.test(String(targetManifest.version)) || Number(String(targetManifest.version).split('.')[1]) >= 3,
  targetManifest.version);

// ---------- 3a-3) AI 桥（v0.2.6）：douyin-mcp / DSH 插件可通过桥命令下发采集设置 ----------
// douyin-mcp v0.3.0 的 ai_get_settings / ai_set_settings / ai_start_collect{max,lanes,…}
// 全靠这些桥命令；扩展副本里缺了就只剩「开始/暂停」能用。
const bgSrc = fs.readFileSync(path.join(ext.dir, 'background.js'), 'utf8');
check('桥命令 get_settings / set_settings（写 dts_settings，可 clear 恢复默认）',
  /case 'get_settings'/.test(bgSrc) && /case 'set_settings'/.test(bgSrc)
  && bgSrc.includes("KEY_RUNTIME_SETTINGS = 'dts_settings'")
  && bgSrc.includes("KEY_USER_SETTINGS = 'dts_user_settings'")
  && /case 'set_settings'[\s\S]{0,400}?args\.clear/.test(bgSrc));
check('start_collect 支持带 settings（先写 dts_settings 再触发开始）',
  /case 'start_collect'[\s\S]{0,700}?args\.settings/.test(bgSrc) && /clampSettings/.test(bgSrc));
check('status 回包带设置快照（AI 一眼看到当前生效设置）', /settings: await readSettingsSnapshot\(\)/.test(bgSrc));
check('设置项硬上限与 content.js 同源（七项都在，含 maxCount / replyGlobalGapMs / replyThrottleMaxWaitMs）',
  ['maxCount', 'lanes', 'replyLanes', 'replyGlobalGapMs', 'replyGapMs', 'replyWarmupMs', 'replyThrottleMaxWaitMs']
    .every((k) => bgSrc.includes(k + ': { min:')),
  'SETTINGS_FIELDS');
check('start_collect 的 appliedSettings 会透到桥回包（拍平 result 时不能丢）',
  /body\.result = \{ status: out\.status, tabId: out\.tabId, tabUrl: out\.tabUrl \};[\s\S]{0,200}?body\.result\.appliedSettings = out\.appliedSettings/.test(bgSrc));
check('装出来的扩展 ≥ 0.2.6（桥的设置命令从 0.2.6 起）',
  /^0\.2\.(6|[7-9]|\d\d+)$/.test(String(targetManifest.version)) || Number(String(targetManifest.version).split('.')[1]) >= 6,
  targetManifest.version);

// ---------- 3a-4) 扩展更新后，别让浏览器继续跑 profile 里缓存的旧扩展脚本 ----------
// 实测坑（2026-10-05）：改了 background.js 后新开的浏览器里 executeAiCommand 还是旧代码
// （AI 桥回 UNKNOWN_COMMAND），要清掉 profile 的 Default/Code Cache 与 Service Worker/ScriptCache 才生效。
const collectorSrc = fs.readFileSync(path.join(here, 'collector.mjs'), 'utf8');
check('导出 clearStaleScriptCaches / readLaunchState / writeLaunchState',
  typeof clearStaleScriptCaches === 'function' && typeof readLaunchState === 'function' && typeof writeLaunchState === 'function');
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-cache-'));
fs.mkdirSync(path.join(tmpProfile, 'Default', 'Code Cache', 'js'), { recursive: true });
fs.mkdirSync(path.join(tmpProfile, 'Default', 'Service Worker', 'Database'), { recursive: true });
fs.writeFileSync(path.join(tmpProfile, 'Default', 'Code Cache', 'js', 'x'), 'x');
fs.writeFileSync(path.join(tmpProfile, 'Default', 'Service Worker', 'Database', 'y'), 'y');
fs.writeFileSync(path.join(tmpProfile, 'Default', 'Cookies'), 'login-state');
const clearedDirs = clearStaleScriptCaches(tmpProfile);
check('清缓存真的删掉 Code Cache 与整个 Service Worker（含注册库 Database）',
  clearedDirs.length === 2
  && !fs.existsSync(path.join(tmpProfile, 'Default', 'Code Cache'))
  && !fs.existsSync(path.join(tmpProfile, 'Default', 'Service Worker')),
  clearedDirs.map((p) => path.relative(tmpProfile, p)).join('、'));
check('清缓存不碰登录态（Cookies 还在）',
  fs.existsSync(path.join(tmpProfile, 'Default', 'Cookies')));
fs.rmSync(tmpProfile, { recursive: true, force: true });
check('扩展 hash 变了就判定 extChanged（没记录也算变）',
  /const launchState = readLaunchState\(\);/.test(collectorSrc)
  && /const extChanged = launchState\.hash !== ext\.hash;/.test(collectorSrc));
check('extChanged 时先清缓存再启动浏览器',
  /if \(extChanged\) \{[\s\S]{0,300}?clearStaleScriptCaches\(profile, \{ log \}\)/.test(collectorSrc));
check('extChanged 时接了旧窗口也关掉重开（旧窗口跑的是旧代码）',
  /if \(running && extChanged\) \{[\s\S]{0,400}?running\.browser\.close\(\)[\s\S]{0,200}?running = null;/.test(collectorSrc));
check('启动后把这次用的扩展 hash 记进 extension.launched.json',
  /const LAUNCH_STATE_FILE = 'extension\.launched\.json';/.test(collectorSrc)
  && /writeLaunchState\(\{[\s\S]{0,200}?hash: ext\.hash/.test(collectorSrc));

// ---------- 3a-5) 读/写扩展 storage 只能落在「扩展自己的」SW 或扩展页上 ----------
// 实测坑：ctx.serviceWorkers()[0] 可能是抖音页面自己的 sw.js，在里面 eval chrome.storage
// 会 ReferenceError: chrome is not defined ⇒ 设置没写进去、落库读成 0 条、误判「本轮没新数据」。
check('扩展 ID 推导（SHA256(路径 UTF-16LE) 前 16 字节 → a-p）',
  extensionIdFromPath('C:\\Users\\mo\\.dsh\\douyin-collector\\extension') === 'mffgocmhknhhomckdfkopddbjnfabkpn',
  extensionIdFromPath('C:\\Users\\mo\\.dsh\\douyin-collector\\extension'));
check('不再拿 ctx.serviceWorkers()[0] 当扩展 SW',
  !/ctx\.serviceWorkers\(\)\[0\]/.test(collectorSrc.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
  '去掉注释后无残留');
check('读/写 storage 走 extEval（只在 chrome-extension:// 的 worker 上）',
  collectorSrc.includes('const isExtWorker = (s) => /^chrome-extension:\\/\\//')
  && (collectorSrc.match(/await extEval\(/g) || []).length >= 4,
  String((collectorSrc.match(/await extEval\(/g) || []).length) + ' 处 extEval');
check('扩展 SW 睡着时用扩展自己的页面兜底（extensionIdFromPath + index.html）',
  /chrome-extension:\/\/' \+ extensionIdFromPath\(ext\.dir\) \+ '\/index\.html'/.test(collectorSrc));
check('兜底开的扩展页在 close() 里关掉',
  /if \(extHelperPage && !extHelperPage\.isClosed\(\)\) await extHelperPage\.close\(\)/.test(collectorSrc));

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
check('可调参数里有 max（第一项标签「目标条数 max」）',
  /maxCount', label: '目标条数 max'/.test(contentSrc) && /resetSettings/.test(contentSrc));
// ---------- 3a-2b) maxCount 到量「只停顶层、二级回复补完」（v0.2.13，用户 2026-10-07 报的严重缺陷） ----------
// 旧实现把到量判断放在主循环里直接 break，而调 collectReplies() 的分支在 break 之后 ⇒ 目标条数一设，
// 二级回复永远是 0 条；老断言只匹配了那行字面（见 m07215 审计）所以自检全绿却行为错。现在分三段验：
//   ① 到量判断用一级口径 topSeenCount（不是一二级同池的 seen.size）；
//   ② 到量只 break 顶层扫描，不再直接收工；
//   ③ 循环结束后（catch 之前）统一进第二阶段补回复，再按 topCapReached 写收尾 note。
const iMaxCap = contentSrc.indexOf('RS.maxCount > 0 && topSeenCount >= RS.maxCount');
const iReplyCall = contentSrc.lastIndexOf('await collectReplies();');
const iPostStage = contentSrc.indexOf("if (!stopFlag && epoch === collectEpoch && phase === 'collecting' &&");
check('到量判断用一级去重口径 topSeenCount（旧版误用一二级同池的 seen.size）',
  iMaxCap > 0 && !/seen\.size >= RS\.maxCount/.test(contentSrc)
  && /topSeenCount\+\+/.test(contentSrc)
  && /topSeen: topSeenCount/.test(contentSrc),
  `maxCap@${iMaxCap}`);
check('到量只停顶层扫描（topCapReached + 回到 collecting），不在这里收工',
  /topCapReached = true;/.test(contentSrc)
  && /topCapReached = true;[\s\S]{0,400}?setPhase\('collecting'\)[\s\S]{0,140}?break;/.test(contentSrc)
  && !/replyTargets\.size > replyDoneSet\.size && !stopFlag/.test(contentSrc),
  'break 前必须 setPhase(\'collecting\')，且 laneEnd 里不再直接调 collectReplies');
check('二级回复补采移到循环外第二阶段（catch 之前），收尾 note 交代 topCapReached / 回复进度',
  iPostStage > iMaxCap && iReplyCall > iPostStage
  && /replyTargets\.size > replyDoneSet\.size\) \{\s*\n\s*await collectReplies\(\);/.test(contentSrc)
  && /topCapReached\) \{[\s\S]{0,400}?setPhase\('done', '', doneNote\);/.test(contentSrc),
  `maxCap@${iMaxCap} postStage@${iPostStage} lastReplyCall@${iReplyCall}`);
// ---------- 3a-2c) 回复请求全局限速 + 撞限流自动降路（v0.2.13，用户 2026-10-07 报的缺陷4） ----------
// 旧实现：replyLanes 个 worker 取到线程就立刻 fetchThread，唯一 sleep 是同线程翻页的 replyGapMs(600ms)，
// 单页线程（大多数）等于零间隔 ⇒ ≈ lanes/RTT ≈ 20 次/秒，两轮实测 0/46 线程 vs ~139 条回复。
check('回复请求有跨线程全局闸门（REPLY_GLOBAL_GAP_MS 250ms，fetchThread/recoverReply 都过闸）',
  /const REPLY_GLOBAL_GAP_MS = 250;/.test(contentSrc)
  && /const REPLY_GLOBAL_GAP_MAX_MS = 1000;/.test(contentSrc)
  && /async function replyGate\(\)/.test(contentSrc)
  && /if \(guard\+\+ >= REPLY_MAX_PAGES_PER_THREAD\) break;/.test(contentSrc)
  && (contentSrc.match(/await replyGate\(\);/g) || []).length >= 2,
  '闸门调用点 ' + ((contentSrc.match(/await replyGate\(\);/g) || []).length));
check('撞限流自动把全局限速翻倍、并发降 1 路（worker 按 replyLaneLimit 自觉退出）',
  /function replyBackOff\(reason\) \{/.test(contentSrc)
  && /replyGateMs = Math\.min\(REPLY_GLOBAL_GAP_MAX_MS, Math\.max\(REPLY_GLOBAL_GAP_MS, replyGateMs \* 2\)\)/.test(contentSrc)
  && /replyLaneLimit > 0 \? replyLaneLimit : RS\.replyLanes/.test(contentSrc)
  && /async function worker\(myLane\)/.test(contentSrc)
  && /if \(myLane >= \(replyLaneLimit > 0 \? replyLaneLimit : RS\.replyLanes\)\) return;/.test(contentSrc)
  && /replyBackOff\(err\);/.test(contentSrc));
check('replyGlobalGapMs 可被 dts_settings 覆盖（面板 > 插件 > 内置 250ms）',
  /var gap = pick\('replyGlobalGapMs', 0, 2000, 0\);/.test(contentSrc)
  && /out\.replyGlobalGapMs = gap > 0 \? gap : REPLY_GLOBAL_GAP_MS;/.test(contentSrc)
  && /replyGlobalGapMs: REPLY_GLOBAL_GAP_MS/.test(contentSrc)
  && /replyGateMs = RS\.replyGlobalGapMs;\s*\n\s*replyGateAt = 0;\s*\n\s*replyLaneLimit = 0;/.test(contentSrc),
  'v0.2.14 起 0 / 缺省 = 用内置 250ms（旧版把 0 当「关闸门」，与设置页/MCP/PROTOCOL 的文案矛盾）');
// ---------- 3a-2d) 服务端不回数据时「分波停顿重试」，不再一波判终局（v0.2.14，用户 2026-10-07 报「假限流」） ----------
// 真机依据（同一视频 7692405235813272867）：A 轮会话内连续重试 108 秒、48 次回复请求全是
// HTTP 200 + 0 字节 body；11 秒后新会话的 B 轮 39/39 线程全成、302 条；C 轮把预算放宽到 300 秒
// 连撞 125 秒 / 200+ 次请求仍一次没放行；D 轮跨 8.5 分钟 4 波全被拒，随后新会话 x1 轮 23/23 全成。
// ⇒ 空 body 是服务端真没给数据（超时另有错误码 REPLAY_TIMEOUT，从未出现），但「10 秒」是假终局。
check('单波预算与停顿计划是常量（12 秒/波 + 15/30/60 秒停），且有波次/停顿状态',
  /const REPLY_WAVE_BUDGET_MS = 12 \* 1000;/.test(contentSrc)
  && /const REPLY_PARK_PLAN_MS = \[15000, 30000, 60000\];/.test(contentSrc)
  && /var replyParkedMs = 0;/.test(contentSrc) && /var replyWaves = 0;/.test(contentSrc)
  && /var replyWaveBudgetMs = REPLY_WAVE_BUDGET_MS;/.test(contentSrc));
check('recoverReply 用「本波预算」判上限（不再拿总窗口当单波预算）',
  /var waveBudget = replyWaveBudgetMs > 0 \? replyWaveBudgetMs : RS\.replyThrottleMaxWaitMs;/.test(contentSrc)
  && /if \(Date\.now\(\) - throttleStart >= waveBudget\) \{/.test(contentSrc)
  && /if \(replyThrottledMs >= waveBudget\) \{/.test(contentSrc)
  && !/replyThrottledMs >= RS\.replyThrottleMaxWaitMs/.test(contentSrc));
check('collectReplies 撞拒后先落盘、停顿、再打一波（总等待封顶 RS.replyThrottleMaxWaitMs）',
  /while \(throttledStop && failed\.length && !needSignStop && !stopFlag\) \{/.test(contentSrc)
  && /REPLY_PARK_PLAN_MS\[Math\.min\(replyWaves - 1, REPLY_PARK_PLAN_MS\.length - 1\)\]/.test(contentSrc)
  && /if \(wouldWait \+ REPLY_WAVE_BUDGET_MS > RS\.replyThrottleMaxWaitMs\) break;/.test(contentSrc)
  && /await flushComments\(0\);   \/\/ 先落盘：用户这时关页面\/切视频也不会丢已拿到的/.test(contentSrc)
  && /failed = await runRound\(failed, '停顿 ' \+ Math\.round\(parkMs \/ 1000\) \+ 's 后重试'\);/.test(contentSrc));
check('总预算下限仍是 10 秒（面板/插件可设回老行为），内置默认 120 秒',
  /pick\('replyThrottleMaxWaitMs', 10000, 600000, REPLY_THROTTLE_MAX_WAIT_MS\)/.test(contentSrc)
  && /const REPLY_THROTTLE_MAX_WAIT_MS = 120 \* 1000;/.test(contentSrc)
  && /key: 'replyThrottleSec', label: '限流等待 s', min: 10, max: 600/.test(contentSrc));
check('收尾文案如实报「本轮共等 N 秒 / 分 M 波」与剩余线程（不再只报最后一波）',
  /本轮共等 '/.test(contentSrc) && /分 ' \+ replyWaves/.test(contentSrc)
  && /HTTP 200 \+ 0 字节 body/.test(contentSrc)
  && /function replyNote\(\)/.test(contentSrc)
  && /replyWaveBudgetMs: REPLY_WAVE_BUDGET_MS,/.test(contentSrc));
check('任一回复线程成功后清掉面板那行暂态红字（不然「这一波撞过限流、后来成了」会一直挂红）',
  /if \(errText\) errText = '';/.test(contentSrc)
  && /replyDoneSet\.add\(cid\);[\s\S]{0,400}?if \(errText\) errText = '';/.test(contentSrc));
check('补采收尾把阶段交回 collecting，让「到量停顶层」的 done 收尾能生效（真机 y1：补完停在 replies，'
  + '面板一直显示「补采二级回复」、采集器空等 120 秒）',
  /phase = 'collecting';\s*\n\s*render\(\);/.test(contentSrc)
  && /补采阶段到此结束，把「阶段」交回调用方/.test(contentSrc));
check('收尾门槛仍在（phase === \'collecting\' 才置 done，避免覆盖 waiting-sign / paused）',
  /phase === 'collecting' &&\s*\n\s*replyTargets\.size > replyDoneSet\.size/.test(contentSrc)
  && /if \(!stopFlag && epoch === collectEpoch && phase === 'collecting'\) \{/.test(contentSrc));
check('浮层里有「当前：…」生效值一行（v0.2.5 从按钮行移入浮层）',
  /'当前：' \+ settingsSummaryText\(\)/.test(contentSrc) && /refs\.summary = sbox\.cur;/.test(contentSrc));check('设置浮层有样式（.dts-settings / .dts-input / .dts-hidden）',
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

// ---------- 3d) 跨副本一致性（防 drift：历史上 csvCell 两处实现就 drift 出过一个 Critical） ----------
// ① 插件 collector.mjs 与扩展 background.js 的 csvCell 公式注入守卫必须同源：
//    评论文本由他人控制，= 开头会被 Excel 当公式执行；两处导出通路防护必须一致。
const CSV_GUARD = "if (/^[=+\\-@\\t\\r]/.test(s)) s = \"'\" + s;";
check('collector.mjs 的 csvCell 有公式注入守卫（与扩展同源）',
  collectorSrc.includes(CSV_GUARD), '缺失则插件导出的 CSV 可被 =HYPERLINK 注入');
check('扩展 background.js 的 csvCell 有公式注入守卫',
  bgSrc.includes(CSV_GUARD), '');
// ② douyin-collector/ 与 dsh-douyin-comments/extension/ 是同一份扩展的两份拷贝，
//    靠手动 sync-extension.mjs 同步 —— 这里做硬校验，drift 直接判失败。
const devExtDir = path.resolve(here, '..', 'douyin-collector');
const bundledExtDir = path.resolve(here, 'extension');
if (fs.existsSync(path.join(devExtDir, 'manifest.json'))) {
  const SYNC_FILES = ['manifest.json', 'hook.js', 'content.js', 'background.js', 'panel.css', 'app.js', 'index.html', 'style.css'];
  const drifted = SYNC_FILES.filter((f) => {
    const a = path.join(devExtDir, f);
    const b = path.join(bundledExtDir, f);
    if (!fs.existsSync(a) || !fs.existsSync(b)) return true;
    return !fs.readFileSync(a).equals(fs.readFileSync(b));
  });
  check('扩展两份副本逐字节一致（douyin-collector/ vs 插件自带 extension/）',
    drifted.length === 0, drifted.length ? 'drift: ' + drifted.join('、') + '（跑 sync-extension.mjs 同步）' : SYNC_FILES.length + ' 个文件一致');
  // ③ 反向检查：插件自带 extension/ 里不能有白名单之外的文件。
  //    只比 8 个名字的话，旧版本遗留的多余文件永远发现不了（会被一起装进浏览器）。
  const extra = fs.readdirSync(bundledExtDir).filter((f) => !SYNC_FILES.includes(f));
  check('插件自带 extension/ 没有多余文件', extra.length === 0,
    extra.length ? '多余文件: ' + extra.join('、') + '（跑 sync-extension.mjs 会清掉）' : '8 个文件，无多余');

  // ---------- 3a-6) 扩展后台可达性（2026-10-06 真机踩坑） ----------
  // 实测：扩展文件刚变过、清过脚本缓存的那一轮，面板注入正常、页面照常采集，但页面里每次
  // chrome.runtime.sendMessage 都回「Receiving end does not exist」→ 清空无效、评论一条
  // 不落库、最后「交付 0 条」还被错报成「抖音正在限流」。修法：后台加零副作用探针 dts-ping，
  // 内容脚本自测并镜像 bgOk/bgErr，采集器预检 + 刷新页面自愈 + 如实归因。
  const bgSrc = fs.readFileSync(path.join(devExtDir, 'background.js'), 'utf8');
  const ctSrc = fs.readFileSync(path.join(devExtDir, 'content.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(devExtDir, 'panel.css'), 'utf8');
  check('扩展后台有零副作用探针 dts-ping（不回落到 dts-status 以免写脏 videoId=undefined）',
    /msg\.type === 'dts-ping'[\s\S]{0,200}?sendResponse\(\{ ok: true, pong: true/.test(bgSrc));
  check('内容脚本自测后台可达性并镜像 bgOk/bgErr',
    /function probeBackground\(\)/.test(ctSrc)
    && /chrome\.runtime\.sendMessage\(\{ type: 'dts-ping' \}/.test(ctSrc)
    && /bgOk: bgOk, bgErr: bgErr, bgCheckedAt: bgCheckedAt/.test(ctSrc));
  check('采集器读 bgOk 预检 + 刷新页面自愈 + 仍不可达就标脏启动状态并报错',
    /const bgDead = \(t\) => !!t && t\.bgOk === false/.test(collectorSrc)
    && /for \(let i = 0; i < 2 && bgDead\(pre\); i\+\+\)/.test(collectorSrc)
    && /writeLaunchState\(\{ hash: '', version: ext\.version/.test(collectorSrc));
  check('「清空」点了 3 次仍未生效 → 直接报错（不再只记日志然后照样跑）',
    /面板的「清空」没生效（点了 3 次/.test(collectorSrc));
  check('「交付 0 条」如实归因（区分落库失败 vs 真没新评论）',
    /const stalled = \(pageSaw > 0 && all\.length <= beforeCids\.size\) \|\| bgTold;/.test(collectorSrc));

  // ---------- 3a-7) 清空拆成两个按钮（用户 2026-10-06 要求） ----------
  // 「清空」= 只清本条视频链接的评论；「全部清空」= 清掉所有视频（不可恢复）。
  // 两个按钮文案都含「清空」，所以按钮上挂 data-dts-act，采集器按挂点精确点，不按文案匹配。
  check('面板有「清空」与「全部清空」两个按钮，且都带 data-dts-act 挂点',
    /if \(act\) b\.setAttribute\('data-dts-act', act\);/.test(ctSrc)
    && /mkBtn\('清空', '', onClearClick, 'clear-video'\)/.test(ctSrc)
    && /mkBtn\('全部清空', 'dts-btn-danger', onClearAllClick, 'clear-all'\)/.test(ctSrc));
  check('「全部清空」是两步确认（5 秒内再点一次才真的发 all:true）',
    /var CLEAR_ALL_CONFIRM_MS = 5000;/.test(ctSrc)
    && /if \(!clearAllArmedAt \|\| now - clearAllArmedAt > CLEAR_ALL_CONFIRM_MS\)/.test(ctSrc)
    && /sendClear\(\{ all: true \}, function \(err\) \{/.test(ctSrc));
  check('「全部清空」不受「未识别到视频 ID」限制（那条护栏只管单视频清空）',
    /function onClearAllClick\(\)[\s\S]{0,400}?clearAllArmedAt = now;/.test(ctSrc)
    && !/function onClearAllClick\(\)[\s\S]{0,300}?if \(!videoId\)/.test(ctSrc));
  check('采集器 clearBefore 按 data-dts-act 点「清空本视频」，不会误点「全部清空」',
    /clickPanel\(\/\^清空\$\/, 'clear-video'\)/.test(collectorSrc)
    && /p\.querySelector\('\[data-dts-act="' \+ a \+ '"\]'\)/.test(collectorSrc));
  check('后台 dts-clear 全清分支仍要求显式 all:true（空 videoId 绝不兜底成全清）',
    /} else if \(msg\.all === true\) \{/.test(bgSrc) && /NO_VIDEO_ID/.test(bgSrc));
  check('面板 CSS 有危险按钮样式与上膛态样式',
    /\.dts-btn-danger \{/.test(cssSrc) && /\.dts-btn-danger\.dts-armed \{/.test(cssSrc));

  // ---------- 3a-7) page.evaluate 的参数个数（2026-10-06 真机 E2E 踩坑） ----------
  // `page.evaluate(fn, a, b)` 只有 1 个参数位（第二参是 options）→ 运行期直接抛
  // `Too many arguments. If you need to pass more than 1 argument to the function wrap them in an object.`
  // 当时 clearBefore 一跑就崩（点「清空」这条路径），而静态断言与直接点按钮的真机测试都看不出来。
  // 这里静态扫 collector.mjs：每个 page.evaluate(...) 在**顶层**（相对它自己的括号）最多 1 个参数。
  const evaluateArityProblems = (src) => {
    const out = [];
    const open = /page\.evaluate\(/g;
    let m;
    while ((m = open.exec(src))) {
      let i = m.index + m[0].length, depth = 1, commas = 0;
      const quotes = [];
      for (; i < src.length; i++) {
        const ch = src[i], prev = src[i - 1];
        if (quotes.length) {
          if (ch === '\\') { i++; continue; }
          if (ch === quotes[quotes.length - 1]) quotes.pop();
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quotes.push(ch); continue; }
        if (ch === '/' && prev === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (ch === '/' && prev === '*') { i = src.indexOf('*/', i) + 1; continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) break; }
        else if (ch === ',' && depth === 1) commas++;
      }
      if (commas > 1) out.push(src.slice(m.index, m.index + 140).replace(/\s+/g, ' '));
    }
    return out;
  };
  const arityBad = evaluateArityProblems(collectorSrc);
  check('collector.mjs 的 page.evaluate 最多只传 1 个参数（多传会抛 Too many arguments）',
    arityBad.length === 0, arityBad.join(' | '));
  check('clickPanel 把参数包成一个对象传给 page.evaluate',
    /page\.evaluate\(\(\{ src, a \}\)/.test(collectorSrc)
    && /\}, \{ src: re\.source, a: act \|\| '' \}\)/.test(collectorSrc));

  // ---------- 3a-8) 跨视频可见性 + 导出范围（用户 2026-10-06：换视频后「上一条数据没了」） ----------
  // 评论本来就按 videoId 分桶存着，换视频不会删；但面板计数与两个导出按钮原来都只认当前视频，
  // 换视频后一切归零 → 用户以为数据丢了。修法：面板显示「本地已存 N 个视频 / M 条」，
  // 并给导出加一个显式的「全部视频」范围（CSV 末尾追加 video_id 列）。
  check('后台 dts-stats 报跨视频总量（totalAll / videoCount，用 dts_videos 的 count 元数据累加）',
    /totalAll \+= Number\(videos\[v\] && videos\[v\]\.count\) \|\| 0;/.test(bgSrc)
    && /sendResponse\(\{ ok: true, count, totalAll, videoCount: vkeys\.length, videos \}\)/.test(bgSrc));
  check('后台 dts-export 支持全部视频（面板与 Hub 共用 exportComments，合并各桶并标 videoId）',
    /async function exportComments\(opts\) \{/.test(bgSrc)
    && /const wantAll = o\.all === true;/.test(bgSrc)
    && /Object\.assign\(\{\}, c, \{ videoId: v \}\)/.test(bgSrc)
    && /scope: wantAll \? 'all' : 'video',/.test(bgSrc));
  check('「全部视频」导出只在 CSV 末尾追加 video_id 列（前 17 列契约不变）',
    /const withVideoId = !!\(opts && opts\.withVideoId\);/.test(bgSrc)
    && /if \(withVideoId\) cols\.push\('video_id'\);/.test(bgSrc)
    && /\.concat\(withVideoId \? \[csvCell\(c\.videoId \|\| c\.video_id \|\| ''\)\] : \[\]\)/.test(bgSrc));
  check('「全部视频」导出文件名带上 all（不是某个 videoId，避免与单视频文件混淆）',
    /douyin-comments-\$\{wantAll \? 'all' : videoId\}-\$\{stamp\}\.json/.test(bgSrc)
    && /douyin-comments-\$\{wantAll \? 'all' : videoId\}-\$\{stamp\}\.csv/.test(bgSrc));
  // v0.2.11：Hub(AI/MCP) 的 export 命令与面板导出合并成 exportComments 一份实现。
  // 成功必须按 Hub 约定把主体放进 result（否则 aiPollOnce 的旧拍平分支会把
  // scope / videoCount / count 全丢掉，MCP 只能看到 filename/bytes/path）；失败保持顶层 error+hint。
  check('Hub(AI/MCP) 的 export 命令也支持 all（成功放 result、失败保持顶层 error+hint）',
    /case 'export': \{[\s\S]{0,700}?const r = await exportComments\(\{ all: args\.all === true, videoId: args\.videoId, format: args\.format \}\);/.test(bgSrc)
    && /if \(!r\.ok\) return r;\s*\n\s*return \{ ok: true, result: r \};/.test(bgSrc));
  check('导出失败口径统一（MISSING_VIDEO_ID 提示可传 all / EMPTY_POOL，不再下载只有表头的空 CSV）',
    /error: 'MISSING_VIDEO_ID', hint: 'export 需要 videoId 参数；要导出本地全部视频请传 all:true'/.test(bgSrc)
    && /return \{ ok: false, error: 'EMPTY_POOL', scope: 'all'/.test(bgSrc)
    && /return \{ ok: false, error: 'EMPTY_POOL', videoId/.test(bgSrc));
  check('面板有「本地已存」一行 + 导出范围两个按钮（都带 data-dts-act 挂点）',
    /refs\.local = row\(body, '本地已存'\);/.test(ctSrc)
    && /mkBtn\('本条视频', 'dts-btn-scope dts-on', function \(\) \{ setExportScope\(false\); \}, 'export-scope-video'\)/.test(ctSrc)
    && /mkBtn\('全部视频', 'dts-btn-scope', function \(\) \{ setExportScope\(true\); \}, 'export-scope-all'\)/.test(ctSrc));
  check('面板读一次 dts-stats 并周期刷新（20s），换视频后也能看到旧数据还在',
    /function refreshLocalStats\(id\)/.test(ctSrc)
    && /chrome\.runtime\.sendMessage\(\{ type: 'dts-stats', videoId: vid \}, function \(resp\)/.test(ctSrc)
    && /}, 20000\);/.test(ctSrc));
  check('导出把范围传给后台（all: exportAll）+ 无视频 ID 时提示可切「全部视频」',
    /all: exportAll \}/.test(ctSrc)
    && /可把导出范围切到「全部视频」导出本地已存的评论/.test(ctSrc));
  check('AI 桥的导出命令也支持 all:true（与面板同一条链路）',
    /if \(t === 'dts-ai-export'\) \{[\s\S]{0,200}?var wantAll = !!\(msg && msg\.all === true\);/.test(ctSrc)
    && /type: 'dts-export', videoId: vid, format: format, all: wantAll \}/.test(ctSrc)
    && /scope: wantAll \? 'all' : 'video',/.test(ctSrc));
  check('面板 CSS 有导出范围小按钮与选中态样式',
    /\.dts-row\.dts-scope > \.dts-btn \{/.test(cssSrc) && /\.dts-btn-scope\.dts-on \{/.test(cssSrc));

  // ---------- 3a-9) 清空必须自检、失败必须如实报错（用户 2026-10-06：「全部清空没有用，本地已存还是在」） ----------
  // 真机复现两件事：① 存储其实清掉了，但清空前发出的 dts-stats 旧回包晚到，把「本地已存」又写成旧数字，
  // 看起来就是「清了但没清」；② 后台没响应（扩展刚 reload / 上下文失效）时面板照样宣称「已清空」。
  // 修法：sendClear 等后台回包 → verifyCleared 读回 storage 自检 → 只有真清掉才改口；统计请求带序号，旧回包作废。
  check('sendClear 等后台回包并把结果交回调用方（不再「发出去就当成功」）',
    /function sendClear\(payload, onDone\) \{/.test(ctSrc)
    && /done\('SEND_FAILED: ' \+ le\);/.test(ctSrc)
    && /if \(!resp \|\| !resp\.ok\) \{ done\('CLEAR_REJECTED: '/.test(ctSrc));
  check('清空后读回 chrome.storage.local 自检（两个清空按钮都必须过这一关才敢说已清空）',
    /function verifyCleared\(vid, all, cb\) \{/.test(ctSrc)
    && /verifyCleared\(videoId, false, function \(gone, detail\)/.test(ctSrc)
    && /verifyCleared\(videoId, true, function \(gone, detail\)/.test(ctSrc));
  check('自检不通过时如实报错（带 edge://extensions 重新加载 + F5 指引）',
    /function clearFailedText\(which, err, detail\) \{/.test(ctSrc)
    && /「' \+ which \+ '」没有生效（/.test(ctSrc)
    && /edge:\/\/extensions 点一下「重新加载」，回到抖音页按 F5 刷新后再试/.test(ctSrc));
  check('统计请求带序号，清空后旧回包作废（否则「本地已存」会被旧数字写回）',
    /var localStatsSeq = 0;/.test(ctSrc)
    && /var seq = \+\+localStatsSeq;/.test(ctSrc)
    && /if \(seq !== localStatsSeq\) return;/.test(ctSrc)
    && /localStatsSeq\+\+;[\s\S]{0,60}?refreshLocalStats\(videoId\);/.test(ctSrc));
  // 真机踩到：失败分支写成 errText=… 再 setPhase('idle','','')，而 setPhase 的第二个参数会把 errText 清空
  // → 面板既不报「已清空」也不报「没有生效」，用户看不到任何反馈。文案必须走 setPhase 的 err 参数。
  check('清空失败文案不会被随后的 setPhase 清掉（走 setPhase 的 err 参数）',
    /setPhase\('error', clearFailedText\('清空', err, detail\)/.test(ctSrc)
    && /setPhase\('error', clearFailedText\('全部清空', err, detail\)/.test(ctSrc)
    && !/errText = clearFailedText[\s\S]{0,120}?setPhase\('idle', '', ''\)/.test(ctSrc));
} else {
  console.log('ℹ️ 跳过扩展副本一致性校验（找不到开发目录 ' + devExtDir + '，非开发机上属正常）');
}

// ---------- 3c) v0.5.11：插件真的把 maxCount / replyGlobalGapMs 下发，且对旧扩展有兜底 ----------
// 旧版（≤ v0.5.10）只推 `const extSettings = { lanes }`，max 根本没进 dts_settings：一级跑完整轮，
// 一进 replies 阶段就被点「暂停」截断 ⇒ 实测 max=100 返回 896 条、用时 50.3s（m07215 审计）。
check('插件把 max 作为 maxCount 下发（旧版从不推 maxCount）',
  /if \(max > 0\) extSettings\.maxCount = max;/.test(collectorSrc)
  && /if \(replyGlobalGapMs > 0\) extSettings\.replyGlobalGapMs = replyGlobalGapMs;/.test(collectorSrc)
  && /const extSettings = \{ lanes \};|extSettings\.lanes = lanes;/.test(collectorSrc));
check('max 用一级计数 topSeen（旧扩展回包没有 topSeen 时才退回 unique 兜底）',
  /const uTop = typeof s\.topSeen === 'number' \? s\.topSeen : u;/.test(collectorSrc)
  && /if \(uTop >= max && !\(await extHandlesMax\(\)\)\)/.test(collectorSrc));
check('装了旧扩展（不认 maxCount）时插件仍会点「暂停」兜底，并把原因写进日志',
  /const extHandlesMax = async \(\) => \{/.test(collectorSrc)
  && /extMaxOk = !!\(eff && Number\(eff\.maxCount\) > 0 && Number\(eff\.maxCount\) === max\)/.test(collectorSrc)
  && /dts_settings_effective/.test(collectorSrc));
check('插件设置表单/执行链都带上 replyGlobalGapMs（0 = 用扩展内置 250ms）',
  /replyGlobalGapMs: Math\.max\(0, Math\.min\(2000, Math\.round\(readCfg\(cfg, 'replyGlobalGapMs'/.test(indexSrc)
  && /const replyGlobalGapMsUsed = settings\.replyGlobalGapMs;/.test(indexSrc)
  && /replyGlobalGapMs: replyGlobalGapMsUsed,/.test(indexSrc)
  && cfgKeys.includes('replyGlobalGapMs'));
check('插件描述如实写「到量只停顶层扫描、继续补二级回复」（0.5.11 起）',
  /到量就\*\*停止顶层扫描、继续把二级回复补完\*\*/.test(String(def.description || ''))
  && /0\.5\.11 起真正生效/.test(String(def.description || '')));
check('插件 package.json / 扩展 manifest 版本对得上（0.5.13 / 0.2.15）',
  manifest.version === '0.5.13' && targetManifest.version === '0.2.15',
  `plugin=${manifest.version} ext=${targetManifest.version}`);
// ---------- 3d) v0.5.12 / 扩展 0.2.14：「假限流」三处修正 ----------
// 用户 2026-10-07 报「我怀疑这个限速是假限速，有时候我自己点就可以拿到」，随后又猜
// 「请求过快、还没拿到返回结果就说是限流」。真机三轮探针（_rl_probe/_rl_direct）证伪了后者：
// EMPTY_BODY 只可能来自「HTTP 200 + body 0 字节」（hook.js 里 res.text() 拿到空串），
// 超时是另一个错误码 REPLAY_TIMEOUT，A/C/D 三轮从未出现；但「10 秒判终局」确实是假的——
// A 轮连撞 108 秒全拒，11 秒后新会话 B 轮 39/39 全成。
check('插件设置项说明如实写「总等待」，不再写「十秒不行就停」式文案',
  /本轮\*\*总共\*\*最多等多少秒/.test(indexSrc),
  'index.js 的 replyThrottleSec 描述');
check('扩展默认：单波 12 秒 + 停顿 15/30/60 秒 + 总窗口 120 秒 (0.2.14)',
  /const REPLY_WAVE_BUDGET_MS = 12 \* 1000;/.test(contentSrc)
  && /const REPLY_PARK_PLAN_MS = \[15000, 30000, 60000\];/.test(contentSrc)
  && /const REPLY_THROTTLE_MAX_WAIT_MS = 120 \* 1000;/.test(contentSrc));
check('「0 = 用内置 250ms」在扩展侧与设置页/MCP 文案一致（0 不再等于关闸门）',
  /out\.replyGlobalGapMs = gap > 0 \? gap : REPLY_GLOBAL_GAP_MS;/.test(contentSrc)
  && /0=用扩展内置 250ms|0 = 用扩展内置 250ms/.test(bgSrc)
  && !/const REPLY_GLOBAL_GAP_MS = 250;        \/\/ 所有回复请求（跨线程）的最小间隔；0 = 关闭限速/.test(contentSrc));

// ---------- 3e) v0.2.15：顶层列表改回「错峰多路」（用户 2026-10-07 报「单路太慢」） ----------
// 探针结论：同时发（同一签名 ~200ms 窗口内）会被服务端并成同一页（4 个 cursor Σ200 条只去重出
// 56 条、next 字段还对 ⇒ 静默少采）；错峰 200ms 恢复正常；扫完 21 页单路 15.79s vs 错峰 4 路
// 7.72s、唯一 907 vs 912。所以默认 3 路错峰，1 = 老单路，并保留「两路同页 ⇒ 当轮降回单路」兜底。
const mcpPath = path.join(here, '..', 'douyin-mcp', 'mcp.js');
if (fs.existsSync(mcpPath)) {
  const mcpSrc = fs.readFileSync(mcpPath, 'utf8');
  check('MCP 的 lanes 说明改成「错峰多路」并带实测数字（不再是【已停用】）',
    /顶层列表路数（默认 3，错峰多路/.test(mcpSrc) && !/【已停用】顶层扫描并发路数/.test(mcpSrc));
  check('MCP VERSION = 0.3.6（与 package.json 对齐）', /const VERSION = '0\.3\.6';/.test(mcpSrc),
    (mcpSrc.match(/const VERSION = '[^']*'/) || [''])[0]);
}
check('插件工具描述里的 lanes 不再写「已停用」', !/已停用/.test(String(def.description || '')),
  /已停用/.test(String(def.description || '')) ? '描述里仍有「已停用」' : 'ok');

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
