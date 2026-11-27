/**
 * 慢网络 / 间歇失败下的状态指示器行为。
 * 检查「离线副本」是否会在网络其实正常时误报。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9354;
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8787/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-slow-' + Date.now())}`,
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
  let slowMode = 0;       // 0=正常 1=延迟3秒 2=失败
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Fetch.requestPaused') {
      const { requestId } = m.params;
      if (slowMode === 2) {
        send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 503,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from('{"error":"down","message":"服务不可用"}').toString('base64'),
        }).catch(() => {});
      } else if (slowMode === 1) {
        setTimeout(() => send('Fetch.continueRequest', { requestId }).catch(() => {}), 3000);
      } else {
        send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    }
  };
  const send = (m, p = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const syncOf = () => evalJs(`JSON.stringify({text: document.querySelector('#syncState').textContent, state: document.querySelector('#syncState').dataset.state, rows: document.querySelectorAll('#list .row').length})`);

  // ① 正常加载
  await send('Page.navigate', { url: URL_BASE });
  await sleep(2600);
  console.log('① 正常:', await syncOf());

  // ② 让后续请求延迟 3 秒
  slowMode = 1;
  await evalJs(`window.__pull({ silent: true })`);
  await sleep(600);
  console.log('② 请求进行中（延迟中）:', await syncOf());
  await sleep(3200);
  console.log('② 延迟完成后:', await syncOf());

  // ③ 让请求失败
  slowMode = 2;
  await evalJs(`window.__pull({ silent: true })`);
  await sleep(1200);
  console.log('③ 服务端 503:', await syncOf());

  // ④ 恢复，再同步一次
  slowMode = 0;
  await evalJs(`window.__pull({ silent: true })`);
  await sleep(1200);
  console.log('④ 恢复后:', await syncOf());

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
