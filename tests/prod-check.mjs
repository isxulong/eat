/**
 * 生产首屏体检：等足时间再看，判断数据是否真的加载了、面板多高。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9361;
const URL_BASE = process.argv[2] || 'https://eat.isxl.cn/';
const WAIT = Number(process.argv[3] || 12000);

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-prod-' + Date.now())}`,
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
  const failures = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Network.loadingFailed') failures.push(m.params.errorText);
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

  const t0 = Date.now();
  await send('Page.navigate', { url: URL_BASE });
  await sleep(WAIT);

  console.log(`等待 ${WAIT}ms 后（实际 ${Date.now() - t0}ms）：`);
  console.log(await evalJs(`
    JSON.stringify({
      sync: document.querySelector('#syncState')?.textContent,
      state: document.querySelector('#syncState')?.dataset.state,
      rows: document.querySelectorAll('#list .row').length,
      skeletonHidden: document.querySelector('#skeleton')?.hidden,
      panelH: Math.round(document.querySelector('.panel')?.getBoundingClientRect().height || 0),
      listH: Math.round(document.querySelector('#list')?.getBoundingClientRect().height || 0),
      visibleRows: Math.round((document.querySelector('#list')?.getBoundingClientRect().height || 0) / 38),
    }, null, 0)
  `));

  if (failures.length) console.log('网络失败：', [...new Set(failures)].join(', '));

  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const shot = path.join(OUT, 'prod.png');
  fs.writeFileSync(shot, Buffer.from(data, 'base64'));
  console.log('截图：', shot);

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
