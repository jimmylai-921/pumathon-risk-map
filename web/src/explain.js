// 可解釋性面板（A 地圖說明面板與 B 健檢卡共用）：
// 每個因子：原始資料值 → 計分規則與因子分數 → 權重 → 貢獻分；貢獻分加總 = 總分。
import {
  explainScore, rankOf, tierIndex, TIERS, LABELS, CONTRIB_KEYS, V_KEYS, H_KEYS, S_KEYS,
  roundPreservingSum, hasFlag, codeLabel, typologyClass, isCustomParams, formatTopPct,
} from './model.js';
import { esc, fmt, fmtInt } from './util.js';

export const DISCLAIMER = '本分數依公開資料與模型推估產生，不是結構安全鑑定。';

export const FACTOR_COLORS = {
  era: '#08306b', structure: '#2171b5', typology: '#6baed6', soft_story: '#9ecae1',
  seasand: '#6a3d9a',
  liquefaction: '#d94801', fault: '#fdae6b',
  elderly: '#006d2c', fire_access: '#74c476',
};

export const TIER_CLASS = ['tier-0', 'tier-1', 'tier-2', 'tier-3'];

/**
 * 整理單棟建物的原始資料（給說明面板與健檢卡共用）。
 * shard 為該棟所在區的門牌分片（可為 null：地址、使照號碼、海砂屋案號會顯示為未載入）。
 */
export function buildingInfo(data, i, shard) {
  const c = data.cols;
  const meta = data.meta;
  const year = c.completion_year[i] || null;
  const floors = c.floor_count[i] || null;
  const vIdx = c.village[i];
  const village = vIdx !== 65535 ? meta.villages[vIdx] : null;
  const main = shard?.main?.[i] || null;
  return {
    index: i,
    district: codeLabel(data, 'district', i),
    districtCode: c.district[i],
    address: main ? main[0] : null,
    licenseNo: main ? main[1] || null : null,
    seasandCase: main ? main[2] || null : null,
    shardLoaded: !!shard,
    lon: c.lon[i],
    lat: c.lat[i],
    year,
    yearUnknown: hasFlag(data, i, 'year_unknown') || !year,
    era: codeLabel(data, 'code_era', i),
    structure: codeLabel(data, 'structure_final', i),
    structureSource: codeLabel(data, 'structure_final_source', i),
    confidence: c.structure_confidence_pct[i],
    pMasonry: c.p_masonry_pct[i],
    floors,
    elevator: codeLabel(data, 'lvr_elevator', i),
    lvrType: codeLabel(data, 'lvr_building_type', i),
    arcade: hasFlag(data, i, 'arcade'),
    shop: hasFlag(data, i, 'shop'),
    liq: codeLabel(data, 'liq_level', i),
    faultDist: c.fault_dist_m[i],
    seasandClass: codeLabel(data, 'seasand_class', i),
    village,
    inFireLane: hasFlag(data, i, 'in_fire_lane_list'),
    villageFireLane: hasFlag(data, i, 'village_has_fire_lane'),
    fireLaneName: codeLabel(data, 'fire_lane_name', i),
    districtMismatch: hasFlag(data, i, 'district_mismatch'),
    units: c.n_units[i],
  };
}

export function addressText(info) {
  if (info.address) return `臺北市${info.district ?? ''}${info.address}`;
  if (!info.shardLoaded) return `${info.district ?? ''}（地址載入中…）`;
  return `${info.district ?? ''}（無門牌資料，建物 #${info.index}）`;
}

const faultText = (d) => (d >= 65535 ? '≥ 65,535 m' : `${fmtInt(d)} m`);

/** 各因子的「原始資料值」與「計分規則」文字 */
function factorRows(info, x, cfg, nVillages) {
  const vc = cfg.vulnerability, hc = cfg.hazard, sc = cfg.social;
  const typ = typologyClass(info.floors, info.elevator);
  const elev = info.elevator === '有' ? '實價登錄：有電梯' : info.elevator === '無' ? '實價登錄：無電梯' : '無電梯資料';
  const softRaw = [info.arcade && '有騎樓', info.shop && `實價登錄型態：${info.lvrType}`].filter(Boolean);
  const inferred = info.structureSource === '推估';
  const village = info.village;
  const fa = sc.fire_access_scores;
  return {
    era: {
      raw: info.yearUnknown ? '屋齡未知（地籍缺完成年）' : `完成年 ${info.year}`,
      rule: info.yearUnknown
        ? `比照 1974 前計分 → ${vc.era_scores['未知']}`
        : `${info.era} → ${vc.era_scores[info.era]}`,
    },
    structure: {
      raw: info.structure
        ? `${info.structure}（來源：${info.structureSource ?? '未知'}${inferred ? `，信心 ${info.confidence}%，磚造類機率 ${info.pMasonry}%` : ''}）`
        : '結構未知',
      rule: inferred
        ? '推估者以各結構類別機率加權的期望分數'
        : `${info.structure} → ${vc.structure_scores[info.structure] ?? '—'}`,
    },
    typology: {
      raw: `${info.floors ? `${info.floors} 樓` : '樓層未知'}、${elev}`,
      rule: `${typ.replace('_', '、')} → ${vc.typology_scores[typ]}`,
    },
    soft_story: {
      raw: softRaw.length ? softRaw.join('、') : '無騎樓或店面紀錄',
      rule: `騎樓或店面 → ${vc.soft_story_scores['騎樓或店面']}；無 → ${vc.soft_story_scores['無']}`,
    },
    seasand: {
      raw: info.seasandClass
        ? `海砂屋列管${info.seasandCase ? `第 ${info.seasandCase} 案` : ''}：${info.seasandClass}`
        : '未列管',
      rule: info.seasandClass
        ? `建物本體取 max(V ${fmt(x.V, 3)}, 覆寫 ${vc.seasand_override[info.seasandClass]}) = ${fmt(x.Vp, 3)}`
        : '未列管，不覆寫',
    },
    liquefaction: {
      raw: `液化潛勢：${info.liq ?? '圖層外'}`,
      rule: `${info.liq ?? '圖層外'} → ${hc.liquefaction_scores[info.liq ?? '圖層外']}`,
    },
    fault: {
      raw: `距山腳斷層 ${faultText(info.faultDist)}`,
      rule: `1 − 距離 ÷ ${fmtInt(hc.fault_zero_distance_m)} m（${hc.fault_zero_distance_m / 1000} km 外為 0）`,
    },
    elderly: {
      raw: village
        ? `${village.name} 65+ 占 ${(village.elderly_ratio * 100).toFixed(1)}%（全市第 ${Math.round(village.elderly_pct * 100)} 百分位）`
        : '無所屬里資料（以 0.5 計）',
      rule: `全市 ${nVillages} 里 65+ 比例的百分位數（同里同分）`,
    },
    fire_access: {
      raw: info.inFireLane
        ? `列管巷道：${info.fireLaneName ?? '（名稱未知）'}`
        : info.villageFireLane ? '所在里有列管巷道（本棟不在列管巷道上）' : '所在里無列管巷道',
      rule: `列管巷道 → ${fa['列管巷道']}；所在里有列管 → ${fa['所在里有列管']}；無 → ${fa['無']}`,
    },
  };
}

/** 權重欄文字 */
function weightText(key, x, params) {
  const pctTxt = (w) => `${Math.round(w * 100)}%`;
  if (key === 'seasand') return '覆寫（取較大值）';
  if (V_KEYS.includes(key)) return `${fmt(params.vulnerability[key], 2)}（脆弱度內 ${pctTxt(x.normWeight[key])}）`;
  if (H_KEYS.includes(key)) return `${fmt(params.hazard[key], 2)}（危害內 ${pctTxt(x.normWeight[key])}）× α ${fmt(x.alpha, 2)} × V'`;
  if (S_KEYS.includes(key)) return `${fmt(params.social[key], 2)}（社會內 ${pctTxt(x.normWeight[key])}）× β ${fmt(x.beta, 2)}`;
  return '';
}

/** 自訂權重提示（現場 Demo 時滑桿可能已被拉過） */
export function customNotice() {
  return `<div class="custom-note" role="status">
    <span>目前使用自訂權重，分數與預設不同。</span>
    <button class="btn btn-sm" data-action="reset-weights">回復預設權重</button>
  </div>`;
}

/** 警示標記 */
export function warningsHtml(info) {
  const w = [];
  if (info.structureSource === '推估') w.push(`結構為模型推估（信心 ${info.confidence}%，磚造類機率 ${info.pMasonry}%）`);
  if (info.yearUnknown) w.push('屋齡未知：地籍缺完成年，依推估比照 1974 前計分');
  if (info.districtMismatch) w.push('座標所在行政區與地址行政區不符，位置可能有誤');
  if (!w.length) return '';
  return `<ul class="warnings">${w.map((t) => `<li><span class="badge badge-est">注意</span>${esc(t)}</li>`).join('')}</ul>`;
}

/**
 * 可解釋性面板 HTML。
 * @param {object} st app 狀態（data, params, scores, stats）
 * @param {number} i 建物索引
 * @param {object} shard 該棟所在區分片（可為 null）
 */
export function renderExplain(st, i, shard) {
  const { data, params, stats } = st;
  const cfg = data.meta.config;
  const x = explainScore(data, i, params);
  const info = buildingInfo(data, i, shard);
  const rows = factorRows(info, x, cfg, data.meta.villages.length);
  const vals = CONTRIB_KEYS.map((k) => x.contributions[k]);
  const r = roundPreservingSum(vals, 2);
  const tier = tierIndex(st.scores[i], stats.thresholds);
  const { rank, topPct } = rankOf(st.scores[i], stats);

  const bar = CONTRIB_KEYS.map((k, j) => (vals[j] > 0
    ? `<span class="seg" style="width:${(vals[j]).toFixed(3)}%;background:${FACTOR_COLORS[k]}" title="${esc(LABELS[k])} ${fmt(r.parts[j])}"></span>`
    : '')).join('');
  const legend = CONTRIB_KEYS.filter((k, j) => vals[j] > 0)
    .map((k) => `<span class="lg"><i style="background:${FACTOR_COLORS[k]}"></i>${esc(LABELS[k])}</span>`).join('');

  const groupHead = (title, note) => `<tr class="grp"><th colspan="5">${esc(title)}<small>${esc(note)}</small></th></tr>`;
  const row = (k) => {
    const j = CONTRIB_KEYS.indexOf(k);
    const s = k === 'seasand' ? (x.factors.seasand ?? null) : x.factors[k];
    return `<tr>
      <td class="f"><i style="background:${FACTOR_COLORS[k]}"></i>${esc(LABELS[k])}</td>
      <td class="raw" data-label="原始資料">${esc(rows[k].raw)}</td>
      <td class="rule" data-label="計分規則">${esc(rows[k].rule)}<div class="fs">因子分數 <b>${s == null ? '—' : fmt(s, 3)}</b></div></td>
      <td class="w" data-label="權重">${esc(weightText(k, x, params))}</td>
      <td class="c" data-label="貢獻分">${fmt(r.parts[j])}</td>
    </tr>`;
  };

  return `
  <div class="explain">
    <div class="score-head">
      <div class="big ${TIER_CLASS[tier]}">${fmt(r.total)}</div>
      <div>
        <div class="tier-pill ${TIER_CLASS[tier]}">${esc(TIERS[tier].label)}風險</div>
        <div class="rank">全市第 ${fmtInt(rank)} 名／${fmtInt(stats.n)} 棟（前 ${formatTopPct(topPct)}）</div>
      </div>
    </div>
    ${st.defaults && isCustomParams(params, st.defaults) ? customNotice() : ''}
    ${warningsHtml(info)}
    <div class="stack" role="img" aria-label="各因子貢獻分疊加長條圖">${bar}</div>
    <div class="stack-scale"><span>0</span><span>50</span><span>100</span></div>
    <div class="stack-legend">${legend}</div>
    <p class="mult">
      耐震風險 = 建物本體 V′ <b>${fmt(x.Vp, 3)}</b> × 場址加成 (1+αH) <b>${fmt(x.siteMultiplier, 3)}</b>
      ÷ (1+α) ${fmt(1 + x.alpha, 2)} = <b>${fmt(x.seismic, 3)}</b>（危害是乘數：放大建物本體的脆弱度）<br>
      總分 = 100 × [(1−β) ${fmt(1 - x.beta, 2)} × 耐震風險 ${fmt(x.seismic, 3)} + β ${fmt(x.beta, 2)} × 救災社會 S ${fmt(x.S, 3)}] = <b>${fmt(r.total)}</b>
    </p>
    <div class="table-wrap">
    <table class="factors">
      <thead><tr><th>因子</th><th>原始資料值</th><th>計分規則 → 因子分數</th><th>權重</th><th>貢獻分</th></tr></thead>
      <tbody>
        ${groupHead('建物本體（脆弱度 V）', `V = ${fmt(x.V, 3)}；貢獻 = k × 權重占比 × 因子分數，k = 100(1−β)/(1+α) = ${fmt(x.k, 3)}`)}
        ${V_KEYS.map(row).join('')}
        ${row('seasand')}
        ${groupHead('場址危害（H，乘數加成）', `H = ${fmt(x.H, 3)}；貢獻 = k × V′ × α × 權重占比 × 因子分數`)}
        ${H_KEYS.map(row).join('')}
        ${groupHead('救災社會（S）', `S = ${fmt(x.S, 3)}；貢獻 = 100β × 權重占比 × 因子分數`)}
        ${S_KEYS.map(row).join('')}
      </tbody>
      <tfoot><tr><td class="f" colspan="4">貢獻分加總（＝總分）</td><td class="c"><b>${fmt(r.parts.reduce((a, b) => a + b, 0))}</b></td></tr></tfoot>
    </table>
    </div>
    <p class="note">貢獻分以最大餘數法四捨五入到小數兩位，使各列加總恰等於總分。分級依目前權重下的全市百分位：前 5% 極高、5–15% 高、15–40% 中、其餘低。</p>
    <p class="disclaimer">${esc(DISCLAIMER)}</p>
  </div>`;
}

/** 資料來源清單（真實／模型推估） */
export function renderSources(meta) {
  return `<ul class="sources">${meta.sources.map((s) => `<li>
    <span class="badge ${s.kind === '真實' ? 'badge-real' : 'badge-est'}">${esc(s.kind)}</span>
    ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name)}
  </li>`).join('')}</ul>`;
}
