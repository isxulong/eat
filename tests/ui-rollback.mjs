/**
 * 失败回滚验证：让写接口必定失败，检查
 *  ① 乐观更新是否正确撤销
 *  ② 「保存中」标记是否残留
 *  ③ 用户看到的是错误提示而不是静默失败
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9342;
const URL_BASE = 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-fail-' + Date.now())}`,
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
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/options*', requestStage: 'Request' }] });

  // 所有 /api/options* 写入一律改成 500
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method !== 'Fetch.requestPaused') return;
    const req = m.params.request;
    if (req.method === 'GET') {
      send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      return;
    }
    send('Fetch.fulfillRequest', {
      requestId: m.params.requestId,
      responseCode: 500,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ error: 'server_error', message: '模拟服务端故障' })).toString('base64'),
    }).catch(() => {});
  });

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(2600);

  const countBefore = await evalJs(`document.querySelectorAll('#list .row').length`);

  // 登录
  await evalJs(`document.querySelector('#editToggle').click()`);
  await sleep(400);
  await evalJs(`
    (async () => {
      document.querySelector('#tokenInput').value = 'demo1234';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    })()
  `);
  await sleep(1300);

  // 触发一次会失败的追加
  await evalJs(`
    (async () => {
      const inp = document.querySelector('#quickAdd');
      inp.value = '这条一定失败';
      document.querySelector('#quickAddBtn').click();
    })()
  `);
  await sleep(2500);

  const after = await evalJs(`
    JSON.stringify({
      rows: document.querySelectorAll('#list .row').length,
      hasPhantom: [...document.querySelectorAll('#list .row__text')].some(e => e.textContent === '这条一定失败'),
      pendingRows: document.querySelectorAll('#list .row.is-pending').length,
      sync: document.querySelector('#syncState').textContent,
      syncState: document.querySelector('#syncState').dataset.state,
      toast: (document.querySelector('#toast') || {}).textContent || '',
    })
  `);

  console.log('失败前行数：', countBefore);
  console.log('失败后：', after);

  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'rollback.png'), Buffer.from(data, 'base64'));

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
