// 門牌正規化（純函式、無 DOM）：移植自 scripts/addr_norm.py，瀏覽器與 Node 測試共用。
// 規則：NFKC → 去空白 → 臺→台 → 公舘路異體字 → 去郵遞區號 → 去里名／「XX里X鄰」「X鄰」→ 中文段數轉阿拉伯數字 → 數字之數字 → 「-」→ 取到「號」為止。
// 輸出的 street 不含「台北市XX區」前綴，與 web/public/data/addr/{d}.json 的 alias 鍵相同格式。

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 段數中文 → 阿拉伯數字（段數只會到十幾，與 Python _cn_to_int 相同） */
export function cnToInt(s) {
  if (/^\d+$/.test(s)) return s;
  if (s === '十') return '10';
  if (s.startsWith('十')) return String(10 + CN_NUM[s[1]]);
  if (s.endsWith('十')) return String(CN_NUM[s[0]] * 10);
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return String(CN_NUM[a] * 10 + CN_NUM[b]);
  }
  return CN_NUM[s] != null ? String(CN_NUM[s]) : s;
}

// 北投區「公舘路」的「舘」不在 Big5：各來源有「?」、U+FFFD、私用區字元（U+E16D、U+E15E）、「□」、「館」「錧」等寫法，
// 統一回正式路名（與 scripts/addr_norm.py 相同字元集合）
const RE_GONGGUAN = /公[?\uFFFD\uE16D\uE15E\u25A1館錧]路/g;
// 郵遞區號前綴：「106」「10617」「106017」「(106)」，只在後面接「台北」或「XX區」時才算
// 後面接「台北」「XX區」「XX里」或路名才算郵遞區號；「123巷4號」的「巷」後面不是路街，不會被誤刪（同 addr_norm.py）
const RE_ZIP = /^\(?\d{3}(?:\d{2,3})?\)?(?=台北|[一-鿿]{2}區|[一-鿿]{1,3}里|[一-鿿]+?(?:路|街|大道))/;
// 里名：區後面的里名（鄰可有可無）；沒寫區時，開頭（可帶台北市）的里名
// （已確認臺北市沒有以「X里」開頭的路名，也沒有路名以里名開頭，不會誤刪）
const RE_VILLAGE_AFTER_DISTRICT = /(?<=區)[一-鿿]{1,3}里(?:\d+鄰)?/g;
const RE_VILLAGE_LEADING = /^(台北市)?[一-鿿]{1,3}里(?:\d+鄰)?(?=[一-鿿])/;
const RE_VILLAGE = /[一-鿿]{1,3}里\d+鄰/g;
const RE_NEIGHBOR = /(?<=區)\d+鄰/g;
const RE_SECTION = /([一二三四五六七八九十]+)段/g;
const RE_ZHI = /(\d+)之(\d+)(?=[號巷弄])/g;
const RE_SPLIT = /^(?:台北市)?([一-鿿]{2}區)?(.*?\d+(?:-\d+)?號)(.*)$/;

/**
 * 正規化門牌。
 * @param {string} input 使用者輸入（可含或不含「臺北市」「XX區」與樓層）
 * @returns {{district: string|null, street: string|null, floor: string}}
 */
export function normalizeAddress(input) {
  let x = String(input ?? '').normalize('NFKC');
  x = x.replace(/\s+/g, '').replace(/臺/g, '台');
  x = x.replace(RE_GONGGUAN, '公舘路');
  x = x.replace(RE_ZIP, '');
  x = x.replace(RE_VILLAGE_AFTER_DISTRICT, '');
  x = x.replace(RE_VILLAGE_LEADING, '$1');
  x = x.replace(RE_VILLAGE, '');
  x = x.replace(RE_NEIGHBOR, '');
  x = x.replace(RE_SECTION, (_, g) => `${cnToInt(g)}段`);
  x = x.replace(RE_ZHI, '$1-$2');
  const m = x.match(RE_SPLIT);
  if (!m) return { district: null, street: null, floor: '' };
  return { district: m[1] || null, street: m[2], floor: m[3] || '' };
}

// 路段：與 scripts/07_export_web.py 產生 roads.json 的規則相同
const RE_ROAD = /^([一-鿿]+?(?:路|街|大道)(?:\d+段)?)/;

/** 從（已去掉市區前綴的）門牌抽出路段，例：仁愛路3段24巷1-1號 → 仁愛路3段；抽不出回傳 null */
export function extractRoad(street) {
  const m = String(street ?? '').match(RE_ROAD);
  return m ? m[1] : null;
}

/**
 * 「1號之2」寫法：正規化後「之2」會落在樓層欄而被丟掉。
 * 若樓層欄以「之N」開頭（且不是「之N樓」），回傳等同「1之2號」的門牌 1-2號 供優先查詢。
 * @returns {{street: string, suffix: string}|null}
 */
export function zhiVariant(norm) {
  if (!norm?.street) return null;
  const f = String(norm.floor ?? '').match(/^之(\d+)(?!\d*樓)/);
  if (!f || !/\d+號$/.test(norm.street) || /-\d+號$/.test(norm.street)) return null;
  return { street: norm.street.replace(/號$/, `-${f[1]}號`), suffix: `之${f[1]}` };
}

const RE_NO = /^(.*?)(\d+)(?:-(\d+))?號$/;

/**
 * 拆出門牌的「路段鍵」（路名＋段＋巷，不含弄與號）與號碼，用來找同一路段最接近的門牌。
 * 例：南京東路5段251巷22弄28號 → {segment: '南京東路5段251巷', prefix: '南京東路5段251巷22弄', no: 28, sub: 0}
 */
export function splitStreet(street) {
  const m = String(street ?? '').match(RE_NO);
  if (!m) return null;
  const prefix = m[1];
  const lane = prefix.match(/^(.*?\d+巷)/);
  const segment = lane ? lane[1] : prefix.replace(/\d+弄$/, '');
  return { segment, prefix, no: Number(m[2]), sub: m[3] ? Number(m[3]) : 0 };
}

/**
 * 在候選門牌中找同一路段（同路名＋巷）最接近的門牌。
 * @param {string} street 正規化後查不到的門牌
 * @param {Iterable<string>} keys 候選門牌（alias 鍵）
 * @param {number} limit 最多幾筆
 * @returns {string[]}
 */
export function suggestNearby(street, keys, limit = 5) {
  const t = splitStreet(street);
  if (!t || !t.segment) return [];
  const out = [];
  for (const k of keys) {
    if (!k.startsWith(t.segment)) continue;
    const c = splitStreet(k);
    if (!c || c.segment !== t.segment) continue;
    const samePrefix = c.prefix === t.prefix ? 0 : 1;
    out.push({ k, d: [samePrefix, Math.abs(c.no - t.no), Math.abs(c.sub - t.sub), c.no, c.sub] });
  }
  out.sort((a, b) => {
    for (let i = 0; i < a.d.length; i++) if (a.d[i] !== b.d[i]) return a.d[i] - b.d[i];
    return a.k < b.k ? -1 : 1;
  });
  return out.slice(0, limit).map((o) => o.k);
}
