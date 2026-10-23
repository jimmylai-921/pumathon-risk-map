// 色階與繪圖陣列（純函式、無 DOM）：分數 → 顏色 typed array，並依顏色分箱排序讓高分點畫在上層。

// 順序色階（ColorBrewer YlOrRd，色盲友善的單向順序色階）：淺黃＝低分，深紅＝高分
export const RAMP = [
  [255, 241, 168], [254, 217, 118], [254, 178, 76], [253, 141, 60],
  [252, 78, 42], [227, 26, 28], [189, 0, 38], [128, 0, 38],
];

/** t ∈ [0,1] → [r,g,b] */
export function rampColor(t) {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f].map(Math.round);
}

/** CSS linear-gradient 字串（圖例用） */
export function rampCss() {
  return `linear-gradient(90deg, ${RAMP.map((c, i) => `rgb(${c.join(',')}) ${(i / (RAMP.length - 1)) * 100}%`).join(', ')})`;
}

/** 色階值域：取全市第 2 與第 99.5 百分位，避免少數極端值壓扁色階 */
export function colorDomain(stats) {
  return [stats.quantile(0.02), stats.quantile(0.995)];
}

const BINS = 64;
const LUT = (() => {
  const lut = new Uint8Array(BINS * 4);
  for (let b = 0; b < BINS; b++) {
    const [r, g, bl] = rampColor(b / (BINS - 1));
    lut.set([r, g, bl, Math.round(150 + (105 * b) / (BINS - 1))], b * 4);
  }
  return lut;
})();

/**
 * 產生 deck.gl binary attributes：位置（lon,lat 交錯）與顏色（RGBA uint8）。
 * 依顏色分箱做計數排序（O(n)），高分點排在後面＝畫在上層；order[k] 為第 k 個點對應的建物索引。
 * @param {object} data decode() 結果
 * @param {Float32Array} scores 全市分數
 * @param {[number,number]} domain 色階值域
 * @param {Uint32Array|null} visible 要顯示的建物索引（篩選後）；null = 全部
 */
export function buildLayerArrays(data, scores, domain, visible) {
  const { lon, lat } = data.cols;
  const m = visible ? visible.length : data.n;
  const [lo, hi] = domain;
  const span = hi > lo ? hi - lo : 1;
  const bin = new Uint8Array(m);
  const count = new Uint32Array(BINS + 1);
  for (let k = 0; k < m; k++) {
    const i = visible ? visible[k] : k;
    let b = Math.floor(((scores[i] - lo) / span) * (BINS - 1) + 0.5);
    b = b < 0 ? 0 : b >= BINS ? BINS - 1 : b;
    bin[k] = b;
    count[b + 1]++;
  }
  for (let b = 1; b <= BINS; b++) count[b] += count[b - 1];
  const order = new Uint32Array(m);
  const positions = new Float32Array(m * 2);
  const colors = new Uint8Array(m * 4);
  for (let k = 0; k < m; k++) {
    const i = visible ? visible[k] : k;
    const b = bin[k];
    const j = count[b]++;
    order[j] = i;
    positions[j * 2] = lon[i];
    positions[j * 2 + 1] = lat[i];
    colors[j * 4] = LUT[b * 4];
    colors[j * 4 + 1] = LUT[b * 4 + 1];
    colors[j * 4 + 2] = LUT[b * 4 + 2];
    colors[j * 4 + 3] = LUT[b * 4 + 3];
  }
  return { order, positions, colors, length: m };
}
