// 共用小工具（UI 用）

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML 跳脫：所有資料字串進 innerHTML 前都要經過這裡 */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
export const fmtInt = (v) => Number(v).toLocaleString('zh-TW');
export const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;

/** 解析 hash 路由：#/check?q=... → {route:'check', query: URLSearchParams} */
export function parseHash(hash = location.hash) {
  const h = hash.replace(/^#\/?/, '');
  const [path, qs = ''] = h.split('?');
  return { route: path || 'map', query: new URLSearchParams(qs) };
}

export function setHash(route, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, v);
  const s = qs.toString();
  const next = `#/${route}${s ? `?${s}` : ''}`;
  if (location.hash !== next) location.hash = next;
}

/** 觸發瀏覽器下載文字檔 */
export function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * 嚴格解析建物索引：字串必須全為數字（/^\d+$/）且 0 <= n < count，否則回傳 null。
 * 避免 b=1.5、b=NaN、b=、b=%20 等被 Number() 轉成小數、NaN 或 0。
 */
export function parseIndex(raw, count) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 && n < count ? n : null;
}
