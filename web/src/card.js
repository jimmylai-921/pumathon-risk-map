// B｜「我家安全嗎？」健檢卡：地址查詢 → 健檢卡（基本資料、可解釋性面板、下一步）。
import { normalizeAddress, suggestNearby, extractRoad, zhiVariant } from './addr.js';
import { tierIndex, TIERS } from './model.js';
import { buildingInfo, renderExplain, renderSources, addressText, TIER_CLASS } from './explain.js';
import { esc, fmt, fmtInt } from './util.js';

/**
 * 決定要載入哪些分片：有寫區 → 該區；沒寫區 → 依 roads.json 路段索引只載相關分片；路段不在索引才載入全部。
 * @returns {{codes:number[], via:'district'|'roads'|'all', road:string|null}|{error:string}}
 */
export function shardPlan(meta, roads, norm) {
  const book = meta.codebooks.district;
  if (norm.district) {
    const code = book.indexOf(norm.district);
    if (code <= 0) return { error: `「${norm.district}」不在臺北市 12 個行政區的資料範圍內。` };
    return { codes: [code], via: 'district', road: null };
  }
  const road = extractRoad(norm.street);
  const listed = road && roads ? roads[road] : null;
  if (listed?.length) return { codes: listed.filter((c) => meta.addr_shards[c]), via: 'roads', road };
  return { codes: Object.keys(meta.addr_shards).map(Number), via: 'all', road };
}

/**
 * 查地址：回傳 {status:'found', index, district, street, note} | {status:'multi', matches} |
 * {status:'notfound', suggestions} | {status:'invalid'|'outside', message}
 * 「1號之2」先試 1-2號（等同 1之2號），查不到才退回 1號並在 note 說明。
 */
export async function lookupAddress(st, q, onProgress) {
  const norm = normalizeAddress(q);
  if (!norm.street) {
    return { status: 'invalid', norm, message: '看不出門牌號碼，請輸入到「號」，例如：臺北市中山區民生東路二段32號。' };
  }
  const book = st.data.meta.codebooks.district;
  const roads = await st.roads.catch(() => null);
  const plan = shardPlan(st.data.meta, roads, norm);
  if (plan.error) return { status: 'outside', norm, message: plan.error };
  let done = 0;
  const shards = await Promise.all(plan.codes.map((c) => st.shards.load(c).then((s) => {
    done++;
    onProgress?.(done, plan.codes.length, book[c]);
    return [c, s];
  })));
  const find = (street) => {
    const out = [];
    for (const [c, s] of shards) {
      const idx = s?.alias?.[street];
      if (idx != null) out.push({ index: idx, district: book[c], street });
    }
    return out;
  };
  const zhi = zhiVariant(norm);
  let matches = zhi ? find(zhi.street) : [];
  let note = null;
  if (!matches.length) {
    matches = find(norm.street);
    if (zhi && matches.length) {
      note = `找不到「${zhi.suffix}」（${zhi.street}），以下為 ${norm.street.replace(/^.*?(\d+號)$/, '$1')} 的結果。`;
    }
  }
  if (matches.length === 1) return { status: 'found', norm, plan, note, ...matches[0] };
  if (matches.length > 1) return { status: 'multi', norm, plan, note, matches };
  // 查不到：同一路段（同路名＋巷）最接近的門牌
  const cands = [];
  for (const [c, s] of shards) {
    for (const k of suggestNearby(norm.street, Object.keys(s?.alias || {}), 5)) cands.push({ district: book[c], street: k });
  }
  // 跨區時各區各取 5 筆，再依同一套距離規則合併排序
  const ranked = suggestNearby(norm.street, new Set(cands.map((x) => x.street)), 5);
  const suggestions = ranked.flatMap((k) => cands.filter((x) => x.street === k)).slice(0, 5);
  return { status: 'notfound', norm, plan, suggestions, zhi };
}

/** 「下一步」：依條件顯示固定文字（不加補助金額、比例或額外法條細節） */
export function nextSteps(info) {
  const items = [];
  items.push('可向臺北市建築管理工程處申請私有建築物耐震能力初步評估與費用補助，由建築師公會、土木技師公會、結構技師公會等評估機構執行，通常需區分所有權人過半數同意；初評結果分為甲級（尚無疑慮）、乙級（尚有疑慮）、未達乙級（瀕危）。實際資格與補助內容以建管處最新公告為準。');
  if (info.yearUnknown || (info.year && info.year <= 1996)) {
    let t = '屋齡已滿（或可能已滿）30 年。依《都市危險及老舊建築物加速重建條例》，屋齡 30 年以上、經耐震能力評估未達一定標準，且改善不具效益或未設置昇降設備者，可能符合申請重建條件；屋齡以使用執照日起算，本站以地籍登記完成日估算。';
    if (info.floors >= 4 && info.floors <= 7 && info.elevator !== '有') t += '此建物可能未設昇降設備。';
    items.push(t);
  }
  if (info.seasandClass === '須拆除重建') {
    items.push('本建物已列管為高氯離子混凝土建築物（須拆除重建），屬主管機關命令拆除之情形，請洽臺北市建築管理工程處了解重建相關規定。');
  } else if (info.seasandClass === '可加勁補強') {
    items.push('本建物已列管為高氯離子混凝土建築物（可加勁補強），請洽臺北市建築管理工程處了解補強相關規定。');
  }
  items.push('以上僅供參考，是否符合資格須經專業評估與主管機關認定。');
  return items;
}

const badge = (real) => `<span class="badge ${real ? 'badge-real' : 'badge-est'}">${real ? '真實' : '推估'}</span>`;

/** 健檢卡 HTML */
export function renderCard(st, i, shard) {
  const { data, stats } = st;
  const info = buildingInfo(data, i, shard);
  const cfg = data.meta.config;
  const score = st.scores[i];
  const tier = tierIndex(score, stats.thresholds);
  const inferred = info.structureSource === '推估';
  const v = info.village;
  const fact = (label, value, real, extra = '') => `
    <div class="fact"><dt>${esc(label)} ${badge(real)}</dt><dd>${value}${extra ? `<div class="sub">${extra}</div>` : ''}</dd></div>`;

  const eraVal = info.yearUnknown
    ? '屋齡未知（地籍缺完成年）'
    : `${esc(info.era)}<div class="sub">完成年 ${info.year}（約 ${new Date().getFullYear() - info.year} 年）</div>`;
  const structVal = info.structure
    ? `${esc(info.structure)}`
    : '未知';
  const structExtra = inferred
    ? `模型推估：信心 ${info.confidence}%，磚造類機率 ${info.pMasonry}%`
    : `來源：${esc(info.structureSource ?? '未知')}${info.licenseNo ? `（使照 ${esc(info.licenseNo)}）` : ''}`;
  const fireVal = info.inFireLane
    ? `位於消防通道列管巷道：${esc(info.fireLaneName ?? '（名稱未知）')}`
    : info.villageFireLane ? '所在里有消防通道列管巷道（本棟不在列管巷道上）' : '所在里無列管巷道';
  const faultVal = info.faultDist >= 65535 ? '≥ 65 km' : `${fmtInt(info.faultDist)} m`;
  const faultExtra = info.faultDist < cfg.hazard.fault_zero_distance_m ? `在 ${cfg.hazard.fault_zero_distance_m / 1000} km 計分範圍內` : `超過 ${cfg.hazard.fault_zero_distance_m / 1000} km，不加分`;

  return `
  <article class="card">
    <header class="card-head">
      <div>
        <div class="addr">${esc(addressText(info))}</div>
        <div class="muted">建物 #${i}${info.units ? `・約 ${fmtInt(info.units)} 戶` : ''}</div>
      </div>
      <div class="card-score">
        <div class="big ${TIER_CLASS[tier]}">${fmt(score, 1)}</div>
        <div class="tier-pill ${TIER_CLASS[tier]}">${esc(TIERS[tier].label)}風險</div>
      </div>
    </header>
    <div class="card-actions">
      <a class="btn" href="#/map?b=${i}">在地圖上看</a>
      <button class="btn btn-ghost" data-action="share">複製分享連結</button>
    </div>
    <dl class="facts">
      ${fact('耐震法規時期', eraVal, !info.yearUnknown, info.yearUnknown ? '計分時比照 1974 前（無耐震設計規定）' : '')}
      ${fact('結構', structVal, !inferred, structExtra)}
      ${fact('樓層', info.floors ? `${info.floors} 樓` : '未知', true, info.elevator ? `實價登錄：${info.elevator}電梯` : '無電梯資料')}
      ${fact('土壤液化潛勢', esc(info.liq ?? '不在潛勢圖範圍'), true)}
      ${fact('距山腳斷層', faultVal, true, faultExtra)}
      ${fact('巷弄救災可及性', fireVal, true)}
      ${fact('所在里高齡比例', v ? `${esc(v.name)} 65 歲以上占 ${(v.elderly_ratio * 100).toFixed(1)}%` : '無所屬里資料', true, v ? `全市第 ${Math.round(v.elderly_pct * 100)} 百分位` : '')}
      ${info.seasandClass ? fact('海砂屋列管', `${info.seasandCase ? `第 ${info.seasandCase} 案：` : ''}${esc(info.seasandClass)}`, true) : ''}
    </dl>
    <h3>分數怎麼算出來的</h3>
    ${renderExplain(st, i, shard)}
    <h3>下一步</h3>
    <ol class="next">${nextSteps(info).map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
    <details class="src"><summary>資料來源（真實／模型推估）</summary>${renderSources(data.meta)}</details>
  </article>`;
}
