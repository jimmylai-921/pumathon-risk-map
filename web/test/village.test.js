// 里別聚合：索引涵蓋所有有里的建物、平均與分級計數與逐棟暴力計算一致、排序與 CSV 欄數正確。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScores, defaultParams, rankStats, tierIndex } from '../src/model.js';
import {
  buildVillageIndex, aggregateVillages, rankVillages, villageRank, villageCsvRows,
} from '../src/village.js';
import { loadData } from './helpers.js';

const setup = () => {
  const data = loadData();
  const scores = computeScores(data, defaultParams(data.meta.config));
  const stats = rankStats(scores);
  const vindex = buildVillageIndex(data);
  const agg = aggregateVillages(data, vindex, scores, stats.thresholds);
  return { data, scores, stats, vindex, agg };
};

test('buildVillageIndex：每棟有里的建物恰出現一次，且落在自己的里', () => {
  const { data, vindex } = setup();
  const withVillage = data.cols.village.filter((v) => v !== 65535).length;
  assert.equal(vindex.members.length, withVillage);
  assert.equal(vindex.nv, data.meta.villages.length);
  for (let v = 0; v < vindex.nv; v += 37) {
    for (let k = vindex.start[v]; k < vindex.start[v + 1]; k++) assert.equal(data.cols.village[vindex.members[k]], v);
  }
});

test('aggregateVillages：平均分數、分級棟數、戶數與暴力計算一致', () => {
  const { data, scores, stats, agg } = setup();
  for (const v of [0, 100, 255, 455]) {
    let s = 0, c = 0, u = 0;
    const t = [0, 0, 0, 0];
    for (let i = 0; i < data.n; i++) {
      if (data.cols.village[i] !== v) continue;
      s += scores[i];
      c++;
      u += data.cols.n_units[i];
      t[tierIndex(scores[i], stats.thresholds)]++;
    }
    assert.equal(agg.count[v], c);
    assert.equal(agg.units[v], u);
    assert.ok(Math.abs(agg.mean[v] - s / c) < 1e-3, `里 ${v} 平均`);
    assert.deepEqual(Array.from(agg.tiers.subarray(v * 4, v * 4 + 4)), t);
    assert.ok(Math.abs(agg.highShare[v] - (t[0] + t[1]) / c) < 1e-6);
  }
});

test('rankVillages：依指標遞減、可依行政區篩選；villageRank 與排序一致', () => {
  const { data, agg } = setup();
  const all = rankVillages(agg, 'mean', data);
  assert.equal(all.length, agg.nv);
  for (let k = 1; k < all.length; k++) assert.ok(agg.mean[all[k - 1]] >= agg.mean[all[k]]);
  assert.equal(villageRank(agg, 'mean', all[0]).rank, 1);
  const code = data.meta.codebooks.district.indexOf('大同區');
  const dt = rankVillages(agg, 'elderly', data, code);
  assert.ok(dt.length > 0 && dt.every((v) => data.meta.villages[v].district === '大同區'));
});

test('villageCsvRows：每列欄數與標頭相同', () => {
  const { data, agg, scores, stats } = setup();
  const st = { data, vagg: agg, scores, stats };
  const rows = villageCsvRows(st, rankVillages(agg, 'mean', data));
  assert.equal(rows.length, agg.nv + 1);
  assert.ok(rows.every((r) => r.length === rows[0].length));
});
