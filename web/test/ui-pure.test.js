// UI 端純函式：b 參數嚴格解析、CSV 公式注入防護、百分比顯示、自訂權重判斷。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndex } from '../src/util.js';
import { csvCell } from '../src/sidebar.js';
import { formatTopPct, isCustomParams, defaultParams } from '../src/model.js';
import { loadData } from './helpers.js';

test('parseIndex：只接受 0 <= n < count 的整數字串', () => {
  const N = 235964;
  for (const bad of ['1.5', 'NaN', '', ' ', '-1', '1e3', '0x10', '235964', ' 12', null, undefined]) {
    assert.equal(parseIndex(bad, N), null, String(bad));
  }
  assert.equal(parseIndex('0', N), 0);
  assert.equal(parseIndex('235963', N), 235963);
});

test('csvCell：字串以 = + - @ Tab CR 開頭時加單引號，數字不動', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+886'), "'+886");
  assert.equal(csvCell('-x'), "'-x");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('\rx'), '"\'\rx"');
  assert.equal(csvCell('仁愛路3段24巷1-1號'), '仁愛路3段24巷1-1號');
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(-1.25), '-1.25');
  assert.equal(csvCell(88.7), '88.7');
});

test('formatTopPct：不足 0.1% 顯示 <0.1%', () => {
  assert.equal(formatTopPct(1 / 235964), '<0.1%');
  assert.equal(formatTopPct(0.001), '0.1%');
  assert.equal(formatTopPct(0.0037), '0.4%');
});

test('isCustomParams：偏離 config 預設才算自訂', () => {
  const cfg = loadData().meta.config;
  const d = defaultParams(cfg);
  assert.equal(isCustomParams(defaultParams(cfg), d), false);
  const p = defaultParams(cfg);
  p.vulnerability.structure = 0.97;
  assert.equal(isCustomParams(p, d), true);
  const q = defaultParams(cfg);
  q.beta = 0.3;
  assert.equal(isCustomParams(q, d), true);
});
