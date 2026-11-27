/**
 * 分类管理与口令改动的界面验证。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9341;
const URL_BASE = 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-tag2-' + Date.now())}`,
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

  // 登录
  await evalJs(`document.querySelector('#editToggle').click()`);
  await sleep(400);
  await evalJs(`
    (async () => {
      document.querySelector('#tokenInput').value = 'demo';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    })()
  `);
  await sleep(1300);

  // 选中两项 → 打开打标签浮层
  await evalJs(`
    (() => {
      const checks = [...document.querySelectorAll('#list .row__check')];
      checks.slice(0, 2).forEach(c => { c.checked = true; c.dispatchEvent(new Event('change',{bubbles:true})); });
      document.querySelector('#batchTag').click();
    })()
  `);
  await sleep(500);

  console.log('① 浮层里的分类芯片：', await evalJs(`
    JSON.stringify({
      chips: [...document.querySelectorAll('#tagPopList .tagchip')].map(w => w.textContent.trim()),
      editBtns: document.querySelectorAll('#tagPopList .tagchip__edit').length,
    })
  `));

  // 点编辑按钮 → 应弹出分类管理对话框（不是原生 prompt）
  await evalJs(`document.querySelector('#tagPopList .tagchip__edit').click()`);
  await sleep(500);
  console.log('② 管理对话框：', await evalJs(`
    JSON.stringify({
      open: document.querySelector('#tagDlg').open,
      name: document.querySelector('#tagDlgName').value,
      sub: document.querySelector('#tagDlgSub').textContent,
      hasDelete: !!document.querySelector('#tagDlgDelete'),
    })
  `));

  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'tagdlg.png'), Buffer.from(shot.data, 'base64'));

  // 改名
  await evalJs(`
    (async () => {
      document.querySelector('#tagDlgName').value = '辣味';
      document.querySelector('#tagForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    })()
  `);
  await sleep(1500);
  console.log('③ 改名后筛选条：', await evalJs(`
    JSON.stringify([...document.querySelectorAll('#filterChips .chip')].map(c => c.textContent.trim()))
  `));

  // 删除一个分类：先注册 dialog 自动接受，再点删除
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });

  const before = await evalJs(`document.querySelectorAll('#filterChips .chip').length`);
  await evalJs(`
    (() => {
      const edits = [...document.querySelectorAll('#tagPopList .tagchip__edit')];
      edits[edits.length - 1].click();
    })()
  `);
  await sleep(500);
  await evalJs(`document.querySelector('#tagDlgDelete').click()`);
  await sleep(2500);
  const after = await evalJs(`document.querySelectorAll('#filterChips .chip').length`);
  console.log(`④ 删除分类：${before} → ${after}`);

  console.log('⑤ 筛选条最终：', await evalJs(`
    JSON.stringify([...document.querySelectorAll('#filterChips .chip')].map(c => c.textContent.trim()))
  `));

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
