// 風險模型（純函式、無 DOM）：瀏覽器與 Node 測試共用。
// 公式必須與 scripts/06_risk_model.py 的 compute() 完全一致：
//   V  = Σ wv_i·s_i / Wv
//   V' = 有海砂屋列管時 max(V, 覆寫值)，否則 V
//   H  = Σ wh_h·s_h / Wh
//   S  = Σ ws_j·s_j / Ws
//   seismic = V'·(1+αH)/(1+α)
//   score   = 100·[(1−β)·seismic + β·S]
// 貢獻分（加總恰等於 score），k = 100(1−β)/(1+α)：
//   脆弱度因子 i：k·wv_i·s_i/Wv；海砂屋：k·(V'−V)；危害因子 h：k·V'·α·wh_h·s_h/Wh；社會因子 j：100β·ws_j·s_j/Ws

export const V_KEYS = ['era', 'structure', 'typology', 'soft_story'];
export const H_KEYS = ['liquefaction', 'fault'];
export const S_KEYS = ['elderly', 'fire_access'];
export const FACTOR_KEYS = [...V_KEYS, ...H_KEYS, ...S_KEYS];
/** 貢獻分的鍵（9 個，含海砂屋） */
export const CONTRIB_KEYS = [...V_KEYS, 'seasand', ...H_KEYS, ...S_KEYS];

export const LABELS = {
  era: '屋齡法規時期',
  structure: '結構',
  typology: '樓層型態',
  soft_story: '軟弱底層',
  seasand: '海砂屋列管',
  liquefaction: '土壤液化',
  fault: '山腳斷層',
  elderly: '里高齡比例',
  fire_access: '消防通道',
};

export const GROUP_OF = {
  era: 'vulnerability', structure: 'vulnerability', typology: 'vulnerability', soft_story: 'vulnerability',
  seasand: 'vulnerability', liquefaction: 'hazard', fault: 'hazard', elderly: 'social', fire_access: 'social',
};

/** 分級：依全市百分位，前 5% 極高、5–15% 高、15–40% 中、其餘低 */
export const TIERS = [
  { key: 'very_high', label: '極高', top: 0.05 },
  { key: 'high', label: '高', top: 0.15 },
  { key: 'mid', label: '中', top: 0.40 },
  { key: 'low', label: '低', top: 1 },
];

const TYPED = { float32: Float32Array, uint16: Uint16Array, uint8: Uint8Array };

/**
 * 解碼 buildings.bin：依 meta.columns 建立 typed array view（不複製資料）。
 * @param {object} meta meta.json 內容
 * @param {ArrayBuffer} buffer buildings.bin 的 ArrayBuffer
 */
export function decode(meta, buffer) {
  const cols = {};
  for (const c of meta.columns) {
    const T = TYPED[c.dtype];
    if (!T) throw new Error(`未知欄位型別：${c.name} ${c.dtype}`);
    cols[c.name] = new T(buffer, c.offset, c.length);
  }
  const n = meta.count;
  // 海砂屋覆寫值表：代碼 → 覆寫值（非列管為 -1，取 max 時等同不覆寫）
  const book = meta.codebooks.seasand_class;
  const override = meta.config.vulnerability.seasand_override;
  const seasandTable = new Float64Array(book.length).fill(-1);
  book.forEach((name, code) => { if (name != null && override[name] != null) seasandTable[code] = override[name]; });
  return { n, cols, meta, scale: meta.factor_scale || 65535, seasandTable };
}

/** 從 config 讀出預設參數（深複製，避免滑桿改到原物件） */
export function defaultParams(config) {
  return {
    vulnerability: { ...config.vulnerability.weights },
    hazard: { ...config.hazard.weights },
    social: { ...config.social.weights },
    alpha: config.alpha,
    beta: config.beta,
  };
}

function sumOf(obj, keys) {
  let s = 0;
  for (const k of keys) s += Number(obj[k]) || 0;
  return s;
}

/** 權重和為 0 時（滑桿全拉到 0）該群組分數視為 0，避免除以 0 */
function groupWeights(params) {
  const Wv = sumOf(params.vulnerability, V_KEYS);
  const Wh = sumOf(params.hazard, H_KEYS);
  const Ws = sumOf(params.social, S_KEYS);
  const norm = (w, W) => (W > 0 ? w / W : 0);
  return {
    Wv, Wh, Ws,
    nv: V_KEYS.map((k) => norm(params.vulnerability[k], Wv)),
    nh: H_KEYS.map((k) => norm(params.hazard[k], Wh)),
    ns: S_KEYS.map((k) => norm(params.social[k], Ws)),
  };
}

/**
 * 全市重算分數（熱迴圈：直接讀 uint16 因子分數，權重預先除以 65535）。
 * @returns {Float32Array} 每棟分數 0–100
 */
export function computeScores(data, params, out) {
  const { n, cols, scale, seasandTable } = data;
  const res = out && out.length === n ? out : new Float32Array(n);
  const g = groupWeights(params);
  const a = Number(params.alpha), b = Number(params.beta);
  const kv0 = g.nv[0] / scale, kv1 = g.nv[1] / scale, kv2 = g.nv[2] / scale, kv3 = g.nv[3] / scale;
  const kh0 = g.nh[0] / scale, kh1 = g.nh[1] / scale;
  const ks0 = g.ns[0] / scale, ks1 = g.ns[1] / scale;
  const c1 = (100 * (1 - b)) / (1 + a);
  const c2 = 100 * b;
  const e = cols.s_era, st = cols.s_structure, ty = cols.s_typology, so = cols.s_soft_story;
  const lq = cols.s_liquefaction, fa = cols.s_fault, el = cols.s_elderly, fr = cols.s_fire_access;
  const ss = cols.seasand_class;
  for (let i = 0; i < n; i++) {
    const V = kv0 * e[i] + kv1 * st[i] + kv2 * ty[i] + kv3 * so[i];
    const ov = seasandTable[ss[i]];
    const Vp = ov > V ? ov : V;
    const H = kh0 * lq[i] + kh1 * fa[i];
    const S = ks0 * el[i] + ks1 * fr[i];
    res[i] = c1 * Vp * (1 + a * H) + c2 * S;
  }
  return res;
}

/** 單棟因子分數（0–1，float64） */
export function factorScores(data, i) {
  const f = {};
  for (const k of FACTOR_KEYS) f[k] = data.cols[`s_${k}`][i] / data.scale;
  const ov = data.seasandTable[data.cols.seasand_class[i]];
  f.seasand = ov >= 0 ? ov : null;
  return f;
}

/**
 * 單棟分數拆解（float64）：中間值與 9 個貢獻分，貢獻分加總 = score。
 */
export function explainScore(data, i, params) {
  const f = factorScores(data, i);
  const g = groupWeights(params);
  const a = Number(params.alpha), b = Number(params.beta);
  let V = 0, H = 0, S = 0;
  V_KEYS.forEach((k, j) => { V += g.nv[j] * f[k]; });
  H_KEYS.forEach((k, j) => { H += g.nh[j] * f[k]; });
  S_KEYS.forEach((k, j) => { S += g.ns[j] * f[k]; });
  const Vp = f.seasand != null ? Math.max(V, f.seasand) : V;
  const seismic = (Vp * (1 + a * H)) / (1 + a);
  const score = 100 * ((1 - b) * seismic + b * S);
  const k = (100 * (1 - b)) / (1 + a);
  const contributions = {};
  const normWeight = {};
  V_KEYS.forEach((key, j) => { normWeight[key] = g.nv[j]; contributions[key] = k * g.nv[j] * f[key]; });
  contributions.seasand = k * (Vp - V);
  H_KEYS.forEach((key, j) => { normWeight[key] = g.nh[j]; contributions[key] = k * Vp * a * g.nh[j] * f[key]; });
  S_KEYS.forEach((key, j) => { normWeight[key] = g.ns[j]; contributions[key] = 100 * b * g.ns[j] * f[key]; });
  return {
    index: i, score, V, Vp, H, S, seismic, k, alpha: a, beta: b,
    siteMultiplier: 1 + a * H, factors: f, normWeight, contributions,
  };
}

/**
 * 排名與分級門檻（依目前權重的全市分數重算）。
 * sorted 為遞增排序的分數副本，用二分搜尋查單棟排名。
 */
export function rankStats(scores) {
  const sorted = Float32Array.from(scores).sort();
  const n = sorted.length;
  // 前 p 比例的門檻 = 遞減排序第 floor(p·n) 名的分數；分數 ≥ 門檻者落在該級以上
  const at = (p) => sorted[Math.max(0, n - Math.max(1, Math.floor(p * n)))];
  return {
    sorted,
    n,
    thresholds: { very_high: at(0.05), high: at(0.15), mid: at(0.40) },
    min: sorted[0],
    max: sorted[n - 1],
    quantile: (q) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))],
  };
}

/** 分級索引：0 極高、1 高、2 中、3 低 */
export function tierIndex(score, thresholds) {
  if (score >= thresholds.very_high) return 0;
  if (score >= thresholds.high) return 1;
  if (score >= thresholds.mid) return 2;
  return 3;
}

/** 全市排名（1 = 最高分；同分同名次，method=min）與「前 x%」 */
export function rankOf(score, stats) {
  const s = Math.fround(score);
  const { sorted, n } = stats;
  // 找第一個 > s 的位置 → 比它高分的棟數 = n - pos
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] > s) hi = mid; else lo = mid + 1;
  }
  const rank = n - lo + 1;
  return { rank, topPct: rank / n };
}

/** 影響戶數 = 分數/100 × 戶數（不混進分數，只供排名切換） */
export function householdImpact(scores, nUnits, out) {
  const n = scores.length;
  const res = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) res[i] = (scores[i] / 100) * nUnits[i];
  return res;
}

/**
 * 取前 N 名索引（依 values 遞減，同值依索引遞增），可帶 mask 篩選（mask[i]=0 排除）。
 * 以門檻先篩出候選再排序，避免對全部 23 萬筆排序索引；sortedAsc 可傳 rankStats().sorted 省一次排序。
 */
export function topN(values, N, mask, sortedAsc) {
  const n = values.length;
  let cand = [];
  let pool;
  if (!mask && sortedAsc && sortedAsc.length === n) {
    pool = sortedAsc; // 已排序（rankStats 的結果），不必再排一次
  } else if (mask) {
    pool = [];
    for (let i = 0; i < n; i++) if (mask[i]) pool.push(values[i]);
    pool = Float32Array.from(pool).sort();
  } else {
    pool = Float32Array.from(values).sort();
  }
  if (pool.length === 0 || N <= 0) return new Uint32Array(0);
  const t = pool[Math.max(0, pool.length - Math.min(N, pool.length))];
  for (let i = 0; i < n; i++) if (values[i] >= t && (!mask || mask[i])) cand.push(i);
  cand.sort((x, y) => values[y] - values[x] || x - y);
  if (cand.length > N) cand = cand.slice(0, N);
  return Uint32Array.from(cand);
}

/**
 * 四捨五入但保持總和（最大餘數法）：各列顯示值加總恰等於顯示的總分。
 * @param {number[]} values 各貢獻分
 * @param {number} decimals 小數位數
 * @returns {{parts:number[], total:number}}
 */
export function roundPreservingSum(values, decimals = 2) {
  const f = 10 ** decimals;
  const exactTotal = values.reduce((s, v) => s + v, 0);
  const total = Math.round(exactTotal * f);
  const floors = values.map((v) => Math.floor(v * f + 1e-9));
  let rest = total - floors.reduce((s, v) => s + v, 0);
  const order = values
    .map((v, i) => ({ i, r: v * f - floors[i] }))
    .sort((x, y) => y.r - x.r || x.i - y.i);
  const parts = floors.slice();
  for (let j = 0; rest > 0 && j < order.length; j++, rest--) parts[order[j].i] += 1;
  for (let j = order.length - 1; rest < 0 && j >= 0; j--, rest++) parts[order[j].i] -= 1;
  return { parts: parts.map((p) => p / f), total: total / f };
}

/** 位元旗標 */
export function hasFlag(data, i, name) {
  const bit = data.meta.flag_bits[name];
  return bit ? (data.cols.flags[i] & bit) !== 0 : false;
}

/** 類別欄代碼 → 文字（0 = 缺值 → null） */
export function codeLabel(data, col, i) {
  const book = data.meta.codebooks[col];
  const code = data.cols[col][i];
  return code && book ? book[code] ?? null : null;
}

/** 樓層型態分類（與 Python factor_scores 相同的分段），供說明面板顯示 */
export function typologyClass(floorCount, elevator) {
  if (!floorCount) return '未知';
  if (floorCount <= 3) return '1-3';
  if (floorCount <= 7) return elevator === '有' ? '4-7_有電梯' : '4-7';
  if (floorCount <= 12) return '8-12';
  return '13+';
}

/** 目前參數是否偏離 config 預設（權重、α、β 任一不同即為自訂） */
export function isCustomParams(params, defaults, eps = 1e-9) {
  const diff = (a, b) => Math.abs(Number(a) - Number(b)) > eps;
  if (diff(params.alpha, defaults.alpha) || diff(params.beta, defaults.beta)) return true;
  for (const [g, keys] of [['vulnerability', V_KEYS], ['hazard', H_KEYS], ['social', S_KEYS]]) {
    for (const k of keys) if (diff(params[g][k], defaults[g][k])) return true;
  }
  return false;
}

/** 「前 x%」顯示：不足 0.1% 時顯示「<0.1%」，避免出現「前 0.0%」 */
export function formatTopPct(topPct) {
  const v = topPct * 100;
  return v < 0.1 ? '<0.1%' : `${v.toFixed(1)}%`;
}
