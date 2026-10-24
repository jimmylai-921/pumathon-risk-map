// 里別檢視：逐棟分數依所屬里聚合（純函式）＋里面板、里排行榜、里 CSV 的 HTML。
// 聚合跟著目前權重重算，所以滑桿一動，里的平均分數與分級佔比也會一起變。
import { tierIndex, TIERS } from './model.js';
import { rampCss } from './colors.js';
import { TIER_CLASS } from './explain.js';
import { esc, fmt, fmtInt, pct } from './util.js';

const NO_VILLAGE = 65535;

/** 里別上色指標 */
export const V_METRICS = [
  { key: 'mean', label: '平均風險指數', short: '平均分數', fmt: (v) => fmt(v, 1) },
  { key: 'highShare', label: '極高＋高風險建物佔比', short: '極高＋高佔比', fmt: (v) => pct(v, 1) },
  { key: 'elderly', label: '65 歲以上人口比例', short: '65+ 比例', fmt: (v) => pct(v, 1) },
];
export const metricOf = (key) => V_METRICS.find((m) => m.key === key) || V_METRICS[0];

/**
 * 里 → 建物索引（CSR：members[start[v] .. start[v+1]) 為第 v 里的建物），只依資料建立一次。
 * @returns {{nv:number, start:Uint32Array, members:Uint32Array}}
 */
export function buildVillageIndex(data) {
  const nv = data.meta.villages.length;
  const vcol = data.cols.village;
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < data.n; i++) if (vcol[i] !== NO_VILLAGE) start[vcol[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const members = new Uint32Array(start[nv]);
  for (let i = 0; i < data.n; i++) if (vcol[i] !== NO_VILLAGE) members[fill[vcol[i]]++] = i;
  return { nv, start, members };
}

/**
 * 依目前分數聚合各里：棟數、戶數、平均分數（棟平均與戶數加權）、各分級棟數與戶數、缺完成年棟數。
 * tiers / tierUnits 為 nv×4（0 極高、1 高、2 中、3 低）。
 */
export function aggregateVillages(data, vindex, scores, thresholds) {
  const { nv, start, members } = vindex;
  const units = data.cols.n_units;
  const flags = data.cols.flags;
  const yu = data.meta.flag_bits.year_unknown;
  const villages = data.meta.villages;
  const count = new Uint32Array(nv);
  const unitSum = new Uint32Array(nv);
  const mean = new Float32Array(nv);
  const meanW = new Float32Array(nv);
  const tiers = new Uint32Array(nv * 4);
  const tierUnits = new Uint32Array(nv * 4);
  const yearUnknown = new Uint32Array(nv);
  const highShare = new Float32Array(nv);
  const elderly = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    let s = 0, sw = 0, u = 0;
    for (let k = start[v]; k < start[v + 1]; k++) {
      const i = members[k];
      const sc = scores[i];
      const t = tierIndex(sc, thresholds);
      s += sc;
      sw += sc * units[i];
      u += units[i];
      tiers[v * 4 + t]++;
      tierUnits[v * 4 + t] += units[i];
      if (flags[i] & yu) yearUnknown[v]++;
    }
    const c = start[v + 1] - start[v];
    count[v] = c;
    unitSum[v] = u;
    mean[v] = c ? s / c : NaN;
    meanW[v] = u ? sw / u : NaN;
    highShare[v] = c ? (tiers[v * 4] + tiers[v * 4 + 1]) / c : NaN;
    elderly[v] = villages[v].elderly_ratio ?? NaN;
  }
  return { nv, count, units: unitSum, mean, meanW, tiers, tierUnits, yearUnknown, highShare, elderly };
}

/** 依指標遞減排序的里索引（缺值排最後）；district 非 0 時只留該區 */
export function rankVillages(agg, metric, data, district = 0) {
  const vals = agg[metric];
  const book = data.meta.codebooks.district;
  const dname = district ? book[district] : null;
  const idx = [];
  for (let v = 0; v < agg.nv; v++) if (!dname || data.meta.villages[v].district === dname) idx.push(v);
  const key = (v) => (Number.isNaN(vals[v]) ? -Infinity : vals[v]);
  return idx.sort((a, b) => key(b) - key(a) || a - b);
}

/** 全市名次（1 = 最高；同值同名次） */
export function villageRank(agg, metric, v) {
  const vals = agg[metric];
  const x = vals[v];
  if (Number.isNaN(x)) return null;
  let higher = 0, total = 0;
  for (let k = 0; k < agg.nv; k++) {
    if (Number.isNaN(vals[k])) continue;
    total++;
    if (vals[k] > x) higher++;
  }
  return { rank: higher + 1, total };
}

/** 指標色階值域：取各里第 2–98 百分位，避免少數小里（棟數少）壓扁色階 */
export function villageDomain(agg, metric) {
  const vals = Array.from(agg[metric]).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!vals.length) return [0, 1];
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
  return [q(0.02), q(0.98)];
}

/** 里別圖例 */
export function renderVillageLegend(agg, metric) {
  const m = metricOf(metric);
  const [lo, hi] = villageDomain(agg, metric);
  return `
    <div class="ramp" style="background:${rampCss()}"></div>
    <div class="ramp-ends"><span>${m.fmt(lo)}</span><span>${m.fmt(hi)}</span></div>
    <p class="hint">里別上色：<b>${esc(m.label)}</b>。色階取全市各里第 2–98 百分位；點一個里看完整統計。${metric === 'elderly' ? '' : '分數跟著上方權重即時重算。'}</p>`;
}

/** 分級佔比長條（棟數）＋表格（棟數、戶數） */
function tierBreakdown(agg, v) {
  const c = agg.count[v] || 1;
  const seg = TIERS.map((t, j) => {
    const n = agg.tiers[v * 4 + j];
    return n ? `<span class="seg ${TIER_CLASS[j]}-bg" style="width:${((n / c) * 100).toFixed(2)}%" title="${t.label} ${pct(n / c, 1)}"></span>` : '';
  }).join('');
  const rows = TIERS.map((t, j) => {
    const n = agg.tiers[v * 4 + j];
    const u = agg.tierUnits[v * 4 + j];
    return `<tr><td><span class="tier-pill sm ${TIER_CLASS[j]}">${t.label}</span></td>
      <td>${fmtInt(n)} 棟</td><td>${pct(n / c, 1)}</td><td>${fmtInt(u)} 戶</td><td>${pct(agg.units[v] ? u / agg.units[v] : 0, 1)}</td></tr>`;
  }).join('');
  return `
    <div class="stack tiers" role="img" aria-label="各風險分級的建物佔比">${seg}</div>
    <div class="table-wrap"><table class="mini vtiers">
      <thead><tr><th>分級</th><th>棟數</th><th>棟數佔比</th><th>戶數</th><th>戶數佔比</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/**
 * 里面板 HTML。
 * @param {object} st app 狀態（data, vagg, stats）
 * @param {number} v 里索引
 * @param {Uint32Array} top 里內分數最高的建物索引
 * @param {(i:number)=>string} addrOf 建物地址
 */
export function renderVillagePanel(st, v, top, addrOf) {
  const { data, vagg: agg } = st;
  const info = data.meta.villages[v];
  const r = villageRank(agg, 'mean', v);
  const rh = villageRank(agg, 'highShare', v);
  const highUnits = agg.tierUnits[v * 4] + agg.tierUnits[v * 4 + 1];
  const c = agg.count[v];
  const tier = c ? tierIndex(agg.mean[v], st.stats.thresholds) : 3;
  const elderlyN = info.population ? Math.round(info.population * info.elderly_ratio) : null;
  const yu = c ? agg.yearUnknown[v] / c : 0;
  const rows = Array.from(top, (i, j) => {
    const s = st.scores[i];
    const t = tierIndex(s, st.stats.thresholds);
    return `<tr data-i="${i}"><td>${j + 1}</td><td class="a">${esc(addrOf(i))}</td><td>${fmt(s, 1)}</td>
      <td><span class="tier-pill sm ${TIER_CLASS[t]}">${TIERS[t].label}</span></td><td>${fmtInt(data.cols.n_units[i])}</td></tr>`;
  }).join('');
  return `
  <div class="vpanel">
    <div class="drawer-title">
      <h2>${esc(info.district)} ${esc(info.name)}</h2>
      <div class="muted">${fmtInt(c)} 棟建物・約 ${fmtInt(agg.units[v])} 戶・人口 ${info.population ? fmtInt(info.population) : '—'} 人</div>
    </div>
    ${c ? '' : '<p class="hint">本里沒有落在里界內的建物資料。</p>'}
    <div class="facts">
      <div class="fact"><dt>平均風險指數（棟平均）</dt>
        <dd><span class="big-sm ${TIER_CLASS[tier]}">${fmt(agg.mean[v], 1)}</span>
          <div class="sub">全市 ${r ? `${fmtInt(r.total)} 里第 ${r.rank} 名` : '—'}・戶數加權平均 ${fmt(agg.meanW[v], 1)}</div></dd></div>
      <div class="fact"><dt>極高＋高風險建物</dt>
        <dd><span class="big-sm">${pct(agg.highShare[v] || 0, 1)}</span>
          <div class="sub">${fmtInt(agg.tiers[v * 4] + agg.tiers[v * 4 + 1])} 棟、約 ${fmtInt(highUnits)} 戶${rh ? `・全市第 ${rh.rank} 名` : ''}</div></dd></div>
      <div class="fact"><dt>65 歲以上人口比例</dt>
        <dd><span class="big-sm">${pct(info.elderly_ratio, 1)}</span>
          <div class="sub">${elderlyN != null ? `約 ${fmtInt(elderlyN)} 人・` : ''}高於全市 ${Math.round(info.elderly_pct * 100)}% 的里</div></dd></div>
      <div class="fact"><dt>資料提醒</dt>
        <dd><span class="big-sm">${pct(yu, 0)}</span>
          <div class="sub">的建物地籍缺完成年，依假設比照 1974 前計分，可能高估</div></dd></div>
    </div>
    <h3>各風險分級佔比</h3>
    ${tierBreakdown(agg, v)}
    <p class="note">分級依目前權重下的全市逐棟百分位：前 5% 極高、5–15% 高、15–40% 中、其餘低。全市平均約為 ${pct(0.05)}／${pct(0.10)}／${pct(0.25)}／${pct(0.60)}。</p>
    <h3>里內優先健檢前 ${top.length} 棟</h3>
    <div class="card-actions"><button class="btn btn-sm" data-action="export-village" data-v="${v}">匯出本里全部建物 CSV</button></div>
    <div class="table-wrap lb-wrap"><table class="lb" id="vtop">
      <thead><tr><th>#</th><th>地址</th><th>分數</th><th>分級</th><th>戶數</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="disclaimer">本分數依公開資料與模型推估產生，不是結構安全鑑定。里平均是統計概況，個別建物請看逐棟分數。</p>
  </div>`;
}

/** 里排行榜（側欄，依目前上色指標排序） */
export function renderVillageBoard(st, list) {
  const { data, vagg: agg } = st;
  const m = metricOf(st.vMetric);
  const head = `<thead><tr><th>#</th><th>里</th><th>平均分數</th><th>極高＋高</th><th>65+</th></tr></thead>`;
  const rows = list.map((v, j) => {
    const info = data.meta.villages[v];
    return `<tr data-v="${v}" class="${st.selVillage === v ? 'sel' : ''}">
      <td>${j + 1}</td><td class="a">${esc(info.district.replace('區', ''))} ${esc(info.name)}</td>
      <td${m.key === 'mean' ? ' class="k"' : ''}>${fmt(agg.mean[v], 1)}</td>
      <td${m.key === 'highShare' ? ' class="k"' : ''}>${Number.isNaN(agg.highShare[v]) ? '—' : pct(agg.highShare[v], 1)}</td>
      <td${m.key === 'elderly' ? ' class="k"' : ''}>${pct(agg.elderly[v], 1)}</td></tr>`;
  }).join('');
  return `${head}<tbody>${rows}</tbody>`;
}

/** 里排行 CSV 的列（標頭＋資料），由 sidebar 的 csvCell 處理跳脫 */
export function villageCsvRows(st, list) {
  const { data, vagg: agg } = st;
  const header = ['排名', '行政區', '里', '建物棟數', '戶數', '人口', '65歲以上比例', '平均風險指數', '戶數加權平均',
    ...TIERS.flatMap((t) => [`${t.label}_棟數`, `${t.label}_棟數佔比`]), '極高高_戶數', '缺完成年棟數'];
  const r = (x, d) => (Number.isNaN(x) ? '' : Number(x.toFixed(d)));
  const rows = list.map((v, j) => {
    const info = data.meta.villages[v];
    const c = agg.count[v];
    return [j + 1, info.district, info.name, c, agg.units[v], info.population ?? '', r(info.elderly_ratio, 4),
      r(agg.mean[v], 2), r(agg.meanW[v], 2),
      ...TIERS.flatMap((t, k) => [agg.tiers[v * 4 + k], c ? r(agg.tiers[v * 4 + k] / c, 4) : '']),
      agg.tierUnits[v * 4] + agg.tierUnits[v * 4 + 1], agg.yearUnknown[v]];
  });
  return [header, ...rows];
}
