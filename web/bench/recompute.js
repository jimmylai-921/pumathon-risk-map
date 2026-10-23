// 效能量測：全市 235,964 棟重算分數（以及排名門檻、繪圖陣列）的時間。
// 用法：npm run bench
import { computeScores, defaultParams, rankStats, topN, householdImpact } from '../src/model.js';
import { buildLayerArrays, colorDomain } from '../src/colors.js';
import { loadData } from '../test/helpers.js';

const data = loadData();
const base = defaultParams(data.meta.config);
const out = new Float32Array(data.n);
const RUNS = 30;

function time(label, fn) {
  for (let i = 0; i < 3; i++) fn(i); // 暖機
  const t = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn(i);
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  console.log(`${label}：中位數 ${t[RUNS >> 1].toFixed(2)} ms（最快 ${t[0].toFixed(2)}、最慢 ${t[RUNS - 1].toFixed(2)}）`);
}

// 每次稍微改權重，避免被最佳化成常數
const vary = (i) => ({ ...base, alpha: base.alpha + (i % 7) * 0.01 });

console.log(`建物 ${data.n.toLocaleString()} 棟，各量測 ${RUNS} 次`);
time('重算分數 computeScores', (i) => computeScores(data, vary(i), out));
time('重算分數＋分級門檻＋前 100 名＋色彩陣列（滑桿一次的完整計算）', (i) => {
  const s = computeScores(data, vary(i), out);
  const st = rankStats(s);
  topN(s, 100, null, st.sorted);
  buildLayerArrays(data, s, colorDomain(st), null);
});
time('依影響戶數排名（影響戶數＋前 100 名）', () => topN(householdImpact(out, data.cols.n_units), 100));
