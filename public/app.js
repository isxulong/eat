/* ────────────────────────────────────────────────
   吃什么 · 转盘
   静态前端 + Pages Functions + D1
   ──────────────────────────────────────────────── */

const API = {
  wheel:   '/api/wheel',
  health:  '/api/health',
  login:   '/api/login',
  logout:  '/api/logout',
  options: '/api/options',
  batch:   '/api/options/batch',
  import:  '/api/wheel/import',
  export:  '/api/export',
};

const CACHE_KEY = 'wheel.cache.v1';
const DRAFT_KEY = 'wheel.draft.v1';

const PALETTE = [
  '#b4401f', '#2f6b52', '#7a4a2b', '#3d6a86',
  '#8f3017', '#4a5f2a', '#6d3f6b', '#1f5f66',
];

/**
 * 扇区配色。
 * 项数少时用固定的 8 色菜单色（有纸质感、色块清晰）；
 * 项数多时改成连续色相环 —— 固定色循环会在细扇区上产生
 * 高频摩尔纹，连续色相则收敛成平滑的渐变轮。
 */
function sliceColor(i, n) {
  if (n <= 20) return PALETTE[i % PALETTE.length];
  // 沿色相环均匀铺开，明度轻微交替以区分相邻扇区
  const hue = (i / n) * 360;
  const sat = 46 + (i % 2) * 8;
  const light = i % 2 ? 44 : 52;
  return `hsl(${hue.toFixed(2)} ${sat}% ${light}%)`;
}

/* ─────────── 状态 ─────────── */

const state = {
  options: [],
  revision: 0,
  editing: false,
  query: '',
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
  batchEnable:$('#batchEnable'),
  batchDisable:$('#batchDisable'),
  batchDelete:$('#batchDelete'),
  loginDlg:   $('#loginDlg'),
  loginForm:  $('#loginForm'),
  loginErr:   $('#loginErr'),
  tokenInput: $('#tokenInput'),
  loginCancel:$('#loginCancel'),
  loginSubmit:$('#loginSubmit'),
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
  const res = await fetch(path, {
    credentials: 'same-origin',
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
}

/* ─────────── 本地缓存（首屏秒开 + 断网兜底） ─────────── */

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!Array.isArray(d.options)) return false;
    state.options = d.options;
    state.revision = d.revision ?? 0;
    state.savedAt = d.at ?? 0;
    return true;
  } catch { return false; }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      options: state.options,
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
    state.options = d.options.map(normalize);
    state.revision = d.revision;
    saveCache();
    renderAll();
    setSync('ok', '已同步');
  } catch (e) {
    if (state.options.length) {
      setSync('local', '离线副本');
    } else {
      setSync('error', '连接失败');
      toast(e.message, 'error');
    }
  }
}

function normalize(o) {
  return {
    id: o.id,
    text: o.text,
    weight: Number(o.weight) || 1,
    disabled: Number(o.disabled) ? 1 : 0,
    sort: Number(o.sort) || 0,
  };
}

/* ─────────── 写操作（乐观 + 冲突处理） ─────────── */

async function mutate(run, { label = '保存中' } = {}) {
  setSync('saving', label);
  try {
    const res = await run();
    if (res?.revision) state.revision = res.revision;
    await pull({ silent: true });
    setSync('ok', '已同步');
    return res;
  } catch (e) {
    if (e.code === 'revision_conflict') {
      // 别处改过了：直接吃服务端快照，本地未提交的输入保留在输入框里
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
      toast(e.message || '保存失败', 'error');
    }
    throw e;
  }
}

/* ─────────── 转盘绘制 ─────────── */

const ctx = el.canvas.getContext('2d');
let wheelSize = 0;

function activeOptions() {
  return state.options.filter((o) => !o.disabled && o.text);
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
      const norm = ((mid % TAU) + TAU) % TAU;
      const flipped = norm > Math.PI / 2 && norm < (Math.PI * 3) / 2;

      const pad = 15;
      const maxW = R - pad - R * 0.31;          // 中心留出毂的半径
      const fs = Math.round(Math.max(10.5, Math.min(13, R * 0.043)));

      ctx.save();
      ctx.rotate(mid);
      if (flipped) ctx.rotate(Math.PI);

      ctx.font = `600 ${fs}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,.97)';
      ctx.textBaseline = 'middle';

      if (flipped) {
        ctx.textAlign = 'left';
        ctx.fillText(ellipsize(ctx, o.text, maxW), -(R - pad), 0);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(ellipsize(ctx, o.text, maxW), R - pad, 0);
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
let renderRaf = 0;

function visibleOptions() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.options;
  return state.options.filter((o) => o.text.toLowerCase().includes(q));
}

function renderList() {
  const items = visibleOptions();
  const scrollTop = el.list.scrollTop;
  const viewH = el.list.clientHeight || 420;

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 3);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + 4);

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const row = buildRow(items[i], i);
    row.style.top = `${i * ROW_H}px`;
    frag.append(row);
  }

  el.list.style.position = 'relative';
  el.list.replaceChildren(frag);
  // 用一条不可见的占位撑出总高度，行本身绝对定位——避免 padding 与 flex 高度互相干扰
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
  li.className = 'row' + (o.disabled ? ' is-off' : '');
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
    li.addEventListener('click', (e) => {
      if (e.target.closest('.row__del, .row__check, .row__text')) return;
      toggleDisabled(o);
    });
  }

  li.append(check, num, text, acts);
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
  renderList();
  updateBatchBar();
}

/* ─────────── 编辑操作 ─────────── */

async function renameOption(id, text) {
  const o = state.options.find((x) => x.id === id);
  if (!o) return;
  const prev = o.text;
  o.text = text;
  saveCache();
  renderAll();
  try {
    await mutate(() => api(`${API.options}/${id}`, { method: 'PATCH', body: { text } }));
  } catch {
    o.text = prev;
    saveCache();
    renderAll();
  }
}

async function removeOption(id) {
  const o = state.options.find((x) => x.id === id);
  if (!o) return;
  if (!confirm(`删除「${o.text}」？`)) return;
  const idx = state.options.findIndex((x) => x.id === id);
  state.options.splice(idx, 1);
  state.selected.delete(id);
  saveCache();
  renderAll();
  try {
    await mutate(() => api(`${API.options}/${id}?hard=1`, { method: 'DELETE' }));
  } catch {
    await pull({ silent: true });
  }
}

async function toggleDisabled(o) {
  const next = o.disabled ? 0 : 1;
  o.disabled = next;
  saveCache();
  renderAll();
  try {
    await mutate(() => api(`${API.options}/${o.id}`, { method: 'PATCH', body: { disabled: next } }));
    toast(next ? `已停用「${o.text}」` : `已启用「${o.text}」`);
  } catch {
    o.disabled = next ? 0 : 1;
    saveCache();
    renderAll();
  }
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
  } else {
    const res = await mutate(
      () => api(API.options, { method: 'POST', body: { texts: list } }),
      { label: `写入 ${list.length} 条` }
    );
    const added = res?.added?.length ?? list.length;
    const skipped = res?.skipped ?? 0;
    toast(skipped ? `新增 ${added} 项，跳过重复 ${skipped} 项` : `新增 ${added} 项`);
  }
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
    el.batchbar.hidden = true;
    await mutate(
      () => api(API.batch, { method: 'POST', body: { remove: ids } }),
      { label: '删除中' }
    ).catch(() => {});
    state.selected.clear();
    updateBatchBar();
    return;
  }

  const disabled = kind === 'disable' ? 1 : 0;
  el.batchbar.hidden = true;
  await mutate(
    () => api(API.batch, {
      method: 'POST',
      body: { update: ids.map((id) => ({ id, disabled })) },
    }),
    { label: '批量更新' }
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
  if (!on) {
    state.selected.clear();
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
    await api(API.login, { method: 'POST', body: { token } });
    el.loginDlg.close();
    setEditing(true);
  } catch (e) {
    el.loginErr.hidden = false;
    el.loginErr.textContent = e.code === 'bad_token' ? '口令不对，再试一次' : (e.message || '登录失败');
    el.loginSubmit.disabled = false;
    el.tokenInput.select();
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
}

boot();
