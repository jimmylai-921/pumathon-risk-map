// 門牌正規化一致性測試：JS 對 scripts/addr_norm.py 的預期結果，並經分片 alias 查回建物。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { normalizeAddress, cnToInt, splitStreet, suggestNearby, extractRoad, zhiVariant } from '../src/addr.js';
import { loadData, loadShard, parity, readJson, DATA_DIR } from './helpers.js';

const fx = parity();
const { meta } = loadData();

test('(c) 全部 address_cases 的 district / street 正規化相符', () => {
  assert.equal(fx.address_cases.length, 60);
  for (const c of fx.address_cases) {
    const r = normalizeAddress(c.input);
    assert.equal(r.district, c.district, `district：${c.input}`);
    assert.equal(r.street, c.street, `street：${c.input}`);
  }
});

test('(d) 有 index 的案例能經分片 alias 查到正確建物', () => {
  const cases = fx.address_cases.filter((c) => c.index != null);
  assert.equal(cases.length, 40);
  for (const c of cases) {
    const r = normalizeAddress(c.input);
    const shard = loadShard(meta, r.district);
    assert.ok(shard, `找不到分片：${r.district}`);
    assert.equal(shard.alias[r.street], c.index, c.input);
  }
});

test('中文段數轉換', () => {
  assert.equal(cnToInt('三'), '3');
  assert.equal(cnToInt('十'), '10');
  assert.equal(cnToInt('十二'), '12');
  assert.equal(cnToInt('二十'), '20');
  assert.equal(cnToInt('二十一'), '21');
});

test('樓層與里鄰處理', () => {
  const r = normalizeAddress('臺北市 大安區 仁愛路四段 ３００巷 ２０弄 ３號 ５樓之１');
  assert.deepEqual(r, { district: '大安區', street: '仁愛路4段300巷20弄3號', floor: '5樓之1' });
  assert.equal(normalizeAddress('台北市信義區5鄰松仁路100號').street, '松仁路100號');
  assert.equal(normalizeAddress('沒有門牌').street, null);
});

test('同路段最接近門牌建議', () => {
  assert.deepEqual(splitStreet('南京東路5段251巷22弄28號'),
    { segment: '南京東路5段251巷', prefix: '南京東路5段251巷22弄', no: 28, sub: 0 });
  const keys = ['仁愛路3段24巷1號', '仁愛路3段24巷5號', '仁愛路3段24巷1-2號', '仁愛路3段26巷1號', '仁愛路3段30號'];
  assert.deepEqual(suggestNearby('仁愛路3段24巷2號', keys, 5),
    ['仁愛路3段24巷1號', '仁愛路3段24巷1-2號', '仁愛路3段24巷5號']);
  // 實際分片：故意給不存在的號碼，應找到同巷門牌
  const shard = loadShard(meta, '大安區');
  const s = suggestNearby('復興南路1段107巷5弄9999號', Object.keys(shard.alias), 5);
  assert.ok(s.length > 0 && s.every((k) => k.startsWith('復興南路1段107巷')));
});

test('公舘路異體字統一（含私用區字元）', () => {
  for (const ch of ['?', '�', '', '', '□', '館', '錧']) {
    assert.equal(normalizeAddress(`北投區公${ch}路100號`).street, '公舘路100號', `異體字 U+${ch.codePointAt(0).toString(16)}`);
  }
});

test('路段抽取與 roads.json 索引', () => {
  assert.equal(extractRoad('仁愛路3段24巷1-1號'), '仁愛路3段');
  assert.equal(extractRoad('公舘路267-1號'), '公舘路');
  assert.equal(extractRoad('凱達格蘭大道1號'), '凱達格蘭大道');
  assert.equal(extractRoad('123號'), null);
  const roads = readJson(join(DATA_DIR, 'addr', 'roads.json'));
  // 沒帶區的案例：路段索引列出的分片中必須包含該門牌所在區
  for (const c of fx.address_cases.filter((x) => x.index != null)) {
    const road = extractRoad(c.street);
    if (!road || !roads[road]) continue;
    assert.ok(roads[road].includes(meta.codebooks.district.indexOf(c.district)), `${c.street} 的路段 ${road}`);
  }
  assert.deepEqual(roads['仁愛路3段'].map((d) => meta.codebooks.district[d]), ['大安區']);
});

test('「號之N」：先試 N-M號，再退回 N號', () => {
  const n = normalizeAddress('大安區忠孝東路四段1號之2');
  assert.deepEqual(zhiVariant(n), { street: '忠孝東路4段1-2號', suffix: '之2' });
  assert.equal(zhiVariant(normalizeAddress('忠孝東路4段1號之2樓')), null); // 之2樓 是樓層
  assert.equal(zhiVariant(normalizeAddress('台北市士林區中山北路五段618號5樓之2')), null);
});
