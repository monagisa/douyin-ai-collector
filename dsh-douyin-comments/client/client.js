/**
 * dsh-douyin-comments 的「客户端半身」。
 *
 * 为什么需要它：宿主侧的 `export const Config`（见 ../index.js）只让设置**数据**存在，
 * 不会自己长出入口。设置 → 插件 里那一行要有「配置」按钮，必须由客户端插件注册
 * `plugins.row.config`（key = `<包名>#<cordis.patch.yml 里 insert 的 id>`）。
 * 同一个页面也挂在 `plugins.bundle.config`（key = 包名）上，对齐 DSH 文档里
 * 「bundle 自己的配置放 plugins.bundle.config / plugins.row.config」的说法。
 *
 * 打包格式：DSH 的客户端 bundle 不是 ESM，而是 classic script + 模块表:
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => module.exports })
 * 只有 react / react-dom / @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
 * dsh-client-ui-primitives / dsh-client-ui-dockkit 这些平台种子模块能 require。
 * 取值/落盘走 configForms 服务（由 @deepseek-ai/dsh-client-ui-settings 提供）：
 *   ctx.configForms.get(ns) → { getSnapshot(), subscribe(), set(field, value), mutate(ops, rev) }
 */

window.__ModuleLoader__.load({
  id: 'dsh-douyin-comments',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    /** 与 cordis.patch.yml 里 `- id:` 一致，也是宿主设置里的 namespace（= Config 的归属） */
    var NS = 'douyin-comments';
    var PACKAGE = 'dsh-douyin-comments';
    /** 这一行在设置 → 插件 里的 key：<包名>#<row id> */
    var ROW_KEY = PACKAGE + '#' + NS;

    /** 宿主的 Config（index.js）里有哪些字段，这里就画哪些；min/max 与那边保持一致 */
    var FIELDS = [
      { key: 'max', label: '目标条数 max', kind: 'number', min: 1, max: 1000000, step: 1, suffix: '条',
        hint: '只对一级评论生效；二级回复会尽量补完。默认 80000' },
      { key: 'lanes', label: '并发路数 lanes', kind: 'number', min: 1, max: 8, step: 1, suffix: '路',
        hint: '一轮同时发几个请求；实测 4 路最快，6 路更慢且有风控风险。默认 4' },
      { key: 'timeoutMs', label: '总超时 timeoutMs', kind: 'number', min: 60000, max: 7200000, step: 60000, suffix: 'ms',
        hint: '默认 1800000（30 分钟）' },
      { key: 'waitLoginSec', label: '等扫码 waitLoginSec', kind: 'number', min: 0, max: 1800, step: 10, suffix: '秒',
        hint: '没登录时保持窗口等扫码的秒数。默认 180' },
      { key: 'clearBefore', label: '每次先清空 clearBefore', kind: 'boolean',
        hint: '关（默认）= 保留扩展的断点续采，结束时按 cid 差集只交付本轮新采的' },
      { key: 'replyLanes', label: '二级回复并发 replyLanes', kind: 'number', min: 0, max: 8, step: 1, suffix: '路',
        hint: '0 = 跟扩展内置（4 路）' },
      { key: 'replyThrottleSec', label: '回复限流等待 replyThrottleSec', kind: 'number', min: 0, max: 600, step: 5, suffix: '秒',
        hint: '0 = 跟扩展内置（10 秒）；被限流（429/风控）时最多等这么久再重试' },
      { key: 'replyNoProgressSec', label: '回复无进展收工 replyNoProgressSec', kind: 'number', min: 60, max: 7200, step: 60, suffix: '秒',
        hint: '二级回复阶段多久没有新数据就收工。默认 900' },
    ];

    var rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', flexWrap: 'wrap' };
    var labelStyle = { fontSize: '13px', minWidth: '212px', color: 'var(--dsw-alias-label-primary, inherit)' };
    var hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-caption, #8a8a8a)' };
    var inputStyle = { width: '110px', fontSize: '13px', padding: '3px 6px' };

    /** 订阅 configForms 的控制器快照（不依赖 React 18 的 useSyncExternalStore） */
    function useSnapshot(controller) {
      var pair = React.useState(function () { return controller.getSnapshot(); });
      var snapshot = pair[0];
      var setSnapshot = pair[1];
      React.useEffect(function () {
        function onChange() { setSnapshot(controller.getSnapshot()); }
        onChange();
        return controller.subscribe(onChange);
      }, [controller]);
      return snapshot;
    }

    /** 宿主 describe() 里现成的 namespace：优先精确匹配，其次唯一的 douyin* 候选，最后才用默认值 */
    function pickNamespace(ctx) {
      try {
        var view = ctx.configForms.describe().getSnapshot().view;
        var names = ((view && view.namespaces) || []).map(function (row) { return row.ns; });
        if (names.indexOf(NS) !== -1) return NS;
        var fuzzy = names.filter(function (n) { return /douyin/i.test(n); });
        if (fuzzy.length === 1) return fuzzy[0];
      } catch (e) { /* 拿不到镜像就用默认 namespace */ }
      return NS;
    }

    function summaryText(value) {
      if (!value || value.lanes === undefined) return '抖音评论采集（点「配置」改 max / 并发路数）';
      var minutes = Math.round((Number(value.timeoutMs) || 0) / 60000);
      return 'max ' + value.max + ' 条 · 并发 ' + value.lanes + ' 路 · 超时 ' + minutes + ' 分钟'
        + ' · 等扫码 ' + value.waitLoginSec + ' 秒'
        + ' · 回复并发 ' + (Number(value.replyLanes) > 0 ? value.replyLanes : '内置')
        + ' · 回复限流 ' + (Number(value.replyThrottleSec) > 0 ? value.replyThrottleSec + ' 秒' : '内置 10 秒');
    }

    function makePage(ctx) {
      var controllers = new Map();
      function controllerFor(ns) {
        var found = controllers.get(ns);
        if (found === undefined) { found = ctx.configForms.get(ns); controllers.set(ns, found); }
        return found;
      }

      function Field(props) {
        var field = props.field;
        var value = props.value;
        var disabled = props.disabled;
        var commit = props.commit;
        var pair = React.useState(value);
        var draft = pair[0];
        var setDraft = pair[1];
        React.useEffect(function () { setDraft(value); }, [value]);

        if (field.kind === 'boolean') {
          return h('label', { style: rowStyle }, [
            h('input', {
              key: 'input', type: 'checkbox', checked: draft === true, disabled: disabled,
              onChange: function (e) { setDraft(e.target.checked); commit(field.key, e.target.checked); },
            }),
            h('span', { key: 'label', style: { fontSize: '13px' } }, field.label),
            h('span', { key: 'hint', style: hintStyle }, field.hint || ''),
          ]);
        }
        var finish = function () {
          var n = Number(draft);
          if (!isFinite(n)) { setDraft(value); return; }
          n = Math.min(field.max, Math.max(field.min, n));
          setDraft(n);
          if (n !== Number(value)) commit(field.key, n);
        };
        return h('label', { style: rowStyle }, [
          h('span', { key: 'label', style: labelStyle }, field.label),
          h('input', {
            key: 'input', type: 'number', value: draft === undefined || draft === null ? '' : draft,
            min: field.min, max: field.max, step: field.step, disabled: disabled, style: inputStyle,
            onChange: function (e) { setDraft(e.target.value); },
            onBlur: finish,
            onKeyDown: function (e) { if (e.key === 'Enter') e.currentTarget.blur(); },
          }),
          field.suffix ? h('span', { key: 'suffix', style: hintStyle }, field.suffix) : null,
          h('span', { key: 'hint', style: hintStyle }, field.hint || ''),
        ]);
      }

      return function DouyinConfigPage(props) {
        var view = (props && props.view) || 'page';
        var ns = pickNamespace(ctx);
        var snapshot = useSnapshot(controllerFor(ns));
        var settled = React.useState('');
        var status = settled[0];
        var setStatus = settled[1];
        var value = (snapshot && snapshot.value) || {};

        if (view === 'summary') {
          return h('span', { style: hintStyle }, summaryText(snapshot && snapshot.value));
        }

        var commit = function (key, next) {
          setStatus('保存中…');
          Promise.resolve(controllerFor(ns).set(key, next)).then(function (ok) {
            setStatus(ok ? '已保存，立即生效' : '保存失败：宿主拒绝了这次修改');
          }, function (err) {
            setStatus('保存失败：' + String((err && err.message) || err));
          });
        };

        var state = (snapshot && snapshot.status) || 'loading';
        var disabled = state !== 'ready' || snapshot.writable === false;
        var head = h('div', { key: 'head', style: { marginBottom: '4px' } }, [
          h('div', { key: 't', style: { fontSize: '14px', fontWeight: 500 } }, '抖音评论采集'),
          h('div', { key: 'd', style: hintStyle },
            '改完立即生效（不用重启）；工具调用里的参数只覆盖那一次，不会写回这里。'),
          h('div', { key: 's', style: Object.assign({}, hintStyle, { minHeight: '18px' }) },
            state === 'loading' ? '正在读取设置…'
              : state !== 'ready' ? '这台机器上没找到这个插件的设置（namespace=' + ns + '）'
              : disabled ? '当前是只读：设置由 profile 配置文件统管'
              : status),
        ]);
        var rows = FIELDS.map(function (field) {
          return h(Field, { key: field.key, field: field, value: value[field.key], disabled: disabled, commit: commit });
        });
        return h('div', { style: { padding: '4px 0' } }, [head].concat(rows));
      };
    }

    exports.name = PACKAGE;
    /** 只用 slots；configForms 用嵌套 inject 拿，缺了也不至于让整个插件不挂载 */
    exports.inject = ['slots'];
    exports.apply = function apply(ctx) {
      ctx.inject(['configForms'], function (scoped) {
        var Page = makePage(scoped);
        scoped.slots.inject('plugins.row.config', function () {
          return scoped.slots.register({ name: 'plugins.row.config', key: ROW_KEY }, Page);
        });
        scoped.slots.inject('plugins.bundle.config', function () {
          return scoped.slots.register({ name: 'plugins.bundle.config', key: PACKAGE }, Page);
        });
      });
    };
    return module.exports;
  },
});
