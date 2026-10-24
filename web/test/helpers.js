// 測試共用：在 Node 端讀取 public/data 與 fixtures。
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decode } from '../src/model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'public', 'data');

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

let cached;
/** 讀 meta.json 與 buildings.bin.gz 並解碼（整個測試程序只讀一次） */
export function loadData() {
  if (cached) return cached;
  const meta = readJson(join(DATA_DIR, 'meta.json'));
  const buf = gunzipSync(readFileSync(join(DATA_DIR, 'buildings.bin.gz')));
  // Node Buffer 可能共用較大的 ArrayBuffer，複製成獨立 ArrayBuffer 以符合 offset 對齊
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  cached = decode(meta, ab);
  return cached;
}

export const parity = () => readJson(join(ROOT, 'test', 'fixtures', 'parity.json'));

const shards = new Map();
/** 讀某區的門牌分片 */
export function loadShard(meta, district) {
  const code = meta.codebooks.district.indexOf(district);
  if (code <= 0) return null;
  if (!shards.has(code)) shards.set(code, readJson(join(DATA_DIR, meta.addr_shards[code])));
  return shards.get(code);
}
