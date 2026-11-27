/* ────────────────────────────────────────────────
   吃什么 · 转盘
   静态前端 + Pages Functions + D1
   ──────────────────────────────────────────────── */

const API = {
  wheel:   '/api/wheel',
  health:  '/api/health',
  login:   '/api/login',
  logout:  '/api/logout',
  password:'/api/password',
  options: '/api/options',
  batch:   '/api/options/batch',
  import:  '/api/wheel/import',
  export:  '/api/export',
  tags:    '/api/tags',
  optionTags: '/api/option-tags',
};

const CACHE_KEY = 'wheel.cache.v1';
const DRAFT_KEY = 'wheel.draft.v1';

const PALETTE = [
  '#b4401f', '#2f6b52', '#7a4a2b', '#3d6a86',
  '#8f3017', '#4a5f2a', '#6d3f6b', '#1f5f66',
];

/**
 * 扇区配色。
 * 项数少时用固定的 8 色菜单色（纸质感、色块清晰）；
 * 项数多时改成连续色相环 —— 固定色循环会在细扇区上产生
 * 高频摩尔纹，连续色相则收敛成平滑的渐变轮。
 * 色相环压低饱和、抬高明度，落在纸张色域里，不跳出屏幕彩虹。
 */
function sliceColor(i, n) {
  if (n <= 20) return PALETTE[i % PALETTE.length];
  const hue = (i / n) * 360;
  const sat = 34 + (i % 2) * 5;
  const light = i % 2 ? 40 : 47;
  return `hsl(${hue.toFixed(2)} ${sat}% ${light}%)`;
}

/**
 * 密集扇区统一画成一个圆 + 锥形渐变。
 *
 * 关键取舍：项数超过 120 时，每个扇区在屏幕上不足 2–3 像素，
 * 逐个上色只会得到一片噪点纹理，反而看不清。这种情况下画平滑色轮，
 * 落点仍按真实扇区精确计算——视觉上不假装能分辨每个扇区，
 * 指针停在哪个颜色区间仍然与结果严格对应。
 */
function denseColor(items) {
  const n = items.length;
  const grad = ctx.createConicGradient(-Math.PI / 2, 0, 0);

  if (n > 120) {
    // 平滑色轮：只用少量色标，得到干净渐变，无摩尔纹
    const STOPS = 24;
    for (let s = 0; s <= STOPS; s++) {
      const t = s / STOPS;
      const hue = t * 360;
      grad.addColorStop(t, `hsl(${hue.toFixed(1)} 34% ${s % 2 ? 43 : 47}%)`);
    }
    return grad;
  }

  // 120 项以内：每个扇区一个色标，边界清晰可分辨
  for (let i = 0; i <= n; i++) {
    grad.addColorStop(i / n, sliceColor(i % n, n));
  }
  return grad;
}

/* ─────────── 状态 ─────────── */

const state = {
  options: [],
  tags: [],
  revision: 0,
  editing: false,
  query: '',
  activeTags: new Set(),   // 转盘筛选用：只抽这些分类
  selected: new Set(),
  spinning: false,
  rotation: 0,
  savedAt: 0,
};

/* ─────────── DOM ─────────── */

const $ = (s) => document.querySelector(s);
const el = {
  canvas:     $('#wheel'),
  spinBtn:    $('#spinBtn'),
  spinLabel:  $('#spinLabel'),
  result:     $('#result'),
  hubCount:   $('#hubCount'),
  countLabel: $('#countLabel'),
  list:       $('#list'),
  empty:      $('#emptyState'),
  search:     $('#search'),
  panel:      document.querySelector('.panel'),
  composer:   $('#composer'),
  pasteArea:  $('#pasteArea'),
  parseHint:  $('#parseHint'),
  appendBtn:  $('#appendBtn'),
  replaceBtn: $('#replaceBtn'),
  quickAdd:   $('#quickAdd'),
  quickAddBtn:$('#quickAddBtn'),
  exportBtn:  $('#exportBtn'),
  editToggle: $('#editToggle'),
  editText:   $('#editToggleText'),
  syncState:  $('#syncState'),
  batchbar:   $('#batchbar'),
  batchCount: $('#batchCount'),
  batchTag:   $('#batchTag'),
  batchEnable:$('#batchEnable'),
  batchDisable:$('#batchDisable'),
  batchDelete:$('#batchDelete'),
  filters:    $('#filters'),
  filterChips:$('#filterChips'),
  filterClear:$('#filterClear'),
  tagPop:     $('#tagPop'),
  tagPopTitle:$('#tagPopTitle'),
  tagPopList: $('#tagPopList'),
  tagPopClose:$('#tagPopClose'),
  tagNewInput:$('#tagNewInput'),
  tagNewBtn:  $('#tagNewBtn'),
  loginDlg:   $('#loginDlg'),
  loginForm:  $('#loginForm'),
  loginErr:   $('#loginErr'),
  tokenInput: $('#tokenInput'),
  loginCancel:$('#loginCancel'),
  loginSubmit:$('#loginSubmit'),
  passBtn:    $('#passBtn'),
  passDlg:    $('#passDlg'),
  passForm:   $('#passForm'),
  passCurrent:$('#passCurrent'),
  passNext:   $('#passNext'),
  passRepeat: $('#passRepeat'),
  passErr:    $('#passErr'),
  passCancel: $('#passCancel'),
  passSubmit: $('#passSubmit'),
  currentField: $('#currentField'),
  toast:      $('#toast'),
};

/* ─────────── 小工具 ─────────── */

let toastTimer = 0;
function toast(msg, kind = 'info') {
  el.toast.textContent = msg;
  el.toast.dataset.kind = kind;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('is-on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('is-on');
    setTimeout(() => { el.toast.hidden = true; }, 260);
  }, 2400);
}

function setSync(stateName, label) {
  el.syncState.dataset.state = stateName;
  el.syncState.textContent = label;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把一行文本切成单个条目：换行 / 逗号 / 顿号 / 分号 / 制表符 */
const SPLIT_RE = /[\n\r,，、;；\t]+/;

function parseLines(raw) {
  const out = [];
  const seen = new Set();
  for (const piece of String(raw).split(SPLIT_RE)) {
    const t = piece.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/* ─────────── 接口 ─────────── */

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const isRead = method === 'GET';
  // 读操作可以重试（幂等）；写操作只在网络层失败（根本没拿到响应）时重试，
  // 因为服务端可能已经执行了 —— 但选项 id 是客户端生成的，重放不会产生重复行。
  const maxTries = isRead ? 2 : 2;

  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: opts.body ? { 'content-type': 'application/json' } : undefined,
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch { /* 非 JSON */ }

      if (!res.ok) {
        const e = new Error(data?.message || `请求失败（${res.status}）`);
        e.status = res.status;
        e.code = data?.error;
        e.payload = data;
        throw e;
      }
      return data;
    } catch (e) {
      lastErr = e;
      // 业务错误（4xx/5xx 已拿到响应）不重试，只有网络层失败才重试
      if (e.status) throw e;
      if (attempt < maxTries) await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

/* ─────────── 本地缓存（首屏秒开 + 断网兜底） ─────────── */

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!Array.isArray(d.options)) return false;
    state.options = d.options.map(normalize);
    if (Array.isArray(d.tags)) state.tags = d.tags.map(normalizeTag);
    state.revision = d.revision ?? 0;
    state.savedAt = d.at ?? 0;
    return true;
  } catch { return false; }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      options: state.options,
      tags: state.tags,
      revision: state.revision,
      at: Date.now(),
    }));
  } catch { /* 配额满，忽略 */ }
}

/* ─────────── 拉取 ─────────── */

async function pull({ silent = false } = {}) {
  if (!silent) setSync('idle', '载入中');
  try {
    const d = await api(API.wheel);
    const changed =
      !Array.isArray(state.options) ||
      d.revision !== state.revision ||
      d.options.length !== state.options.length;
    state.options = d.options.map(normalize);
    if (Array.isArray(d.tags)) state.tags = d.tags.map(normalizeTag);
    state.revision = d.revision;
    saveCache();
    renderAll();
    if (!silent) setSync('ok', '已同步');
    return changed;
  } catch (e) {
    if (state.options.length) {
      setSync('local', '离线副本');
    } else {
      setSync('error', '连接失败');
      toast(e.message, 'error');
    }
    return false;
  }
}

/**
 * 后台静默同步：草稿和输入框不会被覆盖，只在数据真的变了时重绘。
 * 编辑中不打断用户（避免正在改的那行被替换掉）。
 */
let pollTimer = 0;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (state.editing) return;          // 编辑中不打断
    if (state.spinning) return;
    await pull({ silent: true });
  }, 20000);
}

// 切回标签页时立刻同步一次 —— 这就是「不用手动刷新」
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.editing) pull({ silent: true });
});

function normalize(o) {
  return {
    id: o.id,
    text: o.text,
    weight: Number(o.weight) || 1,
    disabled: Number(o.disabled) ? 1 : 0,
    sort: Number(o.sort) || 0,
    tags: Array.isArray(o.tags) ? o.tags : [],
  };
}

function normalizeTag(t) {
  return {
    id: t.id,
    name: t.name,
    color: t.color || '',
    sort: Number(t.sort) || 0,
  };
}

/* ─────────── 写操作（乐观 + 冲突处理） ─────────── */

/**
 * 写操作。
 *
 * 两种模式：
 *  · optimistic：先改本地并立刻重绘，再发请求。链路慢（1–3s/往返）时用户看不到等待。
 *    失败则回滚到操作前的快照。
 *  · 默认：等服务端确认再重绘（用于批量替换这类不能猜的操作）。
 */
async function mutate(run, { label = '保存中', optimistic } = {}) {
  const before = optimistic
    ? { options: state.options.map((o) => ({ ...o })), revision: state.revision }
    : null;

  if (optimistic) {
    optimistic.apply();
    saveCache();
    renderAll();
  }

  setSync('saving', label);
  const t0 = performance.now();
  try {
    const res = await run();
    if (Array.isArray(res?.options)) {
      // 写接口直接回吐完整快照 —— 一次往返，且绕开缓存
      state.options = res.options.map(normalize);
      if (Array.isArray(res.tags)) state.tags = res.tags.map(normalizeTag);
      state.revision = res.revision ?? state.revision;
      saveCache();
      renderAll();
    } else if (!optimistic) {
      await pull({ silent: true });
    }
    setSync('ok', `已保存 · ${Math.round(performance.now() - t0)}ms`);
    return res;
  } catch (e) {
    if (before) {
      state.options = before.options;
      state.revision = before.revision;
      saveCache();
      renderAll();
    }
    if (e.code === 'revision_conflict') {
      if (Array.isArray(e.payload?.options)) {
        state.options = e.payload.options.map(normalize);
        state.revision = e.payload.revision;
        saveCache();
        renderAll();
      }
      setSync('ok', '已同步');
      toast('别处改过，已拉取最新内容，请再试一次', 'error');
    } else {
      setSync('error', '保存失败');
      toast(e.message || '保存失败（已还原）', 'error');
    }
    throw e;
  }
}

/* ─────────── 转盘绘制 ─────────── */

const ctx = el.canvas.getContext('2d');
let wheelSize = 0;

/**
 * 转盘实际参与抽取的选项：启用的 + 命中当前分类筛选的。
 * 没选任何分类 = 不过滤；选了多个分类 = 并集（属于任一即可）。
 */
function activeOptions() {
  const pool = state.options.filter((o) => !o.disabled && o.text);
  if (!state.activeTags.size) return pool;
  return pool.filter((o) => (o.tags || []).some((t) => state.activeTags.has(t)));
}

function fitCanvas() {
  const rect = el.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const size = Math.max(180, Math.round(rect.width));
  if (size === wheelSize && el.canvas.width === size * dpr) return;
  wheelSize = size;
  el.canvas.width = Math.round(size * dpr);
  el.canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWheel();
}

function drawWheel() {
  const items = activeOptions();
  const S = wheelSize || 320;
  const R = S / 2;
  ctx.clearRect(0, 0, S, S);
  ctx.save();
  ctx.translate(R, R);

  if (!items.length) {
    ctx.beginPath();
    ctx.arc(0, 0, R - 1, 0, Math.PI * 2);
    ctx.fillStyle = '#ece5d7';
    ctx.fill();
    ctx.strokeStyle = '#ddd2c0';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    return;
  }

  const total = items.reduce((s, o) => s + Math.max(0.0001, o.weight), 0);
  const TAU = Math.PI * 2;
  let angle = -Math.PI / 2;

  // 扇区越密越不该画分隔线与文字，否则整圈糊成干涉纹
  const avgSweep = TAU / items.length;
  const drawStroke = avgSweep > 0.012;      // ≈ 少于 520 项才画细线
  const drawText = avgSweep > 0.24;          // ≈ 少于 26 项才有文字

  /* 密集扇区（>60 项）：逐个填充三角形会在弧边留下抗锯齿接缝，
     整圈看起来像毛边。这种情况下一次画满整圆，再用锥形渐变上色。 */
  if (items.length > 60) {
    ctx.beginPath();
    ctx.arc(0, 0, R - 1, 0, TAU);
    ctx.closePath();
    ctx.fillStyle = denseColor(items);
    ctx.fill();
    ctx.restore();
    return;
  }

  items.forEach((o, i) => {
    const sweep = (Math.max(0.0001, o.weight) / total) * TAU;
    const color = sliceColor(i, items.length);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R - 1, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    if (drawStroke) {
      ctx.strokeStyle = 'rgba(251, 248, 241, .55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 文字：够宽才画；下半圆整体翻转 180°，避免倒字
    if (drawText && sweep > 0.24) {
      const mid = angle + sweep / 2;

      const pad = 16;
      const hubR = R * 0.325;
      const outer = R - pad;
      const maxW = outer - hubR;
      const fs = Math.round(
        Math.max(10.5, Math.min(16, R * 0.042 + (sweep > 0.7 ? R * 0.016 : 0)))
      );

      // 宽扇区用切向排字（垂直于半径）——正下方/正上方的扇区因此是横排，
      // 不会出现 90° 竖排的怪相；窄扇区用径向排字，空间利用率更高。
      const wide = sweep > 0.62;
      const rLabel = wide ? (outer + hubR) / 2 : outer;

      ctx.save();
      ctx.rotate(mid);
      ctx.translate(rLabel, 0);

      ctx.font = `600 ${fs}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,.97)';
      ctx.textBaseline = 'middle';
      ctx.textAlign = wide ? 'center' : 'right';

      const label = ellipsize(ctx, o.text, maxW);

      if (wide) {
        // 切向：再加 90°；若因此倒置则补 180°
        let t = Math.PI / 2;
        if (Math.cos(mid + t) < 0) t += Math.PI;
        ctx.rotate(t);
        ctx.fillText(label, 0, 0);
      } else {
        // 径向：文字朝圆心方向书写；指向左半侧时补 180° 防倒置
        if (Math.cos(mid) < -0.02) {
          ctx.rotate(Math.PI);
          ctx.textAlign = 'left';
        }
        ctx.fillText(label, 0, 0);
      }
      ctx.restore();
    }

    angle += sweep;
  });

  ctx.restore();
}

function ellipsize(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

let rafId = 0;

async function spin() {
  const items = activeOptions();
  if (state.spinning || items.length === 0) return;

  state.spinning = true;
  el.spinBtn.disabled = true;
  el.spinLabel.textContent = '转着…';
  el.result.innerHTML = '<span class="result__empty">……</span>';

  // 按权重抽：pick 落在 [0, total) 上
  const total = items.reduce((s, o) => s + Math.max(0.0001, o.weight), 0);
  const pick = Math.random() * total;

  const segs = [];
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const sweep = (Math.max(0.0001, items[i].weight) / total) * 360;
    segs.push({ start: acc, sweep });
    acc += sweep;
  }

  // pick 换算成角度后再定位扇区（单位必须一致：pick 是权重，sweep 是角度）
  const pickAngle = (pick / total) * 360;
  let chosen = items.length - 1;
  let c = 0;
  for (let i = 0; i < segs.length; i++) {
    if (pickAngle < c + segs[i].sweep) { chosen = i; break; }
    c += segs[i].sweep;
  }

  // 第一段从 -90° 开始，扇区中心角（相对起始）：
  const center = segs[chosen].start + segs[chosen].sweep / 2 - 90;

  const cur = ((state.rotation % 360) + 360) % 360;
  const desired = (((-90 - center) % 360) + 360) % 360;
  let delta = desired - cur;
  delta = ((delta % 360) + 360) % 360;
  const turns = 5 + Math.floor(Math.random() * 2);
  const from = state.rotation;
  const to = from + turns * 360 + delta;

  const dur = 4200;
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);

  await new Promise((resolve) => {
    cancelAnimationFrame(rafId);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      state.rotation = from + (to - from) * ease(t);
      el.canvas.style.transform = `rotate(${state.rotation}deg)`;
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    rafId = requestAnimationFrame(step);
  });

  state.spinning = false;
  el.spinBtn.disabled = false;
  el.spinLabel.textContent = '再转一次';

  const win = items[chosen];
  showResult(win);
  highlight(win.id);
}

function showResult(o) {
  el.result.innerHTML = '';
  const wrap = document.createElement('span');
  wrap.className = 'result__value';
  const main = document.createElement('span');
  main.textContent = o.text;
  const small = document.createElement('small');
  small.textContent = '就它了';
  wrap.append(main, small);
  el.result.append(wrap);
}

function highlight(id) {
  for (const row of el.list.querySelectorAll('.row')) {
    row.classList.toggle('is-hit', row.dataset.id === id);
  }
}

/* ─────────── 列表渲染（窗口化） ─────────── */

const ROW_H = 38;
const OVERSCAN = 6;      // 视窗上下各多渲染几行，滚动手感更稳
let renderRaf = 0;
let lastRange = { start: -1, end: -1, len: -1, query: '', editing: null, rev: -1 };

function visibleOptions() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.options;
  return state.options.filter((o) => o.text.toLowerCase().includes(q));
}

/** 计算当前应该渲染的行区间 */
function windowRange(items, scrollTop, viewH) {
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  return { start, end };
}

/**
 * 渲染列表。
 *
 * 关键：滚动时不要重建整段 DOM。
 * 原实现每次 scroll 都 replaceChildren 一遍，配合行的入场动画会让文字
 * 在拖动过程中反复回到 opacity:0（用户看到的就是「滑动时文字闪没」）。
 * 现在只在「可见区间真的变了」或「数据/查询/编辑态变了」时才重建；
 * 单纯滚动且区间未变时，直接返回。
 */
function renderList() {
  const items = visibleOptions();
  const scrollTop = el.list.scrollTop;
  const viewH = el.list.clientHeight || 420;
  const { start, end } = windowRange(items, scrollTop, viewH);

  const sig = `${start}:${end}:${items.length}:${state.query}:${state.editing ? 1 : 0}:${state.revision}:${state.tags.length}`;
  if (sig === lastRange.sig) return;      // 没有任何变化，别碰 DOM
  lastRange.sig = sig;

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const row = buildRow(items[i], i);
    row.style.top = `${i * ROW_H}px`;
    frag.append(row);
  }

  el.list.style.position = 'relative';
  el.list.replaceChildren(frag);

  // 用一条不可见的占位撑出总高度，行本身绝对定位
  const spacer = document.createElement('li');
  spacer.className = 'list__spacer';
  spacer.setAttribute('aria-hidden', 'true');
  spacer.style.height = `${items.length * ROW_H}px`;
  el.list.append(spacer);

  el.empty.hidden = items.length > 0;
  el.countLabel.textContent = state.query
    ? `${items.length} / ${state.options.length}`
    : String(state.options.length);
}

function buildRow(o, i) {
  const li = document.createElement('li');
  li.className = 'row' + (o.disabled ? ' is-off' : '') + (o._pending ? ' is-pending' : '');
  li.dataset.id = o.id;
  li.style.top = `${i * ROW_H}px`;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'row__check';
  check.checked = state.selected.has(o.id);
  check.setAttribute('aria-label', `选择 ${o.text}`);
  check.addEventListener('change', () => {
    if (check.checked) state.selected.add(o.id);
    else state.selected.delete(o.id);
    updateBatchBar();
  });

  const num = document.createElement('span');
  num.className = 'row__num';
  num.textContent = String(i + 1);

  const text = document.createElement('div');
  text.className = 'row__text';
  text.textContent = o.text;
  text.title = o.text;
  text.dataset.id = o.id;
  if (state.editing) {
    text.setAttribute('contenteditable', 'plaintext-only');
    text.spellcheck = false;
    text.addEventListener('focus', () => { text.dataset.before = text.textContent; });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
      if (e.key === 'Escape') { text.textContent = text.dataset.before ?? o.text; text.blur(); }
    });
    text.addEventListener('blur', () => {
      const before = text.dataset.before ?? o.text;
      const after = (text.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!after) { text.textContent = before; return; }
      if (after === before) { text.textContent = after; return; }
      text.textContent = after;
      renameOption(o.id, after);
    });
  }

  const acts = document.createElement('div');
  acts.className = 'row__acts';
  if (state.editing) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row__del';
    del.title = '删除';
    del.setAttribute('aria-label', `删除 ${o.text}`);
    del.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-trash"></use></svg>';
    del.addEventListener('click', () => removeOption(o.id));
    acts.append(del);
  }

  // 标签点：让用户一眼看出这一项属于哪些分类
  const dots = document.createElement('div');
  dots.className = 'row__tagdots';
  for (const tid of o.tags || []) {
    const i = document.createElement('i');
    i.style.background = tagColorOf(tid) || 'var(--ink-3)';
    i.title = state.tags.find((t) => t.id === tid)?.name || '';
    dots.append(i);
  }

  li.append(check, num, text, dots, acts);

  if (state.editing) {
    li.addEventListener('click', (e) => {
      if (e.target.closest('.row__del, .row__check, .row__text')) return;
      toggleDisabled(o);
    });
  }

  return li;
}

function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    renderList();
  });
}
function renderAll() {
  el.hubCount.textContent = String(activeOptions().length);
  drawWheel();
  el.spinBtn.disabled = state.spinning || activeOptions().length === 0;
  renderFilters();
  invalidateList();     // 数据变了：强制重算一次列表
  renderList();
  updateBatchBar();
}

/** 让下一次 renderList 一定重建 DOM */
function invalidateList() {
  lastRange.sig = '';
}

/* ─────────── 分类筛选 ─────────── */

function renderFilters() {
  const hasTags = state.tags.length > 0;
  el.filters.hidden = !hasTags;
  if (!hasTags) return;

  // 每个分类有多少项参与（受启用状态影响）
  const counts = {};
  for (const o of state.options) {
    if (o.disabled || !o.text) continue;
    for (const t of o.tags || []) counts[t] = (counts[t] || 0) + 1;
  }

  const frag = document.createDocumentFragment();
  for (const t of state.tags) {
    const n = counts[t.id] || 0;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (state.activeTags.has(t.id) ? ' is-on' : '');
    b.dataset.tag = t.id;
    if (t.color) b.style.setProperty('--chip', t.color);
    b.innerHTML =
      `<span class="chip__dot"></span>` +
      `<span>${escapeHtml(t.name)}</span>` +
      `<span class="chip__n">${n}</span>`;
    b.addEventListener('click', () => toggleTagFilter(t.id));
    frag.append(b);
  }
  el.filterChips.replaceChildren(frag);
  el.filterClear.hidden = state.activeTags.size === 0;
}

function toggleTagFilter(id) {
  if (state.activeTags.has(id)) state.activeTags.delete(id);
  else state.activeTags.add(id);
  // 筛选后当前结果可能为空，提示一下
  const n = activeOptions().length;
  if (n === 0) toast('这个筛选下没有可选项', 'error');
  renderAll();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function tagColorOf(id) {
  const t = state.tags.find((x) => x.id === id);
  return t?.color || '';
}

/* ─────────── 给选项打标签 ─────────── */

async function setOptionTags(optionIds, tagIds, mode) {
  await mutate(
    () => api(API.optionTags, { method: 'POST', body: { optionIds, tagIds, mode } }),
    {
      label: '更新分类',
      optimistic: {
        apply: () => {
          for (const o of state.options) {
            if (!optionIds.includes(o.id)) continue;
            const set = new Set(o.tags || []);
            for (const t of tagIds) {
              if (mode === 'remove') set.delete(t);
              else set.add(t);
            }
            o.tags = [...set];
          }
        },
      },
    }
  ).catch(() => {});
}

async function createTag(name, thenApplyTo) {
  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) return null;
  try {
    const res = await mutate(
      () => api(API.tags, { method: 'POST', body: { name: trimmed } }),
      { label: '建分类' }
    );
    const created = state.tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
    if (created && thenApplyTo?.length) {
      await setOptionTags(thenApplyTo, [created.id], 'add');
    }
    return created;
  } catch (e) {
    if (e.code === 'duplicate') toast('这个分类已经有了', 'error');
    return null;
  }
}

function openTagPop() {
  const ids = [...state.selected];
  if (!ids.length) return;
  el.tagPop.hidden = false;
  el.tagPopTitle.textContent = `给 ${ids.length} 项设置分类`;
  renderTagPopList(ids);
  el.tagNewInput.value = '';
  el.tagNewInput.focus();
}

function renderTagPopList(optionIds) {
  const frag = document.createDocumentFragment();

  if (!state.tags.length) {
    el.tagPopList.replaceChildren(frag);
    return;
  }

  // 选中项共同的标签 = 全部都有；部分有的显示为半选态
  for (const t of state.tags) {
    const owning = state.options.filter(
      (o) => optionIds.includes(o.id) && (o.tags || []).includes(t.id)
    ).length;
    const all = owning === optionIds.length;
    const some = owning > 0 && !all;

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (all ? ' is-on' : '');
    b.style.opacity = some ? '.72' : '1';
    b.innerHTML =
      (t.color ? `<span class="chip__dot" style="background:${t.color}"></span>` : '<span class="chip__dot"></span>') +
      `<span>${escapeHtml(t.name)}</span>`;
    b.title = all ? '点一下移除' : some ? `${owning}/${optionIds.length} 项已有` : '点一下加上';
    b.addEventListener('click', async () => {
      const mode = all ? 'remove' : 'add';
      await setOptionTags(optionIds, [t.id], mode);
      renderTagPopList(optionIds);
    });
    frag.append(b);
  }
  el.tagPopList.replaceChildren(frag);
}

/* ─────────── 编辑操作 ─────────── */

async function renameOption(id, text) {
  const o = state.options.find((x) => x.id === id);
  if (!o || o.text === text) return;
  await mutate(
    () => api(`${API.options}/${id}`, { method: 'PATCH', body: { text } }),
    {
      label: '改名中',
      optimistic: { apply: () => { o.text = text; } },
    }
  ).catch(() => {});
}

async function removeOption(id) {
  const o = state.options.find((x) => x.id === id);
  if (!o) return;
  if (!confirm(`删除「${o.text}」？`)) return;
  const idx = state.options.findIndex((x) => x.id === id);
  state.selected.delete(id);
  await mutate(
    () => api(`${API.options}/${id}?hard=1`, { method: 'DELETE' }),
    {
      label: '删除中',
      optimistic: { apply: () => { state.options.splice(idx, 1); } },
    }
  ).catch(() => {});
}

async function toggleDisabled(o) {
  const next = o.disabled ? 0 : 1;
  await mutate(
    () => api(`${API.options}/${o.id}`, { method: 'PATCH', body: { disabled: next } }),
    {
      label: next ? '停用中' : '启用中',
      optimistic: { apply: () => { o.disabled = next; } },
    }
  )
    .then(() => toast(next ? `已停用「${o.text}」` : `已启用「${o.text}」`))
    .catch(() => {});
}

async function addTexts(texts, mode = 'append', title) {
  const list = texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!list.length) return;

  if (mode === 'replace') {
    if (!confirm(`用这 ${list.length} 条替换全部选项？原来的会被清空。`)) return;
    await mutate(
      () => api(API.import, { method: 'POST', body: { mode: 'replace', texts: list, title } }),
      { label: '替换中' }
    );
    toast(`已替换为 ${list.length} 项`);
    return;
  }

  // 追加：先在本地算出会新增什么，立刻显示，再等服务端确认
  const existing = new Set(state.options.map((o) => o.text.toLowerCase()));
  const fresh = [];
  for (const t of list) {
    const k = t.toLowerCase();
    if (existing.has(k)) continue;
    existing.add(k);
    fresh.push(t);
  }
  if (!fresh.length) {
    toast('这些都已经在列表里了');
    return;
  }

  const baseSort = state.options.length
    ? Math.max(...state.options.map((o) => o.sort)) + 1
    : 0;
  const pending = fresh.map((text, i) => ({
    id: 'tmp-' + crypto.randomUUID(),
    text,
    weight: 1,
    disabled: 0,
    sort: baseSort + i,
    _pending: true,
  }));

  const res = await mutate(
    () => api(API.options, { method: 'POST', body: { texts: list } }),
    {
      label: `写入 ${fresh.length} 条`,
      optimistic: { apply: () => { state.options = state.options.concat(pending); } },
    }
  );

  const added = res?.added?.length ?? fresh.length;
  const skipped = res?.skipped ?? 0;
  toast(skipped ? `新增 ${added} 项，跳过重复 ${skipped} 项` : `新增 ${added} 项`);
}

/* ─────────── 批量条 ─────────── */

function updateBatchBar() {
  const n = state.selected.size;
  el.batchbar.hidden = !state.editing || n === 0;
  el.batchCount.textContent = `已选 ${n} 项`;
}

async function batchOp(kind) {
  const ids = [...state.selected];
  if (!ids.length) return;

  if (kind === 'delete') {
    if (!confirm(`删除选中的 ${ids.length} 项？`)) return;
    const keep = state.options.filter((o) => !ids.includes(o.id));
    await mutate(
      () => api(API.batch, { method: 'POST', body: { remove: ids } }),
      {
        label: '删除中',
        optimistic: { apply: () => { state.options = keep; } },
      }
    ).catch(() => {});
    state.selected.clear();
    updateBatchBar();
    return;
  }

  const disabled = kind === 'disable' ? 1 : 0;
  await mutate(
    () => api(API.batch, {
      method: 'POST',
      body: { update: ids.map((id) => ({ id, disabled })) },
    }),
    {
      label: '批量更新',
      optimistic: {
        apply: () => {
          for (const o of state.options) if (ids.includes(o.id)) o.disabled = disabled;
        },
      },
    }
  ).catch(() => {});
  state.selected.clear();
  updateBatchBar();
}

/* ─────────── 编辑模式 ─────────── */

async function enterEdit() {
  // 已登录则直接进
  try {
    const h = await api(API.health);
    if (h.session === 'authed') {
      setEditing(true);
      return;
    }
  } catch { /* 忽略，走登录 */ }

  el.loginErr.hidden = true;
  el.tokenInput.value = '';
  el.loginDlg.showModal();
  setTimeout(() => el.tokenInput.focus(), 30);
}

function setEditing(on) {
  state.editing = on;
  el.panel.dataset.edit = on ? '1' : '0';
  el.composer.hidden = !on;
  el.editToggle.classList.toggle('is-on', on);
  el.editText.textContent = on ? '完成' : '编辑';
  el.passBtn.hidden = !on;          // 改口令入口只在解锁后出现
  if (!on) {
    state.selected.clear();
    pull({ silent: true });          // 退出编辑同步一次，别人的改动立刻可见
  }
  renderAll();
  if (on) {
    toast('编辑已解锁');
    el.quickAdd.focus();
  }
}

async function doLogin(token) {
  el.loginSubmit.disabled = true;
  el.loginErr.hidden = true;
  try {
    const res = await api(API.login, { method: 'POST', body: { token } });
    el.loginDlg.close();
    setEditing(true);
    // 还在用环境变量的引导口令，提醒一次
    if (res?.bootstrap) {
      setTimeout(() => toast('当前是初始口令，点右上角「口令」换成自己的'), 1200);
    }
  } catch (e) {
    el.loginErr.hidden = false;
    el.loginErr.textContent = e.code === 'bad_token' ? '口令不对，再试一次' : (e.message || '登录失败');
    el.loginSubmit.disabled = false;
    el.tokenInput.select();
  }
}

/* ─────────── 修改口令 ─────────── */

async function openPassDialog() {
  el.passErr.hidden = true;
  el.passNext.value = '';
  el.passRepeat.value = '';
  el.passCurrent.value = '';
  // 已经设置过自定义口令时要校验当前口令；引导期直接设
  try {
    const h = await api(API.health);
    el.currentField.hidden = !h.bootstrap;
  } catch {
    el.currentField.hidden = false;
  }
  el.passDlg.showModal();
  setTimeout(() => {
    (el.currentField.hidden ? el.passNext : el.passCurrent).focus();
  }, 30);
}

async function savePass() {
  el.passErr.hidden = true;
  const next = el.passNext.value;
  const again = el.passRepeat.value;
  const cur = el.passCurrent.value;

  if (next.length < 6) {
    el.passErr.hidden = false;
    el.passErr.textContent = '新口令至少 6 位';
    return;
  }
  if (next !== again) {
    el.passErr.hidden = false;
    el.passErr.textContent = '两次输入不一致';
    return;
  }

  el.passSubmit.disabled = true;
  try {
    await api(API.password, { method: 'POST', body: { current: cur, next } });
    el.passDlg.close();
    toast('口令已更新，下次用新口令解锁');
  } catch (e) {
    el.passErr.hidden = false;
    el.passErr.textContent =
      e.code === 'bad_current' ? '当前口令不对' :
      e.code === 'weak' ? '新口令太短，至少 6 位' :
      (e.message || '保存失败');
  } finally {
    el.passSubmit.disabled = false;
  }
}

/* ─────────── 事件绑定 ─────────── */

el.spinBtn.addEventListener('click', spin);

el.editToggle.addEventListener('click', () => {
  if (state.editing) setEditing(false);
  else enterEdit();
});

el.search.addEventListener('input', () => {
  state.query = el.search.value;
  el.list.scrollTop = 0;
  invalidateList();
  renderList();
});

el.list.addEventListener('scroll', scheduleRender, { passive: true });

el.pasteArea.addEventListener('input', () => {
  const n = parseLines(el.pasteArea.value).length;
  el.parseHint.innerHTML = n
    ? `识别到 <strong>${n}</strong> 条，去重后入库`
    : '支持批量粘贴';
  try { localStorage.setItem(DRAFT_KEY, el.pasteArea.value); } catch {}
});

el.appendBtn.addEventListener('click', async () => {
  const items = parseLines(el.pasteArea.value);
  if (!items.length) { toast('先粘点东西进来', 'error'); return; }
  await addTexts(items, 'append').then(() => {
    el.pasteArea.value = '';
    el.parseHint.textContent = '支持批量粘贴';
    localStorage.removeItem(DRAFT_KEY);
  }).catch(() => {});
});

el.replaceBtn.addEventListener('click', async () => {
  const items = parseLines(el.pasteArea.value);
  if (!items.length) { toast('先粘点东西进来', 'error'); return; }
  await addTexts(items, 'replace').then(() => {
    el.pasteArea.value = '';
    el.parseHint.textContent = '支持批量粘贴';
    localStorage.removeItem(DRAFT_KEY);
  }).catch(() => {});
});

async function quickAdd() {
  const v = el.quickAdd.value.trim();
  if (!v) return;
  el.quickAdd.value = '';
  await addTexts([v], 'append').catch(() => {});
  el.quickAdd.focus();
}

el.quickAddBtn.addEventListener('click', quickAdd);
el.quickAdd.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); quickAdd(); }
});

el.batchEnable.addEventListener('click', () => batchOp('enable'));
el.batchDisable.addEventListener('click', () => batchOp('disable'));
el.batchDelete.addEventListener('click', () => batchOp('delete'));

/* 分类 */
el.batchTag.addEventListener('click', openTagPop);
el.tagPopClose.addEventListener('click', () => { el.tagPop.hidden = true; });
el.filterClear.addEventListener('click', () => {
  state.activeTags.clear();
  renderAll();
});

async function newTagFromInput() {
  const name = el.tagNewInput.value.trim();
  if (!name) return;
  el.tagNewInput.value = '';
  const ids = [...state.selected];
  await createTag(name, ids);
  if (ids.length) renderTagPopList(ids);
  else renderFilters();
}
el.tagNewBtn.addEventListener('click', newTagFromInput);
el.tagNewInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); newTagFromInput(); }
});

el.exportBtn.addEventListener('click', () => {
  const items = activeOptions();
  if (!items.length) { toast('没有可导出的选项', 'error'); return; }
  const blob = new Blob([items.map((o) => o.text).join('\n')], {
    type: 'text/plain;charset=utf-8',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'options.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

el.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  doLogin(el.tokenInput.value.trim());
});
el.loginCancel.addEventListener('click', () => el.loginDlg.close());

el.passBtn.addEventListener('click', openPassDialog);
el.passCancel.addEventListener('click', () => el.passDlg.close());
el.passForm.addEventListener('submit', (e) => {
  e.preventDefault();
  savePass();
});

// 回车提交，Esc 关闭
el.passRepeat.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); savePass(); }
});

// 无内容时按空格不滚动，直接转
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const t = e.target;
  if (t.closest('input, textarea, [contenteditable], dialog')) return;
  e.preventDefault();
  spin();
});

/* ─────────── 启动 ─────────── */

function boot() {
  // 草稿回填
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) {
      el.pasteArea.value = draft;
      el.pasteArea.dispatchEvent(new Event('input'));
    }
  } catch {}

  const cached = loadCache();
  if (cached) {
    renderAll();
    setSync('local', '离线副本');
  }
  fitCanvas();
  new ResizeObserver(() => fitCanvas()).observe(el.canvas);

  pull({ silent: cached });
  startPolling();
}

boot();
