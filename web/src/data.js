// 資料載入（瀏覽器端）：meta.json、buildings.bin（含下載進度）、依需要 lazy load 門牌分片。
import { decode } from './model.js';

const BASE = `${import.meta.env.BASE_URL}data/`;

/** 依 meta.columns 算出 buildings.bin 應有的位元組數（伺服器壓縮時 content-length 不可靠） */
function expectedBytes(meta) {
  const size = { float32: 4, uint16: 2, uint8: 1 };
  return Math.max(...meta.columns.map((c) => c.offset + c.length * size[c.dtype]));
}

async function fetchWithProgress(url, total, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗：${url}（HTTP ${res.status}）`);
  if (!res.body || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > total) throw new Error(`buildings.bin 大於預期的 ${total} bytes`);
    buf.set(value, got);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  if (got !== total) throw new Error(`buildings.bin 大小不符：預期 ${total}，實得 ${got}`);
  return buf.buffer;
}

/** 載入 meta 與建物資料，回傳 decode() 結果 */
export async function loadBuildings(onProgress) {
  const res = await fetch(`${BASE}meta.json`);
  if (!res.ok) throw new Error(`無法載入 meta.json（HTTP ${res.status}）`);
  const meta = await res.json();
  const buf = await fetchWithProgress(`${BASE}buildings.bin`, expectedBytes(meta), onProgress);
  return decode(meta, buf);
}

/** 門牌分片快取：代碼 → Promise<{district, main, alias}> */
export function createShardStore(meta) {
  const cache = new Map();
  const loaded = new Map();
  return {
    /** 載入（或取快取）某區分片 */
    load(code) {
      code = Number(code);
      if (!meta.addr_shards[code]) return Promise.resolve(null);
      if (!cache.has(code)) {
        const p = fetch(`${BASE}${meta.addr_shards[code]}`)
          .then((r) => {
            if (!r.ok) throw new Error(`門牌分片載入失敗（HTTP ${r.status}）`);
            return r.json();
          })
          .then((j) => { loaded.set(code, j); return j; })
          .catch((e) => { cache.delete(code); throw e; });
        cache.set(code, p);
      }
      return cache.get(code);
    },
    /** 已載入的分片（同步取用，未載入回傳 null） */
    get(code) { return loaded.get(Number(code)) || null; },
    codes() { return Object.keys(meta.addr_shards).map(Number); },
  };
}

/** 路段索引 addr/roads.json：{路段: [行政區代碼…]}（約 15 KB，啟動時預載） */
export async function loadRoads() {
  const r = await fetch(`${BASE}addr/roads.json`);
  if (!r.ok) throw new Error(`路段索引載入失敗（HTTP ${r.status}）`);
  return r.json();
}
