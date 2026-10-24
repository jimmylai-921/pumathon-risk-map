// 資料載入（瀏覽器端）：meta.json、buildings.bin.gz（含下載進度與解壓）、依需要 lazy load 門牌分片。
import { decode } from './model.js';

const BASE = `${import.meta.env.BASE_URL}data/`;

/** 依 meta.columns 算出解壓後 buildings.bin 應有的位元組數 */
function expectedBytes(meta) {
  const size = { float32: 4, uint16: 2, uint8: 1 };
  return Math.max(...meta.columns.map((c) => c.offset + c.length * size[c.dtype]));
}

/**
 * 下載 buildings.bin.gz 並以 DecompressionStream 邊下載邊解壓。
 * Cloudflare 不壓縮 application/octet-stream，所以檔案是預先 gzip 好的（見 scripts/07_export_web.py）。
 * 有些伺服器（如 Vite dev）會對 .gz 加 Content-Encoding: gzip，瀏覽器已先解壓，
 * 因此看開頭是否為 gzip magic（1f 8b）再決定要不要自己解壓。
 */
async function fetchGzipWithProgress(url, gzBytes, total, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗：${url}（HTTP ${res.status}）`);
  const src = res.body.getReader();
  const first = await src.read();
  const gz = !first.done && first.value[0] === 0x1f && first.value[1] === 0x8b;
  // 進度：自己解壓時以壓縮位元組計，伺服器已解壓時以原始大小計
  const denom = gz ? gzBytes : total;
  let got = 0;
  const report = (chunk) => {
    got += chunk.length;
    if (onProgress && denom) onProgress(Math.min(1, got / denom));
  };
  const raw = new ReadableStream({
    start(ctrl) {
      if (first.done) return ctrl.close();
      report(first.value);
      ctrl.enqueue(first.value);
    },
    async pull(ctrl) {
      const { done, value } = await src.read();
      if (done) return ctrl.close();
      report(value);
      ctrl.enqueue(value);
    },
    cancel(reason) { return src.cancel(reason); },
  });
  const reader = (gz ? raw.pipeThrough(new DecompressionStream('gzip')) : raw).getReader();
  const buf = new Uint8Array(total);
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (off + value.length > total) throw new Error(`buildings.bin 大於預期的 ${total} bytes`);
    buf.set(value, off);
    off += value.length;
  }
  if (off !== total) throw new Error(`buildings.bin 大小不符：預期 ${total}，實得 ${off}`);
  return buf.buffer;
}

/** 載入 meta 與建物資料，回傳 decode() 結果 */
export async function loadBuildings(onProgress) {
  const res = await fetch(`${BASE}meta.json`);
  if (!res.ok) throw new Error(`無法載入 meta.json（HTTP ${res.status}）`);
  const meta = await res.json();
  const buf = await fetchGzipWithProgress(`${BASE}buildings.bin.gz`, meta.bin_gz_bytes, expectedBytes(meta), onProgress);
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
