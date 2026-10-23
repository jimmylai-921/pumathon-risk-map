// 進入點：載入資料、管理狀態、路由（#/map、#/check、#/about）。
import './style.css';
import {
  computeScores, defaultParams, rankStats, topN, householdImpact, tierIndex, TIERS,
} from './model.js';
import { buildLayerArrays, colorDomain } from './colors.js';
import { loadBuildings, createShardStore, loadRoads } from './data.js';
import { createMapView, BASEMAP_URL } from './mapview.js';
import { renderExplain, renderSources, buildingInfo, addressText } from './explain.js';
import {
  sidebarHtml, renderFormula, renderLegend, renderLeaderboard, exportCsv, rankHint,
} from './sidebar.js';
import { lookupAddress, renderCard } from './card.js';
import { esc, fmt, fmtInt, parseHash, setHash, parseIndex, $ } from './util.js';

const st = {
  data: null, shards: null, params: null, defaults: null,
  scores: null, stats: null, impact: null, domain: null,
  rankMode: 'score', topN: 100, district: 0, tiers: new Set([0, 1, 2, 3]),
  list: new Uint32Array(0), selected: null, cardIndex: null, mapView: null, view: null,
  roads: null, // Promise<路段索引>
};

// ---------------------------------------------------------------- 載入
const loadingEl = $('#loading');
const setLoading = (msg) => { $('#loading-msg').textContent = msg; };

async function boot() {
  // 路段索引很小，與建物資料並行預載；失敗時查詢會退回載入全部分片
  st.roads = loadRoads();
  st.roads.catch(() => {});
  try {
    st.data = await loadBuildings((p) => setLoading(`載入 ${fmtInt(235964)} 棟建物資料… ${Math.round(p * 100)}%`));
  } catch (e) {
    setLoading(`資料載入失敗：${e.message}`);
    return;
  }
  st.shards = createShardStore(st.data.meta);
  st.defaults = defaultParams(st.data.meta.config);
  st.params = defaultParams(st.data.meta.config);
  st.scores = new Float32Array(st.data.n);

  $('#sidebar').innerHTML = sidebarHtml(st);
  bindSidebar();
  renderAbout();
  st.mapView = createMapView($('#map'), {
    onPick: (i) => selectBuilding(i, { fly: false }),
    tooltip: (i) => {
      const s = st.scores[i];
      return { text: `分數 ${fmt(s, 1)}（${TIERS[tierIndex(s, st.stats.thresholds)].label}）・點擊看說明`, className: 'deck-tip' };
    },
  });
  recompute();
  loadingEl.hidden = true;
  window.addEventListener('hashchange', route);
  route();
}

// ---------------------------------------------------------------- 重算
let pending = false;
function scheduleRecompute() {
  if (pending) return;
  pending = true;
  // 以下一個畫格合併連續的滑桿事件；分頁在背景時 rAF 不會觸發，另以 setTimeout 保底
  const run = () => { if (!pending) return; pending = false; recompute(); };
  requestAnimationFrame(run);
  setTimeout(run, 80);
}

function filterMask() {
  if (!st.district && st.tiers.size === 4) return { visible: null, mask: null };
  const { n, cols } = st.data;
  const th = st.stats.thresholds;
  const mask = new Uint8Array(n);
  const idx = [];
  for (let i = 0; i < n; i++) {
    if (st.district && cols.district[i] !== st.district) continue;
    if (st.tiers.size < 4 && !st.tiers.has(tierIndex(st.scores[i], th))) continue;
    mask[i] = 1;
    idx.push(i);
  }
  return { visible: Uint32Array.from(idx), mask };
}

function recompute() {
  const t0 = performance.now();
  computeScores(st.data, st.params, st.scores);
  st.stats = rankStats(st.scores);
  st.domain = colorDomain(st.stats);
  const { visible, mask } = filterMask();
  if (st.rankMode === 'impact') {
    st.impact = householdImpact(st.scores, st.data.cols.n_units, st.impact);
    st.list = topN(st.impact, st.topN, mask);
  } else {
    st.list = topN(st.scores, st.topN, mask, mask ? null : st.stats.sorted);
  }
  const arrays = buildLayerArrays(st.data, st.scores, st.domain, visible);
  st.mapView.setArrays(arrays);
  const ms = performance.now() - t0;

  $('#perf').textContent = `全市 ${fmtInt(st.data.n)} 棟重算＋排名＋上色：${ms.toFixed(0)} ms（顯示 ${fmtInt(arrays.length)} 棟）`;
  $('#formula').innerHTML = renderFormula(st);
  $('#legend').innerHTML = renderLegend(st);
  $('#rank-hint').textContent = rankHint(st);
  renderLb();
  if (st.selected != null && !$('#drawer').hidden) renderDrawer();
  if (st.view === 'check' && st.cardIndex != null) showCard(st.cardIndex);
}

// ---------------------------------------------------------------- 排行榜（地址依需要載入分片）
function addrOf(i) {
  const shard = st.shards.get(st.data.cols.district[i]);
  return addressText(buildingInfo(st.data, i, shard));
}

let lbToken = 0;
function renderLb() {
  $('#lb').innerHTML = renderLeaderboard(st, addrOf);
  if (st.view !== 'map') return;
  const need = new Set(Array.from(st.list, (i) => st.data.cols.district[i]).filter((c) => c && !st.shards.get(c)));
  if (!need.size) return;
  const token = ++lbToken;
  Promise.all([...need].map((c) => st.shards.load(c).catch(() => null))).then(() => {
    if (token === lbToken) $('#lb').innerHTML = renderLeaderboard(st, addrOf);
  });
}

async function ensureListAddresses() {
  const need = new Set(Array.from(st.list, (i) => st.data.cols.district[i]).filter(Boolean));
  await Promise.all([...need].map((c) => st.shards.load(c).catch(() => null)));
}

// ---------------------------------------------------------------- 側欄事件
function bindSidebar() {
  const sb = $('#sidebar');
  sb.addEventListener('input', (e) => {
    const id = e.target.dataset.w;
    if (!id) return;
    const v = Number(e.target.value);
    if (id === 'alpha' || id === 'beta') st.params[id] = v;
    else { const [g, k] = id.split('.'); st.params[g][k] = v; }
    sb.querySelector(`#o-${CSS.escape(id)}`).textContent = fmt(v, 2);
    scheduleRecompute();
  });
  sb.addEventListener('change', (e) => {
    if (e.target.id === 'f-district') { st.district = Number(e.target.value); scheduleRecompute(); }
    if (e.target.dataset.tier != null) {
      const t = Number(e.target.dataset.tier);
      if (e.target.checked) st.tiers.add(t); else st.tiers.delete(t);
      scheduleRecompute();
    }
    if (e.target.id === 'top-n') {
      st.topN = Math.min(2000, Math.max(1, Math.round(Number(e.target.value) || 100)));
      e.target.value = st.topN;
      scheduleRecompute();
    }
  });
  sb.addEventListener('click', async (e) => {
    const btn = e.target.closest('button, tr[data-i]');
    if (!btn) return;
    if (btn.dataset.action === 'reset') {
      resetWeights();
    } else if (btn.dataset.action === 'export') {
      btn.disabled = true;
      btn.textContent = '準備中…';
      await ensureListAddresses();
      exportCsv(st, addrOf);
      btn.disabled = false;
      btn.textContent = '匯出 CSV';
    } else if (btn.dataset.rank) {
      st.rankMode = btn.dataset.rank;
      sb.querySelectorAll('[data-rank]').forEach((b) => {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-checked', String(b === btn));
      });
      scheduleRecompute();
    } else if (btn.dataset.i != null) {
      selectBuilding(Number(btn.dataset.i), { fly: true });
    }
  });
}

/** 回復 config 預設權重（側欄、說明面板、健檢卡的按鈕共用） */
function resetWeights() {
  st.params = defaultParams(st.data.meta.config);
  const sb = $('#sidebar');
  sb.querySelectorAll('input[data-w]').forEach((el) => {
    const id = el.dataset.w;
    const v = id === 'alpha' || id === 'beta' ? st.params[id] : st.params[id.split('.')[0]][id.split('.')[1]];
    el.value = v;
    sb.querySelector(`#o-${CSS.escape(id)}`).textContent = fmt(v, 2);
  });
  scheduleRecompute();
}

/** 短暫提示（例如連結中的建物編號無效） */
let toastTimer = 0;
function notify(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ---------------------------------------------------------------- A：說明面板
async function selectBuilding(i, { fly }) {
  if (!Number.isSafeInteger(i) || i < 0 || i >= st.data.n) return;
  st.selected = i;
  const { lon, lat } = st.data.cols;
  st.mapView.select([lon[i], lat[i]]);
  if (fly) st.mapView.flyTo(lon[i], lat[i]);
  history.replaceState(null, '', `#/map?b=${i}`);
  $('#lb').querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel'));
  $('#lb').querySelector(`tr[data-i="${i}"]`)?.classList.add('sel');
  $('#drawer').hidden = false;
  renderDrawer();
  await st.shards.load(st.data.cols.district[i]).catch(() => null);
  if (st.selected === i) renderDrawer();
}

function renderDrawer() {
  const i = st.selected;
  const shard = st.shards.get(st.data.cols.district[i]);
  const info = buildingInfo(st.data, i, shard);
  $('#drawer-body').innerHTML = `
    <div class="drawer-title">
      <h2>${esc(addressText(info))}</h2>
      <div class="muted">建物 #${i}・${info.units ? `約 ${fmtInt(info.units)} 戶` : '戶數未知'}</div>
      <div class="card-actions"><a class="btn" href="#/check?b=${i}">開啟健檢卡</a></div>
    </div>
    ${renderExplain(st, i, shard)}`;
}

// ---------------------------------------------------------------- B：健檢卡
async function showCard(i) {
  st.cardIndex = i;
  const code = st.data.cols.district[i];
  let shard = st.shards.get(code);
  if (!shard) {
    $('#card-out').innerHTML = renderCard(st, i, null);
    shard = await st.shards.load(code).catch(() => null);
    if (st.cardIndex !== i) return;
  }
  $('#card-out').innerHTML = renderCard(st, i, shard);
}

let lookupToken = 0;
async function runLookup(q) {
  const token = ++lookupToken;
  $('#addr-input').value = q;
  st.cardIndex = null;
  const status = $('#check-status');
  status.textContent = '查詢中…';
  $('#card-out').innerHTML = '';
  let r;
  try {
    r = await lookupAddress(st, q, (done, total, name) => {
      if (token === lookupToken && total > 1) status.textContent = `未指定行政區，搜尋各區門牌中…（${done}/${total}，${name}）`;
    });
  } catch (e) {
    status.textContent = `查詢失敗：${e.message}`;
    return;
  }
  if (token !== lookupToken) return;
  const pick = (d, s) => `<li><a href="#/check?q=${encodeURIComponent(`${d}${s}`)}">臺北市${esc(d)}${esc(s)}</a></li>`;
  if (r.status === 'found') {
    status.innerHTML = r.note
      ? `<span class="zhi-note">${esc(r.note)}</span><br>找到：臺北市${esc(r.district)}${esc(r.street)}`
      : `找到：臺北市${esc(r.district)}${esc(r.street)}`;
    await showCard(r.index);
  } else if (r.status === 'multi') {
    status.innerHTML = `${r.note ? `<span class="zhi-note">${esc(r.note)}</span><br>` : ''}「${esc(r.matches[0].street)}」在多個行政區都有，請選擇：<ul class="sugg">${r.matches.map((m) => pick(m.district, m.street)).join('')}</ul>`;
  } else if (r.status === 'notfound') {
    status.innerHTML = `${r.zhi ? `找不到「${esc(r.zhi.street)}」（${esc(r.zhi.suffix)}）。` : ''}查無「${esc(r.norm.district ?? '')}${esc(r.norm.street)}」的門牌資料。${r.suggestions.length
      ? `同一路段最接近的門牌：<ul class="sugg">${r.suggestions.map((m) => pick(m.district, m.street)).join('')}</ul>`
      : '同一路段也找不到相近門牌，請確認路名、段、巷是否正確。'}`;
  } else {
    status.textContent = r.message;
  }
}

function bindCheck() {
  $('#check-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#addr-input').value.trim();
    if (!q) return;
    const before = location.hash;
    setHash('check', { q });
    if (location.hash === before) runLookup(q);
  });
  $('#card-out').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action="share"]');
    if (!b) return;
    try {
      await navigator.clipboard.writeText(location.href);
      b.textContent = '已複製連結';
    } catch {
      b.textContent = '請手動複製網址列';
    }
  });
}

// ---------------------------------------------------------------- 資料來源與方法
function renderAbout() {
  const cfg = st.data.meta.config;
  const table = (title, obj, note) => `
    <div class="rule"><h4>${esc(title)}</h4><table class="mini">${Object.entries(obj)
    .map(([k, v]) => `<tr><td>${esc(k.replace('_', '、'))}</td><td>${esc(v)}</td></tr>`).join('')}</table>${note ? `<p class="hint">${esc(note)}</p>` : ''}</div>`;
  $('#about-out').innerHTML = `
    <h2>資料來源</h2>
    <p>每一筆來源都標示是「真實」資料，還是「模型推估」。</p>
    ${renderSources(st.data.meta)}
    <p class="hint">底圖：內政部國土測繪中心 臺灣通用電子地圖（灰階 WMTS：<code>${esc(BASEMAP_URL)}</code>）。資料產生時間：${esc(st.data.meta.generated_at)}。</p>
    <h2>風險公式</h2>
    <p class="formula">${esc(cfg.formula)}</p>
    <p>危害（H）是乘數：同樣的建物本體，蓋在高液化潛勢或靠近斷層的地方，耐震風險會被放大，最多放大到 1+α 倍再除以 1+α 回到 0–1。每棟的貢獻分加總恰等於總分；「影響戶數」只用於排行榜切換，不混進分數。</p>
    <h2>計分規則（config/risk_weights.json）</h2>
    <div class="rules">
      ${table('屋齡法規時期', cfg.vulnerability.era_scores, cfg.vulnerability._era_未知)}
      ${table('結構', cfg.vulnerability.structure_scores, '使照／實價登錄有記載者用該類別分數；其餘由模型推估各類別機率，以期望分數計。')}
      ${table('樓層型態', cfg.vulnerability.typology_scores, cfg.vulnerability._typology)}
      ${table('軟弱底層', cfg.vulnerability.soft_story_scores)}
      ${table('海砂屋列管覆寫', cfg.vulnerability.seasand_override, cfg.vulnerability._seasand)}
      ${table('土壤液化潛勢', cfg.hazard.liquefaction_scores)}
      ${table('山腳斷層', { '0 m': 1, [`${cfg.hazard.fault_zero_distance_m} m 以上`]: 0 }, cfg.hazard._fault)}
      ${table('消防通道', cfg.social.fire_access_scores)}
      ${table('里高齡比例', { 計分: '全市各里 65+ 比例的百分位數' }, cfg.social._elderly)}
    </div>
    <p class="disclaimer">本分數依公開資料與模型推估產生，不是結構安全鑑定。</p>`;
}

// ---------------------------------------------------------------- 路由
function route() {
  const { route: r, query } = parseHash();
  const view = ['map', 'check', 'about'].includes(r) ? r : 'map';
  st.view = view;
  for (const v of ['map', 'check', 'about']) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('on', a.dataset.route === view));
  if (view === 'map') {
    st.mapView.resize();
    renderLb();
    const b = query.get('b');
    if (b != null) {
      const i = parseIndex(b, st.data.n);
      if (i == null) notify(`連結中的建物編號「${b}」無效（須為 0–${st.data.n - 1} 的整數），已忽略。`);
      else if (i !== st.selected) selectBuilding(i, { fly: true });
    }
  } else if (view === 'check') {
    const q = query.get('q');
    const b = query.get('b');
    const bi = b != null ? parseIndex(b, st.data.n) : null;
    if (q) runLookup(q);
    else if (bi != null) {
      $('#check-status').textContent = '';
      showCard(bi);
    } else {
      if (b != null) notify(`連結中的建物編號「${b}」無效（須為 0–${st.data.n - 1} 的整數），已忽略。`);
      st.cardIndex = null;
      $('#card-out').innerHTML = '';
      $('#check-status').textContent = '';
    }
  }
  window.scrollTo(0, 0);
}

// 說明面板與健檢卡內的「回復預設權重」按鈕
for (const sel of ['#drawer-body', '#card-out']) {
  $(sel).addEventListener('click', (e) => {
    if (e.target.closest('[data-action="reset-weights"]')) resetWeights();
  });
}

$('#drawer-close').addEventListener('click', () => {
  $('#drawer').hidden = true;
  st.selected = null;
  st.mapView?.select(null);
  history.replaceState(null, '', '#/map');
});
// 首次開啟提示：只顯示一次；本來就開在健檢卡的連結不打擾
function showWelcome() {
  const KEY = 'welcome-seen';
  try { if (localStorage.getItem(KEY)) return; localStorage.setItem(KEY, '1'); } catch { /* 無痕模式等：照常顯示 */ }
  if (parseHash().route === 'check') return;
  const dlg = $('#welcome');
  dlg.addEventListener('close', () => { if (dlg.returnValue === 'check') location.hash = '#/check'; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
}

bindCheck();
showWelcome();
boot();
