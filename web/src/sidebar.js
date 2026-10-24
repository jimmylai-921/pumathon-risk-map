// A｜側欄：權重滑桿、公式、圖例、篩選、排行榜、匯出 CSV。
import {
  V_KEYS, H_KEYS, S_KEYS, LABELS, TIERS, CONTRIB_KEYS, tierIndex, explainScore, roundPreservingSum,
} from './model.js';
import { rampCss } from './colors.js';
import { TIER_CLASS } from './explain.js';
import { esc, fmt, fmtInt, downloadText } from './util.js';

const GROUPS = [
  { key: 'vulnerability', title: '建物本體（脆弱度 V）', keys: V_KEYS },
  { key: 'hazard', title: '場址危害（H，放大 V）', keys: H_KEYS },
  { key: 'social', title: '救災社會（S）', keys: S_KEYS },
];

/** 側欄骨架 HTML（滑桿依 config 預設值產生） */
export function sidebarHtml(st) {
  const sl = (id, label, value, min, max, step) => `
    <label class="slider">
      <span class="sl-label">${esc(label)}</span>
      <input type="range" id="w-${id}" data-w="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
      <output id="o-${id}">${fmt(value, 2)}</output>
    </label>`;
  const groups = GROUPS.map((g) => `
    <fieldset class="wgroup"><legend>${esc(g.title)}</legend>
      ${g.keys.map((k) => sl(`${g.key}.${k}`, LABELS[k], st.params[g.key][k], 0, 1, 0.01)).join('')}
    </fieldset>`).join('');
  const districts = st.data.meta.codebooks.district
    .map((d, i) => (d ? `<option value="${i}">${esc(d)}</option>` : '')).join('');
  return `
  <section class="panel">
    <div class="panel-head">
      <h2>權重設定</h2>
      <button class="btn btn-ghost btn-sm" data-action="reset">回復預設</button>
    </div>
    ${groups}
    <fieldset class="wgroup"><legend>組合參數</legend>
      ${sl('alpha', 'α 場址加成上限', st.params.alpha, 0, 2, 0.05)}
      ${sl('beta', 'β 救災社會占比', st.params.beta, 0, 1, 0.01)}
    </fieldset>
    <div id="formula" class="formula"></div>
    <div class="perf" id="perf"></div>
  </section>
  <section class="panel">
    <h2>圖例與篩選</h2>
    <div id="legend" class="legend"></div>
    <label class="field">行政區
      <select id="f-district"><option value="0">全部 12 區</option>${districts}</select>
    </label>
    <div class="tiers-filter only-building">
      ${TIERS.map((t, i) => `<label class="chk"><input type="checkbox" data-tier="${i}" checked><span class="tier-dot ${TIER_CLASS[i]}"></span>${t.label}</label>`).join('')}
    </div>
  </section>
  <section class="panel">
    <div class="panel-head">
      <h2 id="lb-title">優先健檢排行榜</h2>
    </div>
    <div class="only-village">
      <p class="hint">依地圖上色指標排序；點一列看該里統計。</p>
      <div class="row"><span class="hint" id="vlb-count"></span><button class="btn btn-sm" data-action="export-villages">匯出里別 CSV</button></div>
    </div>
    <div class="only-building">
    <div class="seg-toggle" role="radiogroup" aria-label="排名方式">
      <button data-rank="score" class="on" role="radio" aria-checked="true">依棟分數</button>
      <button data-rank="impact" role="radio" aria-checked="false">依影響戶數</button>
    </div>
    <p class="hint" id="rank-hint"></p>
    <div class="row">
      <label class="field inline">前 <input id="top-n" type="number" min="10" max="2000" step="10" value="${st.topN}"> 棟</label>
      <button class="btn btn-sm" data-action="export">匯出 CSV</button>
    </div>
    </div>
    <div class="table-wrap lb-wrap"><table class="lb" id="lb"></table></div>
  </section>`;
}

/** 公式與目前數值 */
export function renderFormula(st) {
  const p = st.params;
  const share = (obj, keys) => {
    const W = keys.reduce((s, k) => s + Number(obj[k]), 0);
    return keys.map((k) => `${W > 0 ? Math.round((obj[k] / W) * 100) : 0}% ${LABELS[k]}`).join(' + ');
  };
  return `
    <div class="f-main">優先分數 = 100 × [(1−β)·V′·(1+α·H)/(1+α) + β·S]</div>
    <div class="f-num">= 100 × [${fmt(1 - p.beta, 2)}·V′·(1+${fmt(p.alpha, 2)}·H)/${fmt(1 + p.alpha, 2)} + ${fmt(p.beta, 2)}·S]</div>
    <div class="f-def">V = ${esc(share(p.vulnerability, V_KEYS))}；V′ = 有海砂屋列管時取 max(V, 覆寫值)</div>
    <div class="f-def">H = ${esc(share(p.hazard, H_KEYS))}</div>
    <div class="f-def">S = ${esc(share(p.social, S_KEYS))}</div>`;
}

/** 圖例：連續色階＋三個分級門檻 */
export function renderLegend(st) {
  const [lo, hi] = st.domain;
  const pos = (v) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo || 1)) * 100)).toFixed(1)}%`;
  const th = st.stats.thresholds;
  const ticks = [th.mid, th.high, th.very_high].map((v) => `<span class="tick" style="left:${pos(v)}"></span>`).join('');
  const labels = [['中', th.mid, 2], ['高', th.high, 1], ['極高', th.very_high, 0]]
    .map(([l, v, t]) => `<span><b class="${TIER_CLASS[t]}">${l}</b> ≥ ${fmt(v, 1)}</span>`).join('');
  return `
    <div class="ramp" style="background:${rampCss()}">${ticks}</div>
    <div class="ramp-ends"><span>${fmt(lo, 1)}</span><span>${fmt(hi, 1)}</span></div>
    <div class="thresholds">分級門檻（直線位置）：${labels}</div>
    <p class="hint">色階取全市第 2–99.5 百分位；分級依目前權重下的全市百分位：前 5% 極高、5–15% 高、15–40% 中、其餘低。</p>`;
}

/** 排行榜表格 */
export function renderLeaderboard(st, addrOf) {
  const impact = st.rankMode === 'impact';
  const head = `<thead><tr><th>#</th><th>地址</th><th>分數</th><th>分級</th><th>戶數</th>${impact ? '<th>影響戶數</th>' : ''}</tr></thead>`;
  const rows = Array.from(st.list, (i, j) => {
    const s = st.scores[i];
    const t = tierIndex(s, st.stats.thresholds);
    return `<tr data-i="${i}" class="${st.selected === i ? 'sel' : ''}">
      <td>${j + 1}</td><td class="a">${esc(addrOf(i))}</td><td>${fmt(s, 1)}</td>
      <td><span class="tier-pill sm ${TIER_CLASS[t]}">${TIERS[t].label}</span></td>
      <td>${fmtInt(st.data.cols.n_units[i])}</td>${impact ? `<td>${fmt(st.impact[i], 1)}</td>` : ''}</tr>`;
  }).join('');
  return `${head}<tbody>${rows}</tbody>`;
}

/**
 * CSV 儲存格：字串型且以 = + - @ Tab CR 開頭者前面加「'」，防止 Excel 公式注入；數字型不動。
 */
export const csvCell = (v) => {
  let s = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 數字欄：固定小數位但保持 number 型別（不經公式注入處理） */
const num = (v, d) => Number(v.toFixed(d));

/** 二維陣列 → CSV 下載（UTF-8 BOM，Excel 開中文不亂碼） */
export function downloadCsv(filename, rows) {
  downloadText(filename, `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
}

/**
 * 匯出建物 CSV（UTF-8 BOM，Excel 開中文不亂碼）。
 * 預設為排行榜前 N 棟；opts = {list, filename} 時改匯出指定建物（例如某里全部建物）。
 */
export function exportCsv(st, addrOf, opts = {}) {
  const { data } = st;
  const c = data.cols;
  const book = data.meta.codebooks;
  const header = ['排名', '建物編號', '行政區', '地址', '分數', '分級', '戶數', '影響戶數', '完成年', '結構', '結構來源',
    ...CONTRIB_KEYS.map((k) => `貢獻分_${LABELS[k]}`), '經度', '緯度'];
  const lines = [header.map(csvCell).join(',')];
  const list = opts.list ?? st.list;
  Array.from(list).forEach((i, j) => {
    const x = explainScore(data, i, st.params);
    const r = roundPreservingSum(CONTRIB_KEYS.map((k) => x.contributions[k]), 2);
    const t = tierIndex(st.scores[i], st.stats.thresholds);
    lines.push([
      j + 1, i, book.district[c.district[i]] ?? '', addrOf(i), num(r.total, 2), TIERS[t].label, c.n_units[i],
      num((x.score / 100) * c.n_units[i], 2), c.completion_year[i] || '未知',
      book.structure_final[c.structure_final[i]] ?? '', book.structure_final_source[c.structure_final_source[i]] ?? '',
      ...r.parts.map((v) => num(v, 2)), num(c.lon[i], 6), num(c.lat[i], 6),
    ].map(csvCell).join(','));
  });
  const mode = st.rankMode === 'impact' ? '依影響戶數' : '依棟分數';
  const dist = st.district ? `_${book.district[st.district]}` : '';
  downloadText(opts.filename ?? `危老耐震優先健檢清單_前${list.length}棟_${mode}${dist}.csv`, `﻿${lines.join('\r\n')}\r\n`);
}

export function rankHint(st) {
  return st.rankMode === 'impact'
    ? '影響戶數 = 分數 ÷ 100 × 戶數：健檢一棟能保護最多住戶的順序（不混進分數）。'
    : '依每棟優先分數排序：哪一棟本身最危險。';
}
