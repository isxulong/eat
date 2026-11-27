#!/usr/bin/env node
/**
 * 随机性检验（卡方拟合优度）
 *
 * 直接复刻 public/app.js 里的抽选算法，跑大样本做统计检验，
 * 而不是凭「用的是 Math.random 所以没问题」这种说法。
 *
 * 用法：node tests/randomness.mjs
 */

const N = 200000;

/* ---- 与 app.js 抽选逻辑一致 ---- */
function pickIndex(items, rand = Math.random) {
  const total = items.reduce((s, o) => s + Math.max(0.0001, o.weight), 0);
  const pick = rand() * total;

  const segs = [];
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const sweep = (Math.max(0.0001, items[i].weight) / total) * 360;
    segs.push({ start: acc, sweep });
    acc += sweep;
  }

  const pickAngle = (pick / total) * 360;   // 单位必须统一：权重区间 → 角度
  let chosen = items.length - 1;
  let c = 0;
  for (let i = 0; i < segs.length; i++) {
    if (pickAngle < c + segs[i].sweep) { chosen = i; break; }
    c += segs[i].sweep;
  }
  return chosen;
}

/* ---- χ² 临界值（α=0.001）---- */
const CHI2_CRIT = {
  1: 10.828, 2: 13.816, 3: 16.266, 4: 18.467, 5: 20.515,
  6: 22.458, 7: 24.322, 8: 26.124, 9: 27.877, 10: 29.588,
  11: 31.264, 12: 32.909, 13: 34.528, 14: 36.123, 15: 37.697,
  16: 39.252, 17: 40.790, 18: 42.312, 19: 43.820, 20: 45.315,
  21: 46.797, 22: 48.268, 23: 49.728, 24: 51.179, 25: 52.620,
  26: 54.052, 27: 55.476, 28: 56.892, 29: 58.301, 30: 59.703,
};
const critFor = (df) => CHI2_CRIT[df] ?? df + 3 * Math.sqrt(2 * df) + 5;

function run(name, items, n = N, verbose = true) {
  const counts = new Array(items.length).fill(0);
  for (let i = 0; i < n; i++) counts[pickIndex(items)]++;

  const weights = items.map((o) => Math.max(0.0001, o.weight));
  const totalW = weights.reduce((a, b) => a + b, 0);

  let chi = 0;
  for (let i = 0; i < counts.length; i++) {
    const expected = n * (weights[i] / totalW);
    chi += Math.pow(counts[i] - expected, 2) / expected;
  }
  const df = counts.length - 1;
  const crit = critFor(df);
  const pass = chi < crit;

  if (verbose) {
    console.log(`\n── ${name} ──`);
    console.log(`  样本 ${n.toLocaleString()}，${items.length} 个选项`);
    const rows = items.map((o, i) => {
      const expected = n * (weights[i] / totalW);
      return { t: o.text, w: o.weight, obs: counts[i], exp: expected,
               dev: ((counts[i] - expected) / expected) * 100 };
    });
    for (const r of rows.slice(0, 12)) {
      console.log(
        `  ${r.t.padEnd(8)} 权重 ${String(r.w).padStart(4)} | 期望 ${r.exp.toFixed(0).padStart(6)}` +
        ` | 实际 ${String(r.obs).padStart(6)} | 偏差 ${r.dev >= 0 ? '+' : ''}${r.dev.toFixed(2)}%`
      );
    }
    if (rows.length > 12) console.log(`  …… 其余 ${rows.length - 12} 项略`);
    console.log(`  χ² = ${chi.toFixed(2)}，df = ${df}，α=0.001 临界值 ${crit}`);
    console.log(`  判定：${pass ? '✓ 通过（无显著偏差）' : '✗ 不通过（存在显著偏差）'}`);
  }
  return { pass, chi, df, crit };
}

const cases = [
  ['等权 24 项', Array.from({ length: 24 }, (_, i) => ({ text: `菜${i + 1}`, weight: 1 }))],
  ['等权 3 项', [{ text: 'A', weight: 1 }, { text: 'B', weight: 1 }, { text: 'C', weight: 1 }]],
  ['带权重 3:1:1:0.5', [
    { text: '麻辣烫', weight: 3 }, { text: '火锅', weight: 1 },
    { text: '烧烤', weight: 1 }, { text: '寿司', weight: 0.5 },
  ]],
  ['两项', [{ text: 'A', weight: 1 }, { text: 'B', weight: 1 }]],
  ['极端权重 1000:1', [{ text: '大权重', weight: 1000 }, { text: '小权重', weight: 1 }]],
];

let allPass = true;
for (const [name, items] of cases) {
  allPass = run(name, items).pass && allPass;
}

/* ---- 附加：把 Math.random 换成确定性序列，确认算法本身无偏 ---- */
(function sequenceTest() {
  const items = [{ text: 'A', weight: 1 }, { text: 'B', weight: 1 }, { text: 'C', weight: 1 }];
  const counts = [0, 0, 0];
  const M = 30000;
  for (let i = 0; i < M; i++) counts[pickIndex(items, () => i / M)]++;
  const spread = Math.max(...counts) - Math.min(...counts);
  console.log(`\n── 确定性序列（0→1 均匀扫过）──`);
  console.log(`  分布 ${counts.join(' / ')}，极差 ${spread}`);
  console.log(`  判定：${spread <= 2 ? '✓ 三等分精确无偏' : '✗ 分段边界有问题'}`);
})();

console.log(`\n${'═'.repeat(60)}`);
console.log(allPass
  ? '结论：全部场景通过卡方检验，抽选分布符合权重预期，未发现偏差。'
  : '结论：存在偏差，需排查。');
console.log('═'.repeat(60));
process.exit(allPass ? 0 : 1);
