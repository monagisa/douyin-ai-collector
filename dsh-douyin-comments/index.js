// dsh-douyin-comments —— DSH（Cordis）工具插件：抖音公开评论采集
//
// 只做一件事：把「采一个抖音视频的公开评论并导出 CSV/JSON」注册成 agent 可直接调用的
// 工具 `douyin_comments`。实现见 ./collector.mjs：
//   · 插件自带 Chrome 扩展副本（extension/），运行时自动装进浏览器（--load-extension）；
//   · 驱动扩展拿页面真实签名、分页重放、落库，再把结果写成 CSV/JSON；
//   · 只交付「本次新采」的数据，拿不到签名/没新数据就明确失败。
//
// 安装：dsh plugin --profile web add file:D:\dycopy\dsh-douyin-comments
//       （package.json 的 dsh.bundle.patch 让它成为 profile 的一个 bundle 层；装完重启 dsh）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectDouyinComments, DEFAULTS, resolveOutDir, sessionWorkspaceCwd } from './collector.mjs';

/** Loader 稳定标识（同时也是 cordis.patch.yml 里 id 的来源）。 */
export const name = 'dsh-douyin-comments';

/** 必需服务：tools 提供 ctx.tools。 */
export const inject = ['tools'];

/**
 * 取 `defineTool`：它不是恒等函数（要把 DSH 自有 schema DSL 编译成 JSON Schema 并建校验器），
 * 所以必须拿到宿主那一份。
 * 1) 裸说明符——插件被拷进 profile（file: 安装）时可用；
 * 2) 退回 profile 的「拦截层」`<DSH_HOME>/profiles/node_modules`；
 * 3) 再退回 dsh 安装目录自带的副本（从 process.argv[1] 推出来，换机器也成立）。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') return mod.defineTool;
  } catch { /* 继续试下面的绝对路径 */ }

  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  ];
  if (process.argv[1]) {
    const dshRoot = path.resolve(path.dirname(process.argv[1]), '..');
    candidates.push(path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
  }
  // 开发机兜底：便携 node 的全局目录（用 DTS_NODE_GLOBAL 指明，如 D:\node-v22.23.1\node_global；不设就跳过）
  if (process.env.DTS_NODE_GLOBAL) {
    candidates.push(path.join(process.env.DTS_NODE_GLOBAL, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
  }

  const tried = [];
  for (const file of candidates) {
    tried.push(file);
    try {
      if (!fs.existsSync(file)) continue;
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.defineTool === 'function') return mod.defineTool;
    } catch { /* 继续 */ }
  }
  throw new Error('dsh-douyin-comments: 找不到 @deepseek-ai/dsh-tools 的 defineTool（试过：' + tried.join('、') + '）');
}

const defineTool = await loadDefineTool();

/**
 * 取 `Schema`（schemastery）：和 defineTool 同理，必须拿宿主那一份。
 * 顺序：1) profile 的「拦截层」`<DSH_HOME>/profiles/node_modules`；2) dsh 安装目录自带副本；
 *       3) 开发机全局 dsh 副本（DTS_NODE_GLOBAL）；4) 最后才试裸说明符。
 * 为什么裸说明符放最后：全新 profile 里 pnpm 会把 **旧版** `@deepseek-ai/schemastery`
 * （实测 3.18.2）装进插件自己的 node_modules，那份没有 `Schema.prototype.volatile`（3.18.3+ 才有）
 * —— 裸说明符会命中它，Config 里的链式 `.volatile()` 直接抛
 * `TypeError: ... .volatile is not a function`，整个插件 import 失败
 * （dsh 只打印「1 entry did not activate / failed to import」，工具就没了）。
 */
async function loadSchema() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
  ];
  if (process.argv[1]) {
    const dshRoot = path.resolve(path.dirname(process.argv[1]), '..');
    candidates.push(path.join(dshRoot, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'));
  }
  if (process.env.DTS_NODE_GLOBAL) {
    candidates.push(path.join(process.env.DTS_NODE_GLOBAL, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'));
  }

  const usable = (mod) => {
    const S = mod && (mod.default || mod);
    return (typeof S === 'function' && typeof S.object === 'function' && typeof S.number === 'function') ? S : undefined;
  };

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const S = usable(await import(pathToFileURL(file).href));
      if (S) return S;
    } catch { /* 继续 */ }
  }

  try {
    const S = usable(await import('@deepseek-ai/schemastery'));
    if (S) return S;
  } catch { /* 没有就退回没有表单 */ }
  return undefined;
}

const Schema = await loadSchema();

/**
 * `.volatile()` 是 3.18.3+ 才有的链式方法。拿不到就原样返回 —— 降级后果只是
 * 「DSH 设置表单里这几个字段不能改（不是 volatile）」，插件本身照常加载；
 * 绝不能因为一个可选的链式方法让整个插件 import 失败。
 */
function vol(schema) {
  try {
    if (schema && typeof schema.volatile === 'function') return schema.volatile();
  } catch { /* 有 volatile 但抛错也退回原样 */ }
  return schema;
}

/**
 * 导出给自检用：verify-tool.mjs 要复刻 dsh-settings 的 `new Schema(schema.toJSON())`
 * （见 dsh-settings/lib/index.js:103-104 plainSchema）。schema 实例身上拿不回这个类
 * ——`Object.getPrototypeOf(schema).constructor` 是 Function，所以只能由这里给出。
 */
export { Schema };

/**
 * 插件设置：声明成 cordis 的 Config 后，DSH 的「设置 → 插件 → dsh-douyin-comments」
 * 会自动生成这张表单（dsh-settings 的 schema(entry) 取 fiber.runtime.Config，要求能 toJSON）。
 * 八个字段都经 vol() 标了 volatile：DSH 只允许表单改 volatile 字段，好处是改完**立即生效**——
 * execute() 里每次都现读一遍，不用重启 dsh、也不用重装插件。（旧版 schemastery 没有 .volatile()
 * 时 vol() 原样返回，插件照常加载，只是这几个字段在表单里不能改。）
 * 加载不到 schemastery 时不导出 Config（cordis 会跳过校验），插件照常工作，只是没有表单。
 */
export const Config = Schema ? Schema.object({
  max: vol(Schema.number()
    .description('一级评论的目标条数：采到这么多就继续补二级回复（默认 80000 = 扩展单视频评论池的防御上限）')
    .default(80000).min(1).max(1000000).step(1)),
  lanes: vol(Schema.number()
    .description('并发路数：一轮同时发几路分页请求（1~8，默认 4）。实测 4 路最快，6 路服务端开始排队、更慢且有风控风险')
    .default(4).min(1).max(8).step(1)),
  timeoutMs: vol(Schema.number()
    .description('单次采集总超时毫秒（默认 1800000 = 30 分钟）；到点也会把已采到的评论落盘')
    .default(1800000).min(60000).max(14400000).step(1000)),
  waitLoginSec: vol(Schema.number()
    .description('检测到未登录时，等你在浏览器窗口里扫码的秒数（默认 180；0 = 不等，直接返回 need-login 并把窗口留着）')
    .default(180).min(0).max(1800).step(1)),
  clearBefore: vol(Schema.boolean()
    .description('采集前是否清空扩展缓存（默认 false）。清空会重置去重表和游标、毁掉「断点续采」进度，所以默认不清；不清空时靠 cid 差集保证只交付本轮新采')
    .default(false)),
  replyLanes: vol(Schema.number()
    .description('二级回复阶段的并发线程数 1~8（默认 4）。回复接口比列表接口更容易被限流，撞限流可降到 1~2 再重跑')
    .default(4).min(1).max(8).step(1)),
  replyThrottleSec: vol(Schema.number()
    .description('二级回复被限流时，最多等多少秒（默认 10，扩展内置值）。限流窗口实测几秒才开，10 秒常整轮白跑，可放宽到 60~300 后用「再点一次」断点续采')
    .default(10).min(10).max(600).step(1)),
  replyNoProgressSec: vol(Schema.number()
    .description('二级回复阶段多久没有新数据就收工（秒，默认 900 = 15 分钟）。退避重试期间条数本来就长时间不动，太小会导致回复采不到就收工')
    .default(900).min(60).max(7200).step(10)),
}).default({}) : undefined;

/** 原始 config（保留 volatile 引用本身，而不是快照值）。 */
const RAW_CONFIG = { value: {} };

/** schemastery 的 volatile 字段被包成「只有 get、没有 set」的只读引用，写入后必须现读 get()。 */
function isVolatileRef(v) {
  return !!v && typeof v.get === 'function' && Symbol.for('cosmokit.volatile.write') in v;
}

function readCfg(cfg, key, fallback) {
  const raw = cfg ? cfg[key] : undefined;
  const v = isVolatileRef(raw) ? raw.get() : raw;
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readCfgBool(cfg, key, fallback) {
  const raw = cfg ? cfg[key] : undefined;
  const v = isVolatileRef(raw) ? raw.get() : raw;
  if (v === undefined || v === null || v === '') return fallback;
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** 现读一遍插件设置（工具参数没给的部分用它兜底）。 */
export function readSettings(config) {
  const cfg = (config && typeof config === 'object') ? config : (RAW_CONFIG.value || {});
  return {
    max: readCfg(cfg, 'max', Number(DEFAULTS.max) > 0 ? Number(DEFAULTS.max) : 80000),
    lanes: Math.max(1, Math.min(8, Math.round(readCfg(cfg, 'lanes', Number(DEFAULTS.lanes) > 0 ? Number(DEFAULTS.lanes) : 4)))),
    timeoutMs: readCfg(cfg, 'timeoutMs', Number(DEFAULTS.timeoutMs) > 0 ? Number(DEFAULTS.timeoutMs) : 1800000),
    waitLoginSec: Math.max(0, Math.round(readCfg(cfg, 'waitLoginSec', Number.isFinite(Number(DEFAULTS.waitLoginSec)) ? Number(DEFAULTS.waitLoginSec) : 180))),
    clearBefore: readCfgBool(cfg, 'clearBefore', !!DEFAULTS.clearBefore),
    replyLanes: Math.max(1, Math.min(8, Math.round(readCfg(cfg, 'replyLanes', Number(DEFAULTS.replyLanes) > 0 ? Number(DEFAULTS.replyLanes) : 4)))),
    replyThrottleSec: Math.max(10, Math.round(readCfg(cfg, 'replyThrottleSec', Number(DEFAULTS.replyThrottleSec) > 0 ? Number(DEFAULTS.replyThrottleSec) : 10))),
    replyNoProgressSec: Math.max(60, Math.round(readCfg(cfg, 'replyNoProgressSec', Number(DEFAULTS.replyNoProgressSec) > 0 ? Number(DEFAULTS.replyNoProgressSec) : 900))),
  };
}

/** 把 config 里的路径类覆盖写进采集默认值（collector 每次调用时才读 DEFAULTS）。 */
function applyConfig(config) {
  RAW_CONFIG.value = (config && typeof config === 'object') ? config : {};
  const cfg = RAW_CONFIG.value;
  if (cfg.extDir) DEFAULTS.extDir = String(cfg.extDir);
  if (cfg.cookies) DEFAULTS.cookies = String(cfg.cookies);
  if (cfg.outDir) DEFAULTS.outDir = String(cfg.outDir);
  if (cfg.chromeProfile) DEFAULTS.profile = String(cfg.chromeProfile);
  if (cfg.chrome) DEFAULTS.chrome = String(cfg.chrome);
  if (cfg.home) DEFAULTS.home = String(cfg.home);
  if (cfg.cdpPort) DEFAULTS.port = Number(cfg.cdpPort);
}

export function apply(ctx, config = {}) {
  applyConfig(config);

  const dispose = ctx.tools.register(defineTool({
    name: 'douyin_comments',
    description: [
      '采集一个抖音视频的公开评论，导出 CSV（UTF-8 BOM，Excel 直接打开）和 JSON，返回文件路径与条数。',
      'CSV/JSON **默认写到当前会话的工作区**（<工作区>/douyin-comments/），调用方直接用返回值里的 csvPath/jsonPath 就能引用；要换位置用 outDir。',
      '自带 Chrome 扩展（抖音评论采集器）：第一次调用时会自动把扩展装进它启动的浏览器，无需手动安装。',
      '走本机 Chromium（有头窗口）+ 页面真实签名分页重放，约 10~60 秒；只读公开评论，不发帖/不点赞/不关注。',
      '浏览器用持久化 profile（默认 ~/.dsh/douyin-collector/chrome-profile）保存抖音登录态。',
      '没登录时**不会开始采集**：会在浏览器窗口里留出登录二维码，等使用者扫码（默认最多等 180 秒，可用 waitLoginSec 调整）。',
      '若返回 phase=need-login，说明等不到登录：把返回的 error 原样转达给使用者，让他在那个（已保持打开的）浏览器窗口里用抖音 App 扫码，扫完再调用一次；不要重复空转，也不要另开窗口。',
      '只交付本次新采的数据：默认不清空扩展缓存（清空会毁掉断点续采进度），结束时按 cid 差集剔除旧数据；一条新数据都没有就返回失败并说明原因。要强制清空就把 clearBefore 设为 true。',
      'max 是「一级评论」的目标值：到量后仍会继续补二级回复（回复接口容易限流，采不到会自动退避重试）。实际条数通常多于 max，返回值 count 是真实条数。',
      '插件设置（DSH「设置 → 插件 → dsh-douyin-comments」）里可以改目标条数 max（默认 80000）、并发路数 lanes（默认 4，一轮同时几路请求）、总超时 timeoutMs、等扫码秒数 waitLoginSec、是否先清空 clearBefore、二级回复的并发 replyLanes、限流等待 replyThrottleSec、回复阶段无进展收工 replyNoProgressSec，改完立即生效；本次调用的工具参数只覆盖当次，不改设置。',
    ].join(' '),
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: '抖音视频链接（https://www.douyin.com/video/<id>、带 modal_id 的浮层链接，或直接给 15~25 位 aweme id）。',
      },
      max: { type: 'integer', description: '本次目标评论条数，到量即暂停并落盘（不传 = 用插件设置里的值，出厂默认 80000）。' },
      lanes: { type: 'integer', description: '本次并发路数 1~8（不传 = 用插件设置里的值，出厂默认 4）。只影响这一次调用，不会改设置。' },
      replies: { type: 'boolean', description: '是否等二级回复补采（默认 true；false 时只采一级评论，更快）。' },
      clearBefore: { type: 'boolean', description: '本次是否先清空扩展里该视频的旧数据（默认 false = 不清空，保留断点续采，结束时按 cid 差集只交付新采的）。' },
      timeoutMs: { type: 'integer', description: '本次总超时毫秒（不传 = 用插件设置里的值，出厂默认 1800000 = 30 分钟），到点也会把已采到的评论落盘。' },
      waitLoginSec: { type: 'integer', description: '检测到未登录时，等使用者在浏览器窗口里扫码登录的秒数（不传 = 用插件设置里的值，出厂默认 180；显式传 0 = 不等，直接返回 need-login 并把窗口留着）。' },
      outDir: { type: 'string', description: '输出目录（默认：当前会话工作区下的 douyin-comments/ 子目录；取不到工作区时退回 ~/.dsh/douyin-collector/out）。' },
      keepOpen: { type: 'boolean', description: '调试用：采完不关浏览器窗口（默认 false）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string', required: true, description: '失败原因（成功时为空串）' },
          videoId: { type: 'string', required: true, description: '实际采集的视频 id' },
          title: { type: 'string', required: true, description: '视频标题（拿不到时为空串）' },
          count: { type: 'integer', required: true, description: '本次新采的真实条数' },
          csvPath: { type: 'string', required: true },
          jsonPath: { type: 'string', required: true },
          phase: { type: 'string', required: true, description: '收工时的扩展状态' },
          lanes: { type: 'integer', required: true, description: '本次实际用的并发路数（扩展写回的 dts_settings_effective；读不到时为本次请求值）' },
          note: { type: 'string', required: true, description: '扩展面板的说明文字' },
          durationSec: { type: 'number', required: true },
          extensionVersion: { type: 'string', required: true, description: '安装进浏览器的扩展版本' },
          extensionInstalled: { type: 'boolean', required: true, description: '本次是否重新安装了扩展' },
          sample: { type: 'array', required: true, items: { type: 'string' }, description: '前 5 条预览' },
        },
      },
      render(_args, value) {
        if (value.ok === false && value.phase === 'need-login') {
          return [{
            type: 'text',
            text: '需要先登录抖音（本次没有开始采集，避免未登录被限流、数据残缺）：\n'
              + value.error
              + '\n→ 让使用者在已经打开的浏览器窗口里用抖音 App 扫码；扫完再调用一次 douyin_comments 就能接着采（登录态已存进本机 profile，下次不用再扫）。',
          }];
        }
        if (!value.ok) {
          return [{ type: 'text', text: `采集未成功：${value.error}\n（扩展 v${value.extensionVersion}，phase=${value.phase}${value.note ? '，面板：' + value.note : ''}）` }];
        }
        const head = `已采集 ${value.count} 条公开评论`
          + (value.title ? `（${value.title}）` : '')
          + ` — videoId=${value.videoId}，用时 ${value.durationSec}s，并发 ${value.lanes} 路，扩展 v${value.extensionVersion}`
          + (value.extensionInstalled ? '（本次自动安装）' : '');
        const lines = [head, `CSV：${value.csvPath}`, `JSON：${value.jsonPath}`];
        if (value.note) lines.push(`面板：${value.note}`);
        if (Array.isArray(value.sample) && value.sample.length > 0) {
          lines.push('样本：');
          value.sample.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    // 同一时刻只能跑一个：它要独占一个有头浏览器和扩展面板。
    isConcurrencySafe: () => false,
    // 有意不声明 timeoutMs：采集本身可能跑几分钟，用参数 timeoutMs 自己控制时长。
    async execute(args, exec) {
      const url = String(args.url || '').trim();
      if (!url) throw new Error('douyin_comments: url 必填');
      if (exec && exec.signal && exec.signal.aborted) throw new Error('douyin_comments: 已被调用方取消');

      // 设置每次调用现读一遍：在「设置 → 插件」里改完，下一次调用就生效（不用重启 dsh）。
      // 工具参数只覆盖当次，不改设置。
      const settings = readSettings();
      const maxUsed = Number(args.max) > 0 ? Number(args.max) : settings.max;
      const timeoutMsUsed = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : settings.timeoutMs;
      const waitLoginSecUsed = (args.waitLoginSec === undefined || args.waitLoginSec === null)
        ? settings.waitLoginSec
        : Number(args.waitLoginSec);
      const lanesUsed = Number(args.lanes) > 0 ? Number(args.lanes) : settings.lanes;
      const clearBeforeUsed = args.clearBefore === undefined ? settings.clearBefore : args.clearBefore === true;
      const replyLanesUsed = settings.replyLanes;
      const replyThrottleSecUsed = settings.replyThrottleSec;
      const replyNoProgressSecUsed = settings.replyNoProgressSec;

      const logs = [];
      const onLog = (line) => {
        const text = String(line);
        logs.push(text);
        if (logs.length > 60) logs.shift();
        if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info('[douyin] ' + text);
      };

      // 结果默认写进**当前会话的工作区**（exec.agent.session.header.cwd），别人拿到手就能在自己的
      // 项目目录里看到 CSV/JSON；显式 outDir 仍然优先。
      const outDir = resolveOutDir({ explicit: args.outDir, exec, fallback: DEFAULTS.outDir });
      onLog('输出目录：' + outDir
        + (args.outDir ? '（显式指定）' : sessionWorkspaceCwd(exec) ? '（当前会话工作区）' : '（全局默认：本会话没带工作区）'));
      onLog('本次设置：max=' + maxUsed + '，并发路数=' + lanesUsed + '，超时=' + timeoutMsUsed + 'ms，等扫码=' + waitLoginSecUsed + 's'
        + '，先清空=' + (clearBeforeUsed ? '是' : '否') + '，回复并发=' + replyLanesUsed
        + '，回复限流等待=' + replyThrottleSecUsed + 's，回复无进展收工=' + replyNoProgressSecUsed + 's'
        + '（设置 → 插件 → dsh-douyin-comments 可改，改完立即生效）');

      let res;
      try {
        res = await collectDouyinComments({
          url,
          max: maxUsed,
          lanes: lanesUsed,
          replies: args.replies,
          timeoutMs: timeoutMsUsed,
          waitLoginSec: waitLoginSecUsed,
          clearBefore: clearBeforeUsed,
          replyLanes: replyLanesUsed,
          replyThrottleSec: replyThrottleSecUsed,
          replyNoProgressSec: replyNoProgressSecUsed,
          outDir,
          keep: args.keepOpen === true,
          onLog,
          signal: exec ? exec.signal : undefined,
        });
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e), videoId: '', title: '', count: 0, csvPath: '', jsonPath: '', phase: 'error', note: '' };
      }

      const ext = res.extension || {};
      return {
        ok: res.ok === true,
        error: String(res.error || ''),
        videoId: String(res.videoId || ''),
        title: String(res.title || ''),
        count: Number.isFinite(res.count) ? Number(res.count) : 0,
        csvPath: String(res.csvPath || ''),
        jsonPath: String(res.jsonPath || ''),
        phase: String(res.phase || ''),
        lanes: Number(res.extLanes) > 0 ? Number(res.extLanes) : lanesUsed,
        note: String(res.note || ''),
        durationSec: Number(res.durationSec) || 0,
        extensionVersion: String(ext.version || ''),
        extensionInstalled: ext.copied === true,
        sample: Array.isArray(res.sample) ? res.sample.map((s) => String(s)) : [],
      };
    },
  }));

  // 插件卸载时精确注销这个工具。
  if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose());

  if (ctx.logger && typeof ctx.logger.info === 'function') {
    const s = readSettings();
    ctx.logger.info('[douyin] douyin_comments 工具已注册（自带扩展副本，运行时自动装进浏览器）；'
      + '当前设置：max=' + s.max + '，并发路数=' + s.lanes + '，超时=' + s.timeoutMs + 'ms，等扫码=' + s.waitLoginSec + 's'
      + '，先清空=' + (s.clearBefore ? '是' : '否') + '，回复并发=' + s.replyLanes
      + '，回复限流等待=' + s.replyThrottleSec + 's，回复无进展收工=' + s.replyNoProgressSec + 's'
      + '（可在「设置 → 插件 → dsh-douyin-comments」里改，改完立即生效）');
  }
}
