// 風險公式一致性測試：JS（bin 量化因子分數）對 Python compute() 的預期值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeScores, explainScore, defaultParams, CONTRIB_KEYS, rankStats, tierIndex, rankOf,
  topN, householdImpact, roundPreservingSum,
} from '../src/model.js';
import { loadData, parity } from './helpers.js';

const data = loadData();
const fx = parity();
const tol = fx.tolerance;

const paramsOf = (c) => ({
  vulnerability: c.vulnerability, hazard: c.hazard, social: c.social, alpha: c.alpha, beta: c.beta,
});

test('解碼：筆數與欄位長度正確', () => {
  assert.equal(data.n, 235964);
  for (const [name, arr] of Object.entries(data.cols)) assert.equal(arr.length, data.n, name);
});

test('預設權重第一組 fixture 與 config 相同', () => {
  const d = defaultParams(data.meta.config);
  const c = fx.cases.find((x) => x.name === '預設');
  assert.deepEqual(d, paramsOf(c));
});

for (const c of fx.cases) {
  test(`(a) 分數誤差 < ${tol}：${c.name}（${c.expected.length} 棟）`, (t) => {
    const p = paramsOf(c);
    const scores = computeScores(data, p);
    let worst = 0;
    for (const e of c.expected) {
      const d = Math.abs(scores[e.index] - e.score);
      worst = Math.max(worst, d);
      assert.ok(d < tol, `建物 ${e.index}：JS ${scores[e.index]} vs Python ${e.score}`);
      // 單棟 float64 拆解與全市熱迴圈結果一致
      assert.ok(Math.abs(explainScore(data, e.index, p).score - scores[e.index]) < 1e-3);
    }
    t.diagnostic(`最大誤差 ${worst.toFixed(6)}`);
  });

  test(`(b) 9 個貢獻分誤差 < ${tol} 且加總 = 分數：${c.name}`, (t) => {
    const p = paramsOf(c);
    let worst = 0, worstSum = 0;
    for (const e of c.expected) {
      const x = explainScore(data, e.index, p);
      assert.deepEqual(Object.keys(x.contributions).sort(), [...CONTRIB_KEYS].sort());
      let sum = 0;
      for (const k of CONTRIB_KEYS) {
        const d = Math.abs(x.contributions[k] - e.contributions[k]);
        worst = Math.max(worst, d);
        assert.ok(d < tol, `建物 ${e.index} ${k}：JS ${x.contributions[k]} vs Python ${e.contributions[k]}`);
        sum += x.contributions[k];
      }
      worstSum = Math.max(worstSum, Math.abs(sum - x.score));
      assert.ok(Math.abs(sum - x.score) < 1e-6, `建物 ${e.index} 貢獻分加總 ${sum} ≠ 分數 ${x.score}`);
    }
    t.diagnostic(`貢獻分最大誤差 ${worst.toFixed(6)}；加總差最大 ${worstSum.toExponential(2)}`);
  });
}

test('分級門檻：各級比例約為 5% / 10% / 25% / 60%', () => {
  const scores = computeScores(data, defaultParams(data.meta.config));
  const st = rankStats(scores);
  const cnt = [0, 0, 0, 0];
  for (const s of scores) cnt[tierIndex(s, st.thresholds)]++;
  const share = cnt.map((v) => v / data.n);
  assert.ok(Math.abs(share[0] - 0.05) < 0.01, `極高 ${share[0]}`);
  assert.ok(Math.abs(share[0] + share[1] - 0.15) < 0.01);
  assert.ok(Math.abs(share[0] + share[1] + share[2] - 0.40) < 0.01);
  // 最高分排名第 1
  let maxI = 0;
  for (let i = 1; i < data.n; i++) if (scores[i] > scores[maxI]) maxI = i;
  assert.equal(rankOf(scores[maxI], st).rank, 1);
});

test('topN：依分數與依影響戶數排序', () => {
  const scores = computeScores(data, defaultParams(data.meta.config));
  const top = topN(scores, 100);
  assert.equal(top.length, 100);
  for (let j = 1; j < top.length; j++) assert.ok(scores[top[j - 1]] >= scores[top[j]]);
  const imp = householdImpact(scores, data.cols.n_units);
  const topH = topN(imp, 50);
  for (let j = 1; j < topH.length; j++) assert.ok(imp[topH[j - 1]] >= imp[topH[j]]);
});

test('roundPreservingSum：顯示值加總等於顯示總分', () => {
  const vals = [17.5, 13.491762, 6, 0, 0, 12.947117, 0, 7.264254, 0];
  const r = roundPreservingSum(vals, 2);
  const s = r.parts.reduce((a, b) => a + b, 0);
  assert.equal(Math.round(s * 100), Math.round(r.total * 100));
  assert.equal(r.total, 57.2);
});
