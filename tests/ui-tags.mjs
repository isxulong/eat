/**
 * 分类标签功能验证：
 *  ① 筛选条渲染
 *  ② 点「辣的」后转盘只剩该分类的项
 *  ③ 多分类并集
 *  ④ 编辑态给选中项打标签
 *  ⑤ 新建分类
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9339;
const URL_BASE = 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-tag-' + Date.now())}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return await r.json(); } catch {}
    await sleep(300);
  }
  throw new Error('cdp not ready');
}

async function main() {
  const targets = await getJSON('/json/list');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const send = (m, p = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(2500);

  // ① 筛选条
  console.log('① 筛选条：', await evalJs(`
    JSON.stringify({
      visible: !document.querySelector('#filters').hidden,
      chips: [...document.querySelectorAll('#filterChips .chip')].map(c => c.textContent.trim()),
      wheelCount: document.querySelector('#hubCount').textContent,
    })
  `));

  // ② 点「辣的」
  await evalJs(`
    [...document.querySelectorAll('#filterChips .chip')]
      .find(c => c.textContent.includes('辣的')).click()
  `);
  await sleep(400);
  console.log('② 筛选「辣的」：', await evalJs(`
    JSON.stringify({
      wheelCount: document.querySelector('#hubCount').textContent,
      activeChips: [...document.querySelectorAll('#filterChips .chip.is-on')].map(c => c.textContent.trim()),
      clearShown: !document.querySelector('#filterClear').hidden,
    })
  `));

  // ③ 再加上「面食」→ 并集
  await evalJs(`
    [...document.querySelectorAll('#filterChips .chip')]
      .find(c => c.textContent.includes('面食')).click()
  `);
  await sleep(400);
  console.log('③ 加选「面食」（并集）：', await evalJs(`
    JSON.stringify({
      wheelCount: document.querySelector('#hubCount').textContent,
      active: [...document.querySelectorAll('#filterChips .chip.is-on')].map(c => c.textContent.trim()),
    })
  `));

  // 截图（筛选态）
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'filter.png'), Buffer.from(shot.data, 'base64'));

  // 转 8 次，确认结果都落在筛选范围内
  const spins = await evalJs(`
    (async () => {
      const out = [];
fs.mkdirSync(OUT, { recursive: true });
      for (let i = 0; i < 8; i++) {
        document.querySelector('#spinBtn').click();
        await new Promise(r => setTimeout(r, 5200));
        out.push((document.querySelector('.result__value > span') || {}).textContent || '');
      }
      return JSON.stringify(out);
    })()
  `);
  console.log('④ 筛选后连转 8 次结果：', spins);

  // 清除筛选
  await evalJs(`document.querySelector('#filterClear').click()`);
  await sleep(300);
  console.log('⑤ 清除筛选后：', await evalJs(`document.querySelector('#hubCount').textContent`));

  // ⑥ 编辑态打标签
  await evalJs(`document.querySelector('#editToggle').click()`);
  await sleep(400);
  await evalJs(`
    (async () => {
      document.querySelector('#tokenInput').value = 'demo';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    })()
  `);
  await sleep(1200);
  await evalJs(`
    (() => {
      const checks = [...document.querySelectorAll('#list .row__check')];
      checks.slice(0, 2).forEach(c => { c.checked = true; c.dispatchEvent(new Event('change',{bubbles:true})); });
    })()
  `);
  await sleep(300);
  await evalJs(`document.querySelector('#batchTag').click()`);
  await sleep(400);
  console.log('⑥ 打标签浮层：', await evalJs(`
    JSON.stringify({
      open: !document.querySelector('#tagPop').hidden,
      title: document.querySelector('#tagPopTitle').textContent,
      chips: [...document.querySelectorAll('#tagPopList .chip')].map(c => c.textContent.trim()),
    })
  `));

  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'tagpop.png'), Buffer.from(shot.data, 'base64'));

  // ⑦ 新建分类
  await evalJs(`
    (async () => {
      const inp = document.querySelector('#tagNewInput');
      inp.value = '夜宵';
      document.querySelector('#tagNewBtn').click();
    })()
  `);
  await sleep(1500);
  console.log('⑦ 新建「夜宵」后：', await evalJs(`
    JSON.stringify({
      chips: [...document.querySelectorAll('#tagPopList .chip')].map(c => c.textContent.trim()),
      optionTags: document.querySelectorAll('#list .row__tagdots i').length,
    })
  `));

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
