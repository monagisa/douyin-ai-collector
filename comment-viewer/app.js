/* 评论分析台 · 词云 + 评论表（纯前端，无依赖）
 * 数据来源：抖音评论采集插件/扩展导出的 JSON / CSV（可整目录批量载入）
 * 隐私：全部在本机浏览器内处理，不发任何网络请求
 */
(function () {
  'use strict';

  /* ===================== 工具 ===================== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const PROFILE_BASE = 'https://www.douyin.com/user/';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtNum = (n) => {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    return String(n);
  };

  const pad2 = (n) => (n < 10 ? '0' + n : String(n));
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(Number(ts) * (String(ts).length > 10 ? 1 : 1000));
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const fmtTimeShort = (ts) => {
    const s = fmtTime(ts);
    return s ? s.slice(5) : '';
  };

  const profileOf = (user) => {
    const sec = user && user.secUid ? String(user.secUid).trim() : '';
    return sec ? PROFILE_BASE + encodeURIComponent(sec) : '';
  };

  const videoUrl = (videoId) => {
    const id = String(videoId || '').trim();
    if (!id) return '';
    const v = state.videos.get(id);
    if (v && v.url) return v.url;
    return 'https://www.douyin.com/video/' + encodeURIComponent(id);
  };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), ms);
    };
  }

  const initials = (name) => {
    const s = String(name || '').trim();
    if (!s) return '?';
    return s.slice(0, 1).toUpperCase();
  };

  // 每个用户一个稳定的淡色头像底（按昵称/ID 散列取色），只用淡色、不参与数据配色
  const avatarHue = (user) => {
    const key = String((user && (user.secUid || user.uid || user.nickname)) || '');
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    return h;
  };
  const avatarStyle = (user) => {
    const h = avatarHue(user);
    return `background:hsl(${h} 16% 18%);color:hsl(${h} 30% 78%)`;
  };

  /* ===================== 状态 ===================== */
  const state = {
    comments: [],              // 全部评论（已归一化、已去重）
    videos: new Map(),         // videoId -> { id, title, url, collectedAt }
    sources: [],               // 已载入文件名
    filters: { videoId: '', search: '', onlyHasProfile: false, onlyTopLevel: false, onlyNonEmpty: false, onlyContent: true },
    kwKeep: [],               // v0.5.41：自定义加词（长词优先，避免被切碎）
    kwBlock: [],              // v0.5.41：自定义屏蔽词
    sort: 'digg',
    page: 1,
    pageSize: 50,
    words: [],
    wordMap: new Map(),        // word -> { word, count, cids:Set }
    lastWord: '',
    cloudReady: false,
    hoverWord: '',
  };

  /* v0.5.41：自定义加词 / 屏蔽词存在 localStorage（只在本机，不上传） */
  try {
    state.kwKeep = JSON.parse(localStorage.getItem('cw.kw.keep') || '[]') || [];
    state.kwBlock = JSON.parse(localStorage.getItem('cw.kw.block') || '[]') || [];
  } catch (e) { state.kwKeep = []; state.kwBlock = []; }

  /* ===================== CSV 解析 ===================== */
  function parseCsv(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // 去掉首格为 # 的中文说明行 / 空行
    return rows.filter((r) => {
      if (!r.length) return false;
      const first = String(r[0] == null ? '' : r[0]).trim();
      if (first.startsWith('#')) return false;
      if (r.every((c) => String(c == null ? '' : c).trim() === '')) return false;
      return true;
    });
  }

  function num(v) { const n = Number(String(v == null ? '' : v).trim()); return isFinite(n) ? n : 0; }

  /* ===================== 归一化 ===================== */
  function normalizeUser(u) {
    u = u || {};
    return {
      nickname: String(u.nickname || '').trim() || '匿名用户',
      uid: u.uid ? String(u.uid) : '',
      secUid: u.sec_uid ? String(u.sec_uid) : (u.secUid ? String(u.secUid) : ''),
      uniqueId: u.unique_id ? String(u.unique_id) : (u.uniqueId ? String(u.uniqueId) : ''),
      shortId: u.short_id ? String(u.short_id) : (u.shortId ? String(u.shortId) : ''),
    };
  }

  // v2.4：导出数据本来就带清洗后的文本（`text_clean`，去表情/@/#，扩展的 cleanText() 生成）。
  // 分词优先用它；老数据/快照没有该字段时，再在 tokensOf() 里剥 [表情] 兜底。
  function cleanForTokens(raw, text) {
    const cleaned = String(raw.text_clean != null ? raw.text_clean : (raw.textClean != null ? raw.textClean : '')).trim();
    if (cleaned) return cleaned;
    return String(text || '');
  }

  function normalizeComment(raw, meta) {
    raw = raw || {};
    const text = String(raw.text != null ? raw.text : (raw.text_clean || raw.content || '')).trim();
    const cid = String(raw.cid || raw.comment_id || '');
    const user = normalizeUser(raw.user || {
      nickname: raw.user_nickname, uid: raw.user_uid, sec_uid: raw.user_sec_uid,
      unique_id: raw.user_unique_id, short_id: raw.user_short_id,
    });
    const videoId = String(raw.videoId || raw.video_id || meta.videoId || '');
    return {
      cid,
      videoId,
      videoTitle: meta.title || '',
      text,
      textClean: cleanForTokens(raw, text),
      digg: num(raw.digg_count != null ? raw.digg_count : raw.digg),
      replies: num(raw.reply_comment_total != null ? raw.reply_comment_total : raw.replies),
      ip: String(raw.ip_label || ''),
      createTime: num(raw.create_time),
      createTimeStr: String(raw.create_time_str || fmtTime(raw.create_time) || ''),
      isReply: raw.is_reply === true || String(raw.is_reply) === '1' || String(raw.is_reply).toLowerCase() === 'true' || num(raw.level) > 1,
      level: num(raw.level) || 1,
      isHot: raw.is_hot === true || String(raw.is_hot) === '1',
      isFolded: raw.is_folded === true || String(raw.is_folded) === '1',
      user,
    };
  }

  /* ===================== 载入数据 ===================== */
  function addComments(list) {
    let added = 0;
    const seen = new Set(state.comments.map((c) => c.videoId + '|' + c.cid));
    for (const c of list) {
      if (!c.text && !c.user.nickname) continue;
      const key = c.videoId + '|' + c.cid;
      if (c.cid && seen.has(key)) continue;
      seen.add(key);
      state.comments.push(c);
      added++;
    }
    return added;
  }

  function ingestJson(text, fileName) {
    let obj;
    try { obj = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (e) { toast('JSON 解析失败：' + fileName); return -1; }
    let arr = null, meta = { videoId: '', title: '' };
    if (Array.isArray(obj)) arr = obj;
    else if (obj && Array.isArray(obj.comments)) {
      arr = obj.comments;
      meta.videoId = String(obj.videoId || obj.video_id || '');
      meta.title = String(obj.title || '');
    } else if (obj && obj.data && Array.isArray(obj.data.comments)) {
      arr = obj.data.comments;
    }
    if (!arr) { toast('这个 JSON 里没有 comments 数组：' + fileName); return -1; }
    if (meta.videoId) {
      state.videos.set(meta.videoId, {
        id: meta.videoId, title: meta.title || '视频 ' + meta.videoId.slice(-8),
        url: obj.url || ('https://www.douyin.com/video/' + meta.videoId),
        collectedAt: obj.collectedAt || '',
      });
    }
    const list = arr.map((c) => normalizeComment(c, meta));
    return addComments(list);
  }

  function ingestCsv(text, fileName) {
    const rows = parseCsv(text);
    if (!rows.length) { toast('CSV 是空的：' + fileName); return -1; }
    const header = rows[0].map((h) => String(h || '').trim());
    const idx = {};
    header.forEach((h, i) => { idx[h] = i; });
    if (idx.cid == null && idx.text == null) { toast('这不是评论导出 CSV：' + fileName); return -1; }
    const hasVideoCol = idx.video_id != null;
    let curMeta = { videoId: '', title: '' };
    if (!hasVideoCol) {
      // 单视频 CSV：从文件名里取 videoId
      const m = String(fileName || '').match(/(\d{15,25})/);
      if (m) {
        curMeta.videoId = m[1];
        if (!state.videos.has(m[1])) {
          state.videos.set(m[1], { id: m[1], title: '视频 ' + m[1].slice(-8), url: 'https://www.douyin.com/video/' + m[1], collectedAt: '' });
        }
      }
    }
    const get = (r, key) => (idx[key] != null ? r[idx[key]] : '');
    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const vid = hasVideoCol ? String(get(r, 'video_id') || '').trim() : curMeta.videoId;
      if (hasVideoCol && vid && !state.videos.has(vid)) {
        state.videos.set(vid, { id: vid, title: '视频 ' + vid.slice(-8), url: 'https://www.douyin.com/video/' + vid, collectedAt: '' });
      }
      const meta = { videoId: vid, title: (state.videos.get(vid) || {}).title || '' };
      list.push(normalizeComment({
        cid: get(r, 'cid'),
        text: get(r, 'text') || get(r, 'text_clean'),
        text_clean: get(r, 'text_clean'),
        digg_count: get(r, 'digg_count'),
        reply_comment_total: get(r, 'reply_comment_total'),
        ip_label: get(r, 'ip_label'),
        create_time: get(r, 'create_time'),
        create_time_str: get(r, 'create_time_str'),
        is_reply: get(r, 'is_reply'),
        level: get(r, 'level'),
        is_hot: get(r, 'is_hot'),
        is_folded: get(r, 'is_folded'),
        user_nickname: get(r, 'user_nickname'),
        user_uid: get(r, 'user_uid'),
        user_sec_uid: get(r, 'user_sec_uid'),
        user_unique_id: get(r, 'user_unique_id'),
        user_short_id: get(r, 'user_short_id'),
      }, meta));
    }
    return addComments(list);
  }

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.(json|csv)$/i.test(f.name));
    if (!files.length) { toast('没有找到 .json / .csv 文件'); return; }
    setLoading(true);
    let total = 0;
    const names = [];
    for (const f of files) {
      try {
        const text = await f.text();
        const n = /\.json$/i.test(f.name) ? ingestJson(text, f.name) : ingestCsv(text, f.name);
        if (n >= 0) {
          total += n;
          names.push(f.name);
        }
      } catch (e) {
        console.warn('读取失败', f.name, e);
      }
    }
    state.sources = state.sources.concat(names);
    updateScope();
    updateEmptyState();
    $('#btnClear').disabled = state.comments.length === 0;
    if (total > 0) toast(`载入 ${total} 条评论（${names.length} 个文件）`);
    else toast('没有新增评论（可能是重复文件）');
    setLoading(false);
    refreshAll();
  }

  /* ===================== 过滤 ===================== */
  function filtered() {
    const f = state.filters;
    const q = f.search.trim().toLowerCase();
    return state.comments.filter((c) => {
      if (f.videoId && c.videoId !== f.videoId) return false;
      if (f.onlyHasProfile && !profileOf(c.user)) return false;
      if (f.onlyTopLevel && c.isReply) return false;
      if (f.onlyNonEmpty && !c.text) return false;
      if (q) {
        const hay = (c.text + ' ' + c.user.nickname + ' ' + c.user.uniqueId + ' ' + c.ip).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /* ===================== 分词 ===================== */
  const STOPWORDS = new Set((
    '的 了 是 在 我 你 他 她 它 们 这 那 有 和 就 都 也 又 还 要 会 能 可以 不是 没有 一个 这个 那个 ' +
    '什么 怎么 为什么 因为 所以 但是 然后 而且 如果 就是 这样 那样 这么 那么 自己 我们 你们 他们 ' +
    '她们 它们 人家 别人 大家 真的 真是 确实 其实 应该 可能 觉得 感觉 知道 看到 看过 听到 时候 ' +
    '现在 之前 以后 一样 一直 已经 还是 只是 不过 有点 一点 一些 这些 那些 多少 几个 一次 一下 ' +
    '评论 回复 视频 抖音 作者 楼主 主播 up 啊 吧 呢 吗 呀 哦 嗯 哈 啦 嘛 哇 呵 嘿 诶 哎 唉 么 ' +
    '哇塞 哈哈哈 哈哈哈哈 呵呵 嘿嘿 666 233 999 111 1111 2333 555 干嘛 咋 咱 俺 啥 嘞 咯 嗷 呜 喵 ' +
  '必须 直接 肯定 一定 主要 以及 中的 的话 之类 等等 以为 希望 想要 需要 为了 要是 还有 才有 都要 没了 不对 一句 一段 一眼 看完 出来 上去 下去 起来 下来 过去 回去 以前 之后 刚才 马上 立刻 终于 甚至 反而 竟然 居然 果然 依然 仍然 偶尔 总是 经常 有时 从来 一向 还要 会不会 能不能 是不是 有没有 怎么办 怎么样 什么时候 干什么 什么样 什么的 或者 来说 来讲 似的 一般 差不多 一会 一下 一起 这种 那种 哪种 各种 这种 都是 才是 也是 还是 只是 就是 而是 于是 但是 可是 因此 所以 如果 虽然 不管 无论 即使 尽管 只要 只有 除了 关于 对于 由于 按照 根据 通过 经过 沿着 随着 直到 等到'
  ).split(/\s+/).filter(Boolean));

  /* v0.5.41：按社区做法（jieba 系 + 中文停用词四表的口径）补齐常见泛词，
   * 让「真的 / 感觉 / 很多 / 这种 / 都是」这类词在词云里自然消失。 */
  for (const w of (
    '真的 感觉 觉得 知道 认为 以为 希望 想要 需要 应该 必须 一定 肯定 估计 可能 或许 大概 差不多 几乎 简直 实在 确实 其实 本来 原来 果然 竟然 居然 反而 甚至 尤其 特别 非常 十分 相当 比较 稍微 略微 更加 越来越 太多 好多 很多 不少 有些 挺多 一堆 一大 全都 全部 整个 所有 每个 任何 某些 其他 其它 剩下 别的 另外 此外 而且 并且 或者 还不如 不如 要不 不然 否则 因此 所以 于是 然后 接着 随后 最后 首先 其次 总之 反正 究竟 到底 毕竟 何况 况且 再说 至于 关于 对于 根据 按照 依照 通过 经过 凭借 由于 因为 为了 除了 除非 即使 即便 哪怕 无论 不管 不论 只要 虽然 尽管 但是 可是 不过 然而 只是 就算 如果 要是 假如 万一 一旦 直到 等到 每当 之前 之后 以前 以后 现在 目前 当时 那时 这时 此时 同时 立刻 马上 立即 刚刚 刚才 已经 曾经 从来 一向 一直 始终 总是 经常 常常 时常 有时 偶尔 很少 从不 再次 重新 继续 仍然 依然 依旧 仍旧 还要 还没 还没有 不用 不要 不能 不会 不敢 不想 不需要 说不定 不一定 不可能 不错 不好 好看 不起 老是 不知道 不打 还好 好听 好玩 可爱 漂亮 厉害 牛逼 牛批 牛皮 离谱 逆天 绝了 完了 笑死 笑了 感动 无语 服了 麻了 破防 上头 东西 事情 时候 时间 地方 方式 方法 方面 问题 情况 样子 意思 内容 部分 结果 原因 感觉 心里 希望 想法 办法 事情 过程 水平 大家 大家伙 各位 咱们 我们 你们 他们 她们 它们 自己 别人 人家 有人 没人 谁都 什么 啥 咋 咋样 怎么办 怎么样 什么样 为什么 为啥 什么时候 哪里 哪儿 这里 那里 这边 那边 这样 那样 这么 那么 这种 那种 哪种 这些 那些 哪些 这个 那个 哪个 一次 一下 一会 一起 一直 一边 一样 一般 一致 一切 一共 一点 一半 一天 一年 一句 一段 一条 一遍 一层 一群 一批 一部分 一方面 双方 彼此 互相 相互 各种 各自 每次 每天 每年 某个 某些 是不是 有没有 要不要 会不会 能不能 对不对 好不好 行不行 可不可以 有没有人 我说 你说 他说 她说 我说真的 我觉 你们觉得 我觉得 说实话 说真的 说白了 换句话说 也就是 也就是说 也就是说 另一方面 与此同时 除此之外 不仅如此 由此可见 总的来说 简单说 总之 唉 哎 哎呀 哎哟 天哪 天啊 我的天 妈呀 卧槽 我靠 哈哈哈 哈哈 呵呵 嘿嘿 嘻嘻 么么 哇哦 嗯嗯 对对 好好 是是 行行 可以可以 谢谢 感谢 多谢 辛苦 支持 关注 收藏 转发 分享 弹幕 直播 主播 作者 楼主 老铁 兄弟 姐姐 哥哥 妹妹 弟弟 朋友 视频 评论 回复 点赞 投币 三连 关注了 已关注 取关 前排 沙发 板凳 路过 打卡 签到 首次 第一次 上次 下次 这次 那次 刚才 刚刚 突然 忽然 立刻 最终 终于 好像 似乎 显然 明显 确实 的确 真的 真是 简直 完全 全部 整体 总体'
  ).split(/\s+/)) if (w) STOPWORDS.add(w);

  /* v0.5.40：只看虚词字符组成的词直接丢掉（都是 / 这种 / 我的 / 出来 / 中的…）。
   * 依据是「实词至少有一个非虚词字符」，这样不用维护几千条停用词也能过滤掉大部分口头词。 */
  const FUNCTION_CHARS = new Set(('的是我你他她它们这那个也就都还又和与在有不会能可要什么怎样些点时候一二三不没很太更最对错上下中内外到说看想做去来出进过回从被把给跟于为以因此所以就而且并且但是然后如果虽然不过只是当然因为所以着了吧呢吗啊呀哦嗯啦嘛哇种才里完句直真错对同再又').split(''));
  function isFunctionOnly(t) {
    for (const ch of t) if (!FUNCTION_CHARS.has(ch)) return false;
    return true;
  }

  let segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
  } catch (e) { segmenter = null; }

  function tokensOf(text) {
    const out = [];
    // v2.3：抖音表情是 [憨笑] [流泪] 这种方括号标签文本，直接分词会把标签名当成词（点进去只有一条「[悲伤]」）。
    // 分词前先把方括号标签剥掉，纯表情评论因此不贡献任何关键词。
    const s = String(text || '').replace(/\[[^\[\]]{1,12}\]/g, ' ');
    if (!s.trim()) return out;
    if (segmenter) {
      for (const seg of segmenter.segment(s)) {
        if (!seg.isWordLike) continue;
        out.push(seg.segment);
      }
    } else {
      // 兜底：中文取 2-gram，英文/数字按词
      const parts = s.match(/[A-Za-z][A-Za-z0-9'+.-]*|\d+(?:\.\d+)?|[\u4e00-\u9fff]+/g) || [];
      for (const p of parts) {
        if (/^[\u4e00-\u9fff]+$/.test(p)) {
          if (p.length === 1) out.push(p);
          else for (let i = 0; i + 2 <= p.length; i++) out.push(p.slice(i, i + 2));
        } else out.push(p);
      }
    }
    // v0.5.41：自定义加词——Intl.Segmenter 没有词典，会把「酒池肉林」切成「酒池 / 肉林」，
    // 用户把整词加进来后，只要原文里出现就按整词计一次（每条评论内仍去重）。
    if (state.kwKeep && state.kwKeep.length) {
      const low = s.toLowerCase();
      for (const kw of state.kwKeep) if (kw && low.indexOf(kw) >= 0) out.push(kw);
    }
    return out;
  }

  function cleanToken(w, strict) {
    let t = String(w || '').trim();
    if (!t) return '';
    t = t.replace(/[\s\u3000]+/g, '');
    if (!t) return '';
    if (/^[\d.,%+\-/:]+$/.test(t)) return '';
    if (/^[A-Za-z]+$/.test(t)) t = t.toLowerCase();
    if (t.length < 2) return '';
    if (strict !== false) {
      if (STOPWORDS.has(t.toLowerCase())) return '';
      if (isFunctionOnly(t)) return '';      // v0.5.40：这种 / 都是 / 我的 …
    }
    if (/^(.)\1{2,}$/.test(t)) return '';       // 啊啊啊
    return t;
  }

  function parseWordList(v) {
    const out = [];
    for (const raw of String(v || '').split(/[,，、;；\s]+/)) {
      const t = raw.trim().toLowerCase();
      if (t.length >= 2 && out.indexOf(t) === -1) out.push(t);
    }
    return out.slice(0, 200);
  }

  function applyWordLists() {
    const keepEl = $('#kwKeep'), blockEl = $('#kwBlock');
    state.kwKeep = parseWordList(keepEl ? keepEl.value : '');
    state.kwBlock = parseWordList(blockEl ? blockEl.value : '');
    try {
      localStorage.setItem('cw.kw.keep', JSON.stringify(state.kwKeep));
      localStorage.setItem('cw.kw.block', JSON.stringify(state.kwBlock));
    } catch (e) {}
    refreshAll();
  }

  function buildWords(comments) {
    const map = new Map();
    const blockSet = new Set(state.kwBlock || []);
    const keepSet = new Set(state.kwKeep || []);
    let docN = 0;
    for (const c of comments) if (c.text) docN++;
    for (const c of comments) {
      if (!c.text) continue;
      const seen = new Set();
      for (const raw of tokensOf(c.textClean || c.text)) {
        const isKeep = keepSet.has(String(raw || '').toLowerCase());
        const w = isKeep ? String(raw).toLowerCase() : cleanToken(raw, state.filters.onlyContent !== false);
        if (!w || seen.has(w) || blockSet.has(w)) continue;
        seen.add(w);
        let rec = map.get(w);
        if (!rec) { rec = { word: w, count: 0, weight: 0, ratio: 0, generic: false, cids: new Set(), users: new Set() }; map.set(w, rec); }
        rec.count++;
        if (c.cid) rec.cids.add(c.cid);
        rec.users.add(c.user.secUid || c.user.uid || c.user.nickname);
      }
    }
    // v0.5.41：轻量 IDF（对标 jieba.analyse 的 TF-IDF 思路，但只用本视频语料，不用外部语料）：
    //   weight = df * log(1 + N / df)，N = 有文字的评论数
    // 同时把「这条视频里到处都在说」的泛词（df/N > 40% 且样本 ≥ 30 条）直接剔除。
    const out = [];
    for (const rec of map.values()) {
      rec.ratio = docN ? rec.count / docN : 0;
      rec.weight = rec.count * Math.log(1 + (docN || 1) / Math.max(1, rec.count));
      rec.generic = docN >= 30 && rec.ratio > 0.4;
      if (!rec.generic) out.push(rec);
    }
    return out.sort((a, b) => b.weight - a.weight || b.count - a.count || a.word.localeCompare(b.word));
  }

  /* ===================== KPI ===================== */
  function renderKpis(list) {
    const users = new Set();
    let digg = 0, hot = 0, topLevel = 0;
    for (const c of list) {
      users.add(c.user.secUid || c.user.uid || c.user.nickname);
      digg += c.digg;
      if (c.digg >= 100) hot++;
      if (!c.isReply) topLevel++;
    }
    const avg = list.length ? (digg / list.length) : 0;
    const pct = (n) => (list.length ? Math.round(n / list.length * 100) : 0) + '%';
    const cells = [
      { k: '评论数', v: fmtNum(list.length), s: '条' },
      { k: '参与用户', v: fmtNum(users.size), s: '人' },
      { k: '关键词', v: fmtNum(state.words.length), s: '个' },
      { k: '平均点赞', v: fmtNum(Math.round(avg * 10) / 10), s: '' },
      { k: '高赞（≥100 赞）', v: fmtNum(hot), s: '条' },
      { k: '一级评论', v: pct(topLevel), s: fmtNum(topLevel) + ' 条' },
    ];
    $('#kpis').innerHTML = cells.map((c) => `
      <div class="kpi">
        <div class="k">${esc(c.k)}</div>
        <div class="v">${esc(c.v)}<small>${esc(c.s || '')}</small></div>
      </div>`).join('');
  }

  function updateScope() {
    const el = $('#sourceInfo');
    if (!state.comments.length) { el.textContent = '未载入数据'; return; }
    const parts = [
      `${state.videos.size} 个视频`,
      `${fmtNum(state.comments.length)} 条评论`,
      `${state.sources.length} 个文件`,
    ];
    el.textContent = parts.join(' · ') + (state.videos.size === 1 ? ' · 单条视频' : '');
  }

  // v2.9：加载骨架屏（读文件 / 解析 JSON 时先占位，避免白屏和跳动）
  let skeletonBuilt = false;
  let wordListStash = null;
  function buildSkeletons() {
    if (skeletonBuilt) return;
    skeletonBuilt = true;
    // v2.6：词云骨架改成几块「大块」铺在面板里（以前 18 条细碎小条看着乱）
    const cloud = $('#skCloud');
    if (cloud) {
      const blocks = [{"l":6,"t":10,"w":11,"h":11},{"l":8,"t":26,"w":26,"h":30},{"l":37,"t":17,"w":30,"h":41},{"l":70,"t":23,"w":22,"h":27},{"l":16,"t":62,"w":18,"h":17},{"l":39,"t":66,"w":23,"h":15},{"l":66,"t":58,"w":25,"h":13},{"l":82,"t":74,"w":12,"h":14}];
      cloud.innerHTML = blocks
        .map((b, i) => `<i style="left:${b.l}%;top:${b.t}%;width:${b.w}%;height:${b.h}%;animation-delay:${(i * 0.08).toFixed(2)}s"></i>`)
        .join('');
    }
    const tb = $('#skTable');
    if (tb) {
      tb.innerHTML = Array.from({ length: 8 }, () =>
        '<div class="sk-row"><i style="width:44%"></i><i style="width:12%"></i><i style="width:6%"></i><i style="width:6%"></i><i style="width:8%"></i></div>'
      ).join('');
    }
  }
  function setLoading(on) {
    if (on) buildSkeletons();
    document.body.classList.toggle('is-loading', !!on);
    const c = $('#skCloud');
    if (c) c.hidden = !on;
    const t = $('#skTable');
    if (t) t.hidden = !on;
    const k = $('#kpis');
    if (k) k.setAttribute('aria-busy', on ? 'true' : 'false');
    const wl = $('#wordList');
    if (wl) {
      if (on) {
        wordListStash = wl.innerHTML;
        wl.innerHTML = '';
        [72, 54, 64, 46, 58, 40, 50, 36].forEach((w) => {
          const li = document.createElement('li');
          li.className = 'sk-li';
          li.innerHTML = '<i style="width:' + w + '%"></i>';
          wl.appendChild(li);
        });
        wl.scrollTop = 0;
      } else {
        wl.querySelectorAll('.sk-li').forEach((li) => li.remove());
        if (wordListStash != null) {
          wl.innerHTML = wordListStash;
          wordListStash = null;
        }
      }
    }
  }

  function updateEmptyState() {
    const empty = state.comments.length === 0;
    document.body.classList.toggle('is-empty', empty);
    const el = $('#cloudEmpty');
    if (el) el.classList.toggle('hidden', !empty);
  }

  /* ===================== 视频下拉 ===================== */
  function renderVideoFilter() {
    const sel = $('#videoFilter');
    const cur = state.filters.videoId;
    const counts = new Map();
    for (const c of state.comments) counts.set(c.videoId, (counts.get(c.videoId) || 0) + 1);
    const opts = ['<option value="">全部视频（' + state.comments.length + ' 条评论）</option>'];
    const list = Array.from(state.videos.values()).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
    for (const v of list) {
      const n = counts.get(v.id) || 0;
      if (!n) continue;
      const label = (v.title || ('视频 ' + String(v.id).slice(-8))) + `（${n} 条）`;
      opts.push(`<option value="${esc(v.id)}">${esc(label)}</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = cur;
    // 「打开原视频 ↗」：选中某条视频时可用；只载入了一条视频时默认可用
    const btn = $('#btnOpenVideo');
    const onlyId = state.videos.size === 1 ? Array.from(state.videos.keys())[0] : '';
    const target = cur || onlyId;
    const meta = target ? (state.videos.get(target) || {}) : null;
    btn.disabled = !target;
    btn.dataset.videoId = target || '';
    btn.title = target
      ? '在新标签页打开抖音视频页：' + ((meta && meta.title) || target)
      : '先在左侧选一条视频（或只载入一条视频）';
  }

  /* ===================== 词云布局 ===================== */
  // 词云只用一支色阶：前 6 个高频词用强调色（数据色），其余两级中性灰。
  function wordTier(rank) {
    if (rank < 6) return { color: '#e0a94a', weight: 600 };
    if (rank < 26) return { color: '#c2c2c7', weight: 500 };
    return { color: '#8e8e94', weight: 400 };
  }

  function measureWord(word, fontSize, cloud) {
    const span = document.createElement('span');
    span.className = 'cw';
    span.textContent = word;
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.style.whiteSpace = 'nowrap';
    span.style.fontSize = fontSize + 'px';
    span.style.fontWeight = '600';
    span.style.letterSpacing = '0.5px';    cloud.appendChild(span);
    const w = span.offsetWidth, h = span.offsetHeight;
    cloud.removeChild(span);
    return { w: Math.max(w, 8), h: Math.max(h, 8) };
  }

  function layoutCloud(words, cloud) {
    const W = cloud.clientWidth, H = cloud.clientHeight;
    if (!W || !H || !words.length) return [];
    cloud.innerHTML = '';
    const placed = [];
    const pad = 6;
    const maxWords = words.length;
    // v0.5.41：字号按 IDF 权重（而不是纯词频），泛词自动变小
    const minCount = words[maxWords - 1] ? words[maxWords - 1].weight : 1;
    const maxCount = words[0] ? words[0].weight : 1;
    const maxFont = Math.max(24, Math.min(60, Math.round(Math.min(W, H) / 7.5)));
    const minFont = 13;

    const sizeOf = (c) => {
      const t = maxCount === minCount ? 1 : (Math.sqrt(c) - Math.sqrt(minCount)) / (Math.sqrt(maxCount) - Math.sqrt(minCount));
      return Math.round(minFont + (maxFont - minFont) * Math.max(0, Math.min(1, t)));
    };

    const cx = W / 2, cy = H / 2;
    // 把阿基米德螺旋归一化到椭圆里，避免只用水平方向铺、留下上下一大片空白
    const rx = Math.max(40, cx - pad), ry = Math.max(40, cy - pad);

    for (let i = 0; i < maxWords; i++) {
      const rec = words[i];
      const fs = sizeOf(rec.weight);
      const m = measureWord(rec.word, fs, cloud);
      if (m.w > W - pad * 2) continue;
      let angle = (i % 2 === 0 ? 1 : -1) * 0.35;
      let okRect = null;
      for (let step = 0; step < 2600; step++) {
        const sr = 0.055 * Math.pow(Math.max(angle, 0.001), 0.85);
        const x = cx + Math.cos(angle) * sr * rx - m.w / 2;
        const y = cy + Math.sin(angle) * sr * ry - m.h / 2;
        const rect = { x, y, w: m.w, h: m.h };
        if (x >= pad && y >= pad && x + m.w <= W - pad && y + m.h <= H - pad) {
          let hit = false;
          for (const p of placed) {
            if (rect.x < p.x + p.w + 3 && rect.x + rect.w + 3 > p.x &&
                rect.y < p.y + p.h + 2 && rect.y + rect.h + 2 > p.y) { hit = true; break; }
          }
          if (!hit) { okRect = rect; break; }
        }
        angle += 0.38;
      }
      if (!okRect) continue;
      const span = document.createElement('span');
      span.className = 'cw';
      span.textContent = rec.word;
      span.dataset.word = rec.word;
      span.style.left = Math.round(okRect.x) + 'px';
      span.style.top = Math.round(okRect.y) + 'px';
      span.style.fontSize = fs + 'px';
      const tier = wordTier(placed.length);
      span.style.color = tier.color;
      span.style.fontWeight = String(tier.weight);
      cloud.appendChild(span);
      placed.push(okRect);
    }
    return placed;
  }

  /* ===================== 词云交互 ===================== */
  let hideTipTimer = null;

  function wordSamples(rec, n) {
    const out = [];
    for (const c of state.comments) {
      if (!c.text) continue;
      if (rec.cids.has(c.cid) || (c.cid === '' && tokensOf(c.textClean || c.text).map(cleanToken).indexOf(rec.word) >= 0)) {
        out.push(c);
        if (out.length >= n) break;
      }
    }
    return out;
  }

  function showTooltip(span, rec) {
    // v2.1：先清掉「上一个词 mouseout 排下的隐藏定时器」，否则快速从一个词扫到另一个词时，
    // 新弹框会在 180ms 后被旧定时器关掉——表现为「有时候悬停不弹框」。
    clearTimeout(hideTipTimer);
    hideTipTimer = null;
    const tip = $('#tooltip');
    const samples = wordSamples(rec, 2);
    const userCount = rec.users ? rec.users.size : 0;
    const items = samples.map((c) => {
      const href = profileOf(c.user);
      const tag = href ? 'a' : 'div';
      const attrs = href ? ` href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : '';
      const go = href ? ' · <span class="go">点这里打开 TA 的主页 ↗</span>' : ' · <span class="go">（该用户无主页信息）</span>';
      return `<${tag} class="tt-item"${attrs}>
        <div class="tt-txt">${esc(c.text || '（无文字）')}</div>
        <div class="tt-user">${esc(c.user.nickname)}${go}</div>
      </${tag}>`;
    }).join('');
    tip.innerHTML = `
      <div class="tt-word">${esc(rec.word)}</div>
      <div class="tt-meta">出现 ${rec.count} 条评论 · ${userCount} 位用户说了这个词</div>
      <div class="tt-comments">${items || '<div class="muted small">没有可展示的样例评论</div>'}</div>
      <div class="tt-more" data-act="open-drawer">查看全部 ${rec.count} 条 →</div>`;
    tip.classList.remove('hidden');
    positionTooltip(span);
    tip.onmouseenter = () => clearTimeout(hideTipTimer);
    tip.onmouseleave = () => hideTooltip();
    const more = tip.querySelector('[data-act="open-drawer"]');
    if (more) more.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(rec.word); });
  }

  function positionTooltip(span) {
    const tip = $('#tooltip');
    const r = span.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const gap = 12;
    // 悬浮框本身可点（样例评论 → 主页），所以要尽量别盖住词：鼠标进不到词上就会出现
    // 「悬停 A 却显示 B 的框」。做法：在词云面板内试上/下/左/右四个位置，取压住词面积最小的。
    const cloudRect = $('#cloud').getBoundingClientRect();
    const wordRects = $$('.cw', $('#cloud')).map((el) => el.getBoundingClientRect());
    const overlapArea = (x, y) => {
      let sum = 0;
      for (const w of wordRects) {
        const ox = Math.min(x + tw, w.right + 4) - Math.max(x, w.left - 4);
        const oy = Math.min(y + th, w.bottom + 4) - Math.max(y, w.top - 4);
        if (ox > 0 && oy > 0) sum += ox * oy;
      }
      return sum;
    };
    const inside = (x, y) => x >= cloudRect.left + 4 && y >= cloudRect.top + 4 &&
      x + tw <= cloudRect.right - 4 && y + th <= cloudRect.bottom - 4;
    const clampTo = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const loX = cloudRect.left + 6, hiX = cloudRect.right - tw - 6;
    const loY = cloudRect.top + 6, hiY = cloudRect.bottom - th - 6;
    const cands = [
      { x: r.left + r.width / 2 - tw / 2, y: r.top - th - gap },        // 上
      { x: r.left + r.width / 2 - tw / 2, y: r.bottom + gap },          // 下
      { x: r.right + gap + 2, y: r.top + r.height / 2 - th / 2 },       // 右
      { x: r.left - tw - gap - 2, y: r.top + r.height / 2 - th / 2 },   // 左
    ].map((c) => ({
      x: clampTo(Math.round(c.x), loX, Math.max(loX, hiX)),
      y: clampTo(Math.round(c.y), loY, Math.max(loY, hiY)),
    }));
    let best = null, bestScore = Infinity;
    for (const c of cands) {
      // 越界（词云面板放不下）优先扣分；再按压住词的总面积排序
      const score = overlapArea(c.x, c.y) + (inside(c.x, c.y) ? 0 : 1e9);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (!best) return;
    tip.style.left = best.x + 'px';
    tip.style.top = best.y + 'px';
  }

  function hideTooltip() {
    clearTimeout(hideTipTimer);
    hideTipTimer = setTimeout(() => { $('#tooltip').classList.add('hidden'); }, 180);
  }

  function bindCloudHover() {
    const cloud = $('#cloud');

    function activate(span) {
      const rec = state.wordMap.get(span.dataset.word);
      if (!rec) return;
      if (state.hoverWord !== rec.word) {
        state.hoverWord = rec.word;
        $$('.cw', cloud).forEach((el) => {
          if (el === span) { el.classList.add('hot'); el.classList.remove('dim'); }
          else { el.classList.add('dim'); el.classList.remove('hot'); }
        });
      }
      showTooltip(span, rec);
    }

    cloud.addEventListener('mouseover', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      activate(span);
    });
    // 兜底：tooltip 是浮在词云上的可点面板，会挡住它下面的词，光靠 mouseover 就会出现
    // 「悬停 A 却显示 B 的框 / 悬停了不弹」。这里在 document 上按鼠标坐标做几何命中，
    // 即使指针落在 tooltip 上，只要下面有词就切到那个词。
    function clearHighlight() {
      $$('.cw', cloud).forEach((el) => { el.classList.remove('hot'); el.classList.remove('dim'); });
      state.hoverWord = '';
    }
    let moveRaf = 0;
    let lastPt = null;
    document.addEventListener('mousemove', (e) => {
      lastPt = { x: e.clientX, y: e.clientY };
      // 指针在抽屉里（抽屉会盖住词云右半边）时不要再去命中它背后的词，
      // 否则翻抽屉时词云会莫名其妙地高亮。
      const inDrawer = e.target && e.target.closest ? !!e.target.closest('#drawer') : false;
      if (inDrawer) {
        if (state.hoverWord) clearHighlight();
        return;
      }
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (!lastPt) return;
        const p = lastPt;
        const spans = $$('.cw', cloud);
        let hit = null;
        for (const el of spans) {
          const r = el.getBoundingClientRect();
          if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) { hit = el; break; }
        }
        // 指针不在任何词上（空处 / 悬浮框上）就必须把高亮清掉。
        // 否则从悬浮框里移出来时，那个词没有 mouseout 事件，会一直亮着、别的词一直变淡，
        // 看起来就是「没悬浮在词上却高亮了」。
        if (!hit) {
          if (state.hoverWord) clearHighlight();
          return;
        }
        const tip = $('#tooltip');
        if (state.hoverWord === hit.dataset.word && !tip.classList.contains('hidden')) return;
        activate(hit);
      });
    });
    document.addEventListener('mouseleave', () => {
      clearHighlight();
      hideTooltip();
    });
    cloud.addEventListener('mouseout', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.cw') : null;
      if (to === span) return;
      span.classList.remove('hot');
      if (!to) {
        $$('.cw', cloud).forEach((el) => el.classList.remove('dim'));
        state.hoverWord = '';
      }
      hideTooltip();
    });
    cloud.addEventListener('click', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      openDrawer(span.dataset.word);
    });
  }

  /* ===================== 侧栏关键词 ===================== */
  function renderWordList() {
    const list = $('#wordList');
    const top = state.words.slice(0, 30);
    const max = top.length ? top[0].count : 1;
    $('#wordInfo').textContent = state.words.length ? `${state.words.length} 个词 · 点击看评论` : '';
    if (!top.length) {
      list.innerHTML = '<li class="muted small" style="display:block;cursor:default">暂无关键词</li>';
      return;
    }
    list.innerHTML = top.map((w, i) => `
      <li data-word="${esc(w.word)}">
        <span class="rank">${i + 1}</span>
        <span class="w" title="${esc(w.word)}">${esc(w.word)}</span>
        <span class="n">${w.count}</span>
      </li>`).join('');
  }

  /* ===================== 抽屉 ===================== */
  const drawer = { word: '', list: [], shown: 0, pageStep: 20 };

  function commentsWithWord(word) {
    const out = [];
    const rec = state.wordMap.get(word);
    for (const c of filtered()) {
      if (!c.text) continue;
      const has = rec && c.cid ? rec.cids.has(c.cid) : tokensOf(c.textClean || c.text).map(cleanToken).indexOf(word) >= 0;
      if (has) out.push(c);
    }
    out.sort((a, b) => b.digg - a.digg);
    return out;
  }

  function openDrawer(word) {
    const list = commentsWithWord(word);
    drawer.word = word;
    drawer.list = list;
    drawer.shown = 0;
    $('#drawerTitle').textContent = '「' + word + '」';
    $('#drawerSub').textContent = `${list.length} 条评论包含这个词（按点赞降序）`;
    $('#drawerBody').innerHTML = '';
    $('#drawer').classList.remove('hidden');
    $('#tooltip').classList.add('hidden');
    renderDrawerMore();
  }

  function renderDrawerMore() {
    const body = $('#drawerBody');
    const next = drawer.list.slice(drawer.shown, drawer.shown + drawer.pageStep);
    if (!drawer.shown && !drawer.list.length) {
      body.innerHTML = '<div class="empty small">没有找到包含这个词的评论</div>';
    }
    const frag = document.createElement('div');
    frag.innerHTML = next.map((c) => {
      const href = profileOf(c.user);
      const go = href
        ? `<a class="dc-go" href="${esc(href)}" target="_blank" rel="noopener noreferrer">打开主页 ↗</a>`
        : '<span class="dc-go off" title="导出数据里没有 sec_uid">无主页信息</span>';
      const badges = [
        c.isHot ? '<span class="badge hot">热评</span>' : '',
        c.isReply ? '<span class="badge reply">回复</span>' : '',
        c.isFolded ? '<span class="badge fold">折叠</span>' : '',
      ].join('');
      return `<div class="dc">
        <div class="dc-head">
          <div class="dc-user">
            <span class="avatar" style="${esc(avatarStyle(c.user))}">${esc(initials(c.user.nickname))}</span>
            <div class="user-meta">
              <span class="user-name">${esc(c.user.nickname)}</span>
              <span class="user-sub">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : 'ID ' + String(c.user.uid || '').slice(-8)))}</span>
            </div>
          </div>
          ${go}
        </div>
        <div class="dc-text">${esc(c.text || '（无文字）')}</div>
        <div class="dc-meta">
          <span>赞 ${fmtNum(c.digg)}</span>
          <span>回复 ${fmtNum(c.replies)}</span>
          ${c.ip ? `<span>属地 ${esc(c.ip)}</span>` : ''}
          <span>${esc(c.createTimeStr || fmtTimeShort(c.createTime))}</span>
          <span class="spacer"></span>
          ${badges}
        </div>
      </div>`;
    }).join('');
    while (frag.firstChild) body.appendChild(frag.firstChild);
    drawer.shown += next.length;
    const more = $('#btnDrawerMore');
    more.disabled = drawer.shown >= drawer.list.length;
    more.textContent = drawer.shown >= drawer.list.length
      ? `已全部显示（${drawer.list.length} 条）`
      : `加载更多（还有 ${drawer.list.length - drawer.shown} 条）`;
  }

  function closeDrawer() { $('#drawer').classList.add('hidden'); }

  /* ===================== 表格 ===================== */
  function sortList(list) {
    const arr = list.slice();
    const by = state.sort;
    if (by === 'digg') arr.sort((a, b) => b.digg - a.digg || b.createTime - a.createTime);
    else if (by === 'time') arr.sort((a, b) => b.createTime - a.createTime || b.digg - a.digg);
    else if (by === 'len') arr.sort((a, b) => b.text.length - a.text.length || b.digg - a.digg);
    else if (by === 'replies') arr.sort((a, b) => b.replies - a.replies || b.digg - a.digg);
    return arr;
  }

  function highlight(text, q) {
    if (!q) return esc(text);
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx === -1) return esc(text);
    let out = '', i = 0;
    while (idx !== -1) {
      out += esc(text.slice(i, idx)) + '<span class="hl">' + esc(text.slice(idx, idx + q.length)) + '</span>';
      i = idx + q.length;
      idx = lower.indexOf(q, i);
    }
    out += esc(text.slice(i));
    return out;
  }

  function renderTable() {
    const list = sortList(filtered());
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    const start = (state.page - 1) * state.pageSize;
    const rows = list.slice(start, start + state.pageSize);
    const q = state.filters.search.trim().toLowerCase();
    const tbody = $('#tbody');
    tbody.innerHTML = rows.map((c) => {
      const href = profileOf(c.user);
      const nameHtml = highlight(c.user.nickname, q);
      const userCell = `<div class="user-cell">
        <span class="avatar" style="${esc(avatarStyle(c.user))}">${esc(initials(c.user.nickname))}</span>
        <div class="user-meta">
          ${href ? `<a class="user-name" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="打开抖音主页">${nameHtml}</a>`
                 : `<span class="user-name nolink" title="导出数据里没有 sec_uid，无法拼主页">${nameHtml}</span>`}
          <span class="user-sub">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : ''))}</span>
        </div>
      </div>`;
      const badges = `<span class="badges">
        ${c.isHot ? '<span class="badge hot">热</span>' : ''}
        ${c.isReply ? '<span class="badge reply">回复</span>' : ''}
        ${c.isFolded ? '<span class="badge fold">折叠</span>' : ''}
      </span>`;
      return `<tr>
        <td><div class="txt">${highlight(c.text || '（无文字）', q)}${badges}</div>
          ${c.videoTitle && !state.filters.videoId ? `<div class="muted small" style="margin-top:4px"><a class="video-link" href="${esc(videoUrl(c.videoId))}" target="_blank" rel="noopener noreferrer" title="在原视频页打开这条视频">${esc(c.videoTitle)} ↗</a></div>` : ''}
        </td>
        <td>${userCell}</td>
        <td class="num">${fmtNum(c.digg)}</td>
        <td class="num">${fmtNum(c.replies)}</td>
        <td class="muted">${esc(c.ip || '-')}</td>
        <td class="muted small">${esc(c.createTimeStr ? c.createTimeStr.slice(0, 16) : fmtTime(c.createTime))}</td>
        <td class="muted small">${c.isReply ? '二级' : '一级'}</td>
      </tr>`;
    }).join('');
    $('#tableEmpty').classList.toggle('hidden', rows.length > 0);
    $('#tableCount').textContent = `（${total} 条${state.filters.search ? '，含搜索「' + state.filters.search + '」' : ''}）`;
    $('#btnExport').disabled = total === 0;
    if ($('#btnExportJson')) $('#btnExportJson').disabled = total === 0;
    renderPager(pages, total);
  }

  function renderPager(pages, total) {
    const pager = $('#pager');
    const cur = state.page;
    const btns = [];
    btns.push(`<button type="button" data-page="1" ${cur === 1 ? 'disabled' : ''}>« 首页</button>`);
    btns.push(`<button type="button" data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''}>‹ 上一页</button>`);
    const from = Math.max(1, cur - 3), to = Math.min(pages, from + 6);
    for (let p = from; p <= to; p++) {
      btns.push(`<button type="button" data-page="${p}" class="${p === cur ? 'on' : ''}">${p}</button>`);
    }
    btns.push(`<button type="button" data-page="${cur + 1}" ${cur === pages ? 'disabled' : ''}>下一页 ›</button>`);
    btns.push(`<button type="button" data-page="${pages}" ${cur === pages ? 'disabled' : ''}>末页 »</button>`);
    pager.innerHTML = btns.join('') + `<span class="info">第 ${cur} / ${pages} 页 · 共 ${total} 条</span>`;
  }

  /* ===================== 导出 ===================== */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const EXPORT_COLS = [
    ['cid', '评论ID'], ['video_id', '视频ID'], ['video_title', '视频标题'], ['text', '评论内容'],
    ['user_nickname', '用户昵称'], ['user_unique_id', '抖音号'], ['user_sec_uid', 'sec_uid(主页链接用)'],
    ['digg_count', '点赞数'], ['reply_comment_total', '回复数'], ['ip_label', '属地'],
    ['create_time_str', '发布时间'], ['level', '层级(1一级/2二级)'],
  ];

  function exportRows() {
    const list = sortList(filtered());
    if (!list.length) { toast('没有可导出的评论'); return null; }
    return list;
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }

  // 导出 CSV：第 1 行英文键（给程序读），第 2 行中文说明（给 Excel 里的人看，首格带 # 标记）
  function exportFilteredCsv() {
    const list = exportRows();
    if (!list) return;
    const rows = [EXPORT_COLS.map((c) => c[0]).join(',')];
    rows.push(EXPORT_COLS.map((c, i) => (i === 0 ? '# ' : '') + c[1]).join(','));
    for (const c of list) {
      rows.push([
        csvCell(c.cid), csvCell(c.videoId), csvCell(c.videoTitle), csvCell(c.text),
        csvCell(c.user.nickname), csvCell(c.user.uniqueId), csvCell(c.user.secUid),
        csvCell(c.digg), csvCell(c.replies), csvCell(c.ip), csvCell(c.createTimeStr || fmtTime(c.createTime)),
        csvCell(c.isReply ? 2 : 1),
      ].join(','));
    }
    download(new Blob(['\uFEFF' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), 'comments-view-' + stamp() + '.csv');
    toast(`已导出 ${list.length} 条评论（CSV）`);
  }

  // 导出 JSON：meta + comments（与采集插件导出的 JSON 结构接近，方便再喂给别的工具）
  function exportFilteredJson() {
    const list = exportRows();
    if (!list) return;
    const vids = Array.from(new Set(list.map((c) => String(c.videoId))));
    const payload = {
      exportedAt: new Date().toISOString(),
      count: list.length,
      filters: {
        videoId: state.filters.videoId || '',
        search: state.filters.search || '',
        onlyHasProfile: !!state.filters.onlyHasProfile,
        onlyTopLevel: !!state.filters.onlyTopLevel,
        onlyNonEmpty: !!state.filters.onlyNonEmpty,
        sortBy: state.filters.sortBy || 'digg',
      },
      videos: vids.map((id) => ({ videoId: id, title: (state.videos.get(id) || {}).title || '' })),
      comments: list.map((c) => ({
        cid: c.cid, videoId: c.videoId, videoTitle: c.videoTitle,
        text: c.text, textClean: c.textClean, createTime: c.createTime, createTimeStr: c.createTimeStr,
        diggCount: c.digg, replyCommentTotal: c.replies, ipLabel: c.ip,
        level: c.isReply ? 2 : 1, isReply: !!c.isReply, isHot: !!c.isHot, isFolded: !!c.isFolded,
        user: { nickname: c.user.nickname, uid: c.user.uid, secUid: c.user.secUid, uniqueId: c.user.uniqueId, shortId: c.user.shortId },
      })),
    };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), 'comments-view-' + stamp() + '.json');
    toast(`已导出 ${list.length} 条评论（JSON）`);
  }

  /* ===================== 刷新 ===================== */
  function recomputeWords(list) {
    state.words = buildWords(list);
    state.wordMap = new Map(state.words.map((w) => [w.word, w]));
  }

  let layoutSeq = 0;
  function renderCloud() {
    const cloud = $('#cloud');
    if (!state.comments.length) { cloud.innerHTML = ''; return; }
    const size = Number($('#cloudSize').value) || 120;
    const words = state.words.slice(0, size).filter((w) => w.count >= 2 || state.words.length < 40);
    const use = words.length ? words : state.words.slice(0, size);
    const seq = ++layoutSeq;
    // 等一帧，保证 cloud 已按最新尺寸布局
    requestAnimationFrame(() => {
      if (seq !== layoutSeq) return;
      layoutCloud(use, cloud);
      state.cloudReady = true;
    });
  }

  function refreshAll() {
    const list = filtered();
    recomputeWords(list);
    renderKpis(list);
    renderVideoFilter();
    renderWordList();
    renderCloud();
    $('#cloudSub').textContent = state.words.length
      ? `${state.words.length} 个词 · ${fmtNum(list.length)} 条评论`
      : '';
    state.page = 1;
    renderTable();
  }

  /* ===================== 事件绑定 ===================== */
  function bindEvents() {
    $('#btnOpenFiles').addEventListener('click', () => $('#fileInput').click());
    const btnOpenFiles2 = $('#btnOpenFiles2');
    if (btnOpenFiles2) btnOpenFiles2.addEventListener('click', () => $('#fileInput').click());
    $('#btnOpenDir').addEventListener('click', () => $('#dirInput').click());
    $('#fileInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
    $('#dirInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });

    $('#btnClear').addEventListener('click', () => {
      state.comments = [];
      state.videos = new Map();
      state.sources = [];
      state.words = [];
      state.wordMap = new Map();
      state.page = 1;
      state.filters.videoId = '';
      state.filters.search = '';
      $('#search').value = '';
      updateEmptyState();
      updateScope();
      refreshAll();
      $('#btnClear').disabled = true;
      $('#cloudEmpty').classList.remove('hidden');
      $('#tableEmpty').classList.remove('hidden');
      $('#videoFilter').innerHTML = '';
      $('#btnOpenVideo').disabled = true;
      $('#btnOpenVideo').dataset.videoId = '';
      closeDrawer();
      toast('已清空');
    });

    $('#cloudSize').addEventListener('change', () => { renderCloud(); });
    $('#btnRelayout').addEventListener('click', () => { renderCloud(); toast('已重新排布'); });

    // 「打开原视频 ↗」：新标签页打开当前选中视频的抖音页面
    $('#btnOpenVideo').addEventListener('click', () => {
      const btn = $('#btnOpenVideo');
      const id = btn.dataset.videoId || state.filters.videoId;
      const url = videoUrl(id);
      if (!url) { toast('先选择一条视频'); return; }
      window.open(url, '_blank', 'noopener');
    });

    $('#wordList').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-word]');
      if (!li) return;
      openDrawer(li.dataset.word);
    });

    $('#videoFilter').addEventListener('change', (e) => {
      state.filters.videoId = e.target.value;
      refreshAll();
    });
    ['onlyHasProfile', 'onlyTopLevel', 'onlyNonEmpty', 'onlyContent'].forEach((id) => {
      $('#' + id).addEventListener('change', (e) => {
        state.filters[id] = e.target.checked;
        refreshAll();
      });
    });

    // v0.5.41：自定义加词 / 屏蔽词（逗号或空格分隔，改完 400ms 自动生效并记忆）
    const kwKeepEl = $('#kwKeep'), kwBlockEl = $('#kwBlock');
    if (kwKeepEl) kwKeepEl.value = (state.kwKeep || []).join(',');
    if (kwBlockEl) kwBlockEl.value = (state.kwBlock || []).join(',');
    const onKwTune = debounce(applyWordLists, 400);
    if (kwKeepEl) kwKeepEl.addEventListener('input', onKwTune);
    if (kwBlockEl) kwBlockEl.addEventListener('input', onKwTune);

    const onSearch = debounce(() => {
      state.filters.search = $('#search').value;
      state.page = 1;
      renderTable();
    }, 200);
    $('#search').addEventListener('input', onSearch);

    $('#sortBy').addEventListener('change', (e) => {
      state.sort = e.target.value;
      state.page = 1;
      renderTable();
    });

    $('#pager').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]');
      if (!btn) return;
      state.page = Number(btn.dataset.page) || 1;
      renderTable();
      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#btnExport').addEventListener('click', exportFilteredCsv);
    $('#btnExportJson').addEventListener('click', exportFilteredJson);

    $('#btnCloseDrawer').addEventListener('click', closeDrawer);
    $('#btnDrawerMore').addEventListener('click', renderDrawerMore);
    $('#btnDrawerFilter').addEventListener('click', () => {
      const w = drawer.word;
      if (!w) return;
      $('#search').value = w;
      state.filters.search = w;
      state.page = 1;
      closeDrawer();
      renderTable();
      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('已在评论表里筛选「' + w + '」');
    });

    window.addEventListener('resize', debounce(() => {
      if (!state.comments.length) return;
      renderCloud();
    }, 260));

    // 拖拽文件到页面
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDrawer();
        $('#tooltip').classList.add('hidden');
      }
    });

    bindCloudHover();
  }

  /* ===================== 启动 ===================== */
  // 单文件快照（插件「导出词云」生成的自包含 HTML）会在加载本脚本前塞入
  //   window.__CW_BOOT__ = { title, exportedAt, docs: [<导出 JSON 对象>, …] }
  // 这里把它当成本地文件一样读进来，用户双击 HTML 就能看词云，不用再选文件。
  function bootFromSnapshot() {
    const boot = window.__CW_BOOT__;
    if (!boot || !Array.isArray(boot.docs) || !boot.docs.length) return false;
    let total = 0;
    boot.docs.forEach((doc, i) => {
      try {
        const name = (doc && doc.__name) || `快照-${i + 1}.json`;
        const n = ingestJson(JSON.stringify(doc), name);
        if (n > 0) { total += n; state.sources.push(name); }
      } catch (e) { console.warn('快照读取失败', e); }
    });
    if (!total) return false;
    if (boot.title) document.title = boot.title;
    updateScope();
    updateEmptyState();
    $('#btnClear').disabled = false;
    refreshAll();
    toast(`词云快照：${total} 条评论${boot.exportedAt ? '（导出于 ' + String(boot.exportedAt).slice(0, 16).replace('T', ' ') + '）' : ''}`);
    return true;
  }

  function init() {
    bindEvents();
    renderWordList();
    updateEmptyState();
    updateScope();
    // 快照优先：自带数据时不再走 ?data= 自动载入
    if (bootFromSnapshot()) return console.log('%c评论分析台（快照模式）已就绪', 'color:#e0a94a;font-weight:600');

    // 若页面地址带 ?data=<url 或 相对路径>，尝试自动载入（便于本地服务直接打开）
    try {
      const params = new URLSearchParams(location.search);
      const auto = params.get('data');
      if (auto) {
        fetch(auto, { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }).then((text) => {
          const n = /\.csv($|\?)/i.test(auto) ? ingestCsv(text, auto.split('/').pop()) : ingestJson(text, auto.split('/').pop());
          if (n > 0) {
            state.sources.push(auto);
            updateScope();
            updateEmptyState();
            $('#btnClear').disabled = false;
            refreshAll();
            toast(`自动载入 ${n} 条评论`);
          }
        }).catch((err) => {
          console.warn('自动载入失败', err);
          toast('自动载入失败：' + err.message + '（可手动选文件）');
        });
      }
    } catch (e) { /* ignore */ }
    console.log('%c评论分析台已就绪', 'color:#e0a94a;font-weight:600', '· 选择导出的 JSON/CSV 即可');
  }

  // 便于自动化测试 / 二次开发
  window.CommentViewer = {
    cleanToken,
    applyWordLists,
    setWordLists: (keep, block) => {
      state.kwKeep = parseWordList(keep);
      state.kwBlock = parseWordList(block);
      const k = $('#kwKeep'), b = $('#kwBlock');
      if (k) k.value = state.kwKeep.join(',');
      if (b) b.value = state.kwBlock.join(',');
      refreshAll();
    },
    state,
    loadFiles,
    ingestJson,
    ingestCsv,
    filtered,
    buildWords,
    tokensOf,
    profileOf,
    videoUrl,
    openDrawer,
    closeDrawer,
    renderTable,
    refreshAll,
    exportFilteredCsv,
    exportFilteredJson,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
