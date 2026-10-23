// 地圖：MapLibre（國土測繪中心臺灣通用電子地圖灰階 WMTS）＋ deck.gl ScatterplotLayer（binary attributes）。
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl 6 的 worker 是獨立 ESM 檔，執行期以 import.meta.url 推算路徑；經 Vite 打包後會失效，改由 ?url 匯出資產網址
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';

// 已用 curl 確認 HTTP 200、image/jpeg、單通道灰階（EMAP01 = 臺灣通用電子地圖灰階）；注意路徑是 {z}/{y}/{x}
export const BASEMAP_URL = 'https://wmts.nlsc.gov.tw/wmts/EMAP01/default/GoogleMapsCompatible/{z}/{y}/{x}';

setWorkerUrl(maplibreWorkerUrl);

export function createMapView(container, { onPick, tooltip }) {
  const map = new MapLibreMap({
    container,
    style: {
      version: 8,
      sources: {
        emap: {
          type: 'raster',
          tiles: [BASEMAP_URL],
          tileSize: 256,
          maxzoom: 19,
          attribution: '底圖：<a href="https://maps.nlsc.gov.tw/" target="_blank" rel="noopener">內政部國土測繪中心</a> 臺灣通用電子地圖（灰階）',
        },
      },
      layers: [{ id: 'emap', type: 'raster', source: 'emap' }],
    },
    center: [121.545, 25.07],
    zoom: 11,
    minZoom: 9,
    maxZoom: 19,
    maxBounds: [[120.9, 24.6], [122.2, 25.5]],
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.touchZoomRotate.disableRotation();

  let arrays = null;
  let selected = null;
  const overlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
    getTooltip: (info) => (info.layer?.id === 'buildings' && info.index >= 0 && arrays
      ? tooltip(arrays.order[info.index]) : null),
  });
  map.addControl(overlay);

  function render() {
    const layers = [];
    if (arrays) {
      layers.push(new ScatterplotLayer({
        id: 'buildings',
        // binary attributes：不建立 23 萬個 JS 物件；每次重算給新的 typed array，deck.gl 只重新上傳 buffer
        data: {
          length: arrays.length,
          attributes: {
            getPosition: { value: arrays.positions, size: 2 },
            getFillColor: { value: arrays.colors, size: 4, normalized: true },
          },
        },
        getRadius: 6,
        radiusUnits: 'meters',
        radiusMinPixels: 1.4,
        radiusMaxPixels: 14,
        stroked: false,
        pickable: true,
        autoHighlight: true,
        highlightColor: [0, 90, 200, 255],
        onClick: (info) => {
          if (info.index >= 0) onPick(arrays.order[info.index]);
        },
      }));
    }
    if (selected) {
      layers.push(new ScatterplotLayer({
        id: 'selected',
        data: [selected],
        getPosition: (d) => d,
        getRadius: 10,
        radiusUnits: 'meters',
        radiusMinPixels: 7,
        filled: false,
        stroked: true,
        getLineColor: [0, 70, 180, 255],
        lineWidthMinPixels: 3,
      }));
    }
    overlay.setProps({ layers });
  }

  return {
    map,
    setArrays(a) { arrays = a; render(); },
    select(pos) { selected = pos; render(); },
    flyTo(lon, lat, zoom = 17) { map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), speed: 1.6 }); },
    resize() { map.resize(); },
  };
}
