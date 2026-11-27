/**
 * 在真实页面上逐步调用渲染函数，定位哪一步抛异常。
 * 不依赖 catch 是否吞掉错误 —— 直接手动 try 每一步。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.env.OUT_DIR || path.join(process.env.TEMP, 'eat-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9351;
const URL_BASE = process.argv[2] || 'https://eat.isxl.cn/';

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--proxy-server=direct://', '--proxy-bypass-list=*',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'edge-step-' + Date.now())}`,
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
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception?.description || '') };
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(6000);

  // 暴露内部函数供逐步调用（app.js 是 module，作用域封闭，所以复刻调用链）
  console.log('════ 逐步定位 ════');
  console.log(await evalJs(`
    (() => {
      const out = [];
      const q = (s) => document.querySelector(s);

      // 各步骤能否独立跑通
      const steps = {
        'DOM 元素齐全': () => {
          const need = ['#wheel','#list','#hubCount','#filters','#filterChips','#tagPop','#batchbar','#emptyState'];
          const miss = need.filter(s => !q(s));
          if (miss.length) throw new Error('缺少元素 ' + miss.join(','));
          return 'ok';
        },
        'drawWheel 可跑': () => {
          const c = q('#wheel');
          const ctx = c.getContext('2d');
          ctx.clearRect(0,0,c.width,c.height);
          return 'ok';
        },
        'renderList 可跑': () => {
          const l = q('#list');
          const before = l.querySelectorAll('.row').length;
          return 'rows=' + before + ' scrollH=' + l.scrollHeight + ' clientH=' + l.clientHeight;
        },
      };

      for (const [name, fn] of Object.entries(steps)) {
        try { out.push(name + ': ' + fn()); }
        catch (e) { out.push(name + ': ✗ ' + e.message); }
      }

      // 关键：检查 loadCache 出来的数据结构
      try {
        const raw = localStorage.getItem('wheel.cache.v1');
        if (!raw) out.push('缓存: 无');
        else {
          const d = JSON.parse(raw);
          const o = d.options?.[0];
          out.push('缓存: options=' + (d.options?.length) + ' tags=' + (d.tags?.length)
            + ' 首项=' + JSON.stringify(o));
        }
      } catch (e) { out.push('缓存读取失败: ' + e.message); }

      return out.join('\\n');
    })()
  `));

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); try { proc.kill(); } catch {} process.exit(1); });
