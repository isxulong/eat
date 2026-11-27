/**
 * 验证内联单文件产物与多文件版本行为一致。
 * 关键：请求数、渲染结果、交互是否正常。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9370;
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-build-' + Date.now())}`,
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
  const requests = [];
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') {
      requests.push(m.params.request.url);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.text + ' | ' +
        (m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    }
  };
  const send = (m, p = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(4000);

  const statics = requests.filter((u) => !u.includes('/api/') && !u.startsWith('data:'));
  console.log('静态请求：', statics.length, '→', statics.map((u) => u.split('/').pop()).join(', '));

  console.log('渲染状态：', await evalJs(`
    JSON.stringify({
      rows: document.querySelectorAll('#list .row').length,
      wheelCount: document.querySelector('#hubCount')?.textContent,
      sync: document.querySelector('#syncState')?.textContent,
      cssApplied: getComputedStyle(document.body).backgroundColor,
      jsRan: typeof window.__pull === 'function',
    })
  `));

  // 交互验证：转一次
  await evalJs(`document.querySelector('#spinBtn').click()`);
  await sleep(5500);
  console.log('转盘结果：', await evalJs(`(document.querySelector('.result__value > span')||{}).textContent||'(空)'`));

  if (errors.length) {
    console.log('JS 异常：');
    for (const e of [...new Set(errors)].slice(0, 5)) console.log('  ', e);
  } else {
    console.log('JS 异常：无');
  }

  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const shot = path.join(OUT, 'build.png');
  fs.writeFileSync(shot, Buffer.from(data, 'base64'));
  console.log('截图：', shot);

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
