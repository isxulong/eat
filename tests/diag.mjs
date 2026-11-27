/**
 * 诊断生产页面的真实运行状态：
 *  - 捕获所有未处理异常和 console.error
 *  - 读取关键元素的计算高度与样式
 *  - 对比 API 是否真的可达
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9350;
const URL_BASE = process.argv[2] || 'https://eat.isxl.cn/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-diag-' + Date.now())}`,
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
  const errors = [];
  const logs = [];
  const netFailures = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push({
        text: d.text,
        desc: d.exception?.description?.split('\n').slice(0, 4).join(' | '),
        url: d.url,
        line: d.lineNumber,
        col: d.columnNumber,
      });
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      logs.push({
        type: m.params.type,
        args: m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
      });
    }
    if (m.method === 'Network.loadingFailed') {
      netFailures.push({ id: m.params.requestId, err: m.params.errorText });
    }
  };

  const send = (m, p = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception?.description || '') };
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: URL_BASE });
  await sleep(6000);

  console.log('════ 未处理异常 ════');
  if (!errors.length) console.log('  （无）');
  for (const e of errors) {
    console.log(`  ${e.text}`);
    if (e.desc) console.log(`    ${e.desc}`);
    if (e.url) console.log(`    at ${e.url}:${e.line}:${e.col}`);
  }

  console.log('\n════ console.error / warning ════');
  if (!logs.length) console.log('  （无）');
  for (const l of logs.slice(0, 10)) console.log(`  [${l.type}] ${l.args}`);

  console.log('\n════ 网络失败 ════');
  if (!netFailures.length) console.log('  （无）');
  for (const n of netFailures.slice(0, 10)) console.log(`  ${n.err}`);

  console.log('\n════ 关键元素实测 ════');
  console.log(await evalJs(`
    (() => {
      const q = (s) => document.querySelector(s);
      const box = (s) => {
        const e = q(s);
        if (!e) return 'MISSING';
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return {
          h: Math.round(r.height), w: Math.round(r.width),
          display: cs.display, flex: cs.flex,
          overflow: cs.overflowY, minH: cs.minHeight, maxH: cs.maxHeight,
        };
      };
      const list = q('#list');
      return JSON.stringify({
        sync: q('#syncState')?.textContent,
        syncState: q('#syncState')?.dataset.state,
        rows: document.querySelectorAll('#list .row').length,
        panel: box('.panel'),
        panelBody: box('.panel__body'),
        list: box('#list'),
        listScrollH: list ? list.scrollHeight : -1,
        listClientH: list ? list.clientHeight : -1,
        spacer: (() => { const s = q('.list__spacer'); return s ? Math.round(s.getBoundingClientRect().height) : 'MISSING'; })(),
        wheelCount: q('#hubCount')?.textContent,
        hasConic: typeof CanvasRenderingContext2D !== 'undefined' && 'createConicGradient' in CanvasRenderingContext2D.prototype,
      }, null, 2);
    })()
  `));

  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const shot = path.join(OUT, 'diag.png');
  fs.writeFileSync(shot, Buffer.from(data, 'base64'));
  console.log(`\n截图：${shot}`);

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
