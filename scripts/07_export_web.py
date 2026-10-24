"""把風險模型結果匯出成前端用的靜態檔（web/public/data/）與一致性測試資料（web/test/fixtures/）。

產出（資料契約，前端依此讀取）：
  buildings.bin.gz  欄式二進位（little-endian）的 gzip 檔，各欄位 offset/型別記在 meta.json 的 columns；
                    Cloudflare 不會壓縮 application/octet-stream，故預先壓縮，前端以 DecompressionStream 解壓
  meta.json       欄位表、各類別代碼表（codebooks）、里資料、模型設定（config/risk_weights.json 原文）、資料來源
  addr/{d}.json   依行政區分片的門牌：{"main": {建物索引: [主門牌, 使照號碼, 海砂屋案號]}, "alias": {門牌: 建物索引}}
                  門牌均已去掉「台北市XX區」前綴，正規化規則同 scripts/addr_norm.py
  addr/roads.json 路段 → 行政區代碼清單：{"仁愛路3段": [5], ...}，地址沒寫區時只需載入相關分片
  villages.json   里界 GeoJSON（簡化後），properties.v = meta.json villages 的索引，供地圖「里別」檢視上色
  ../test/fixtures/parity.json  Python 算出的預期分數與門牌正規化案例，前端 JS 實作必須對得上
"""
import gzip
import importlib
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from addr_norm import normalize

import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROC = ROOT / "data" / "processed"
OUT = ROOT / "web" / "public" / "data"
FIXTURES = ROOT / "web" / "test" / "fixtures"
CONFIG = ROOT / "config" / "risk_weights.json"
risk = importlib.import_module("06_risk_model")

FACTORS = ["era", "structure", "typology", "soft_story", "liquefaction", "fault", "elderly", "fire_access"]
FLAG_BITS = {"in_fire_lane_list": 1, "village_has_fire_lane": 2, "arcade": 4, "shop": 8,
             "district_mismatch": 16, "year_unknown": 32}


def codes(s: pd.Series, order: list | None = None) -> tuple[np.ndarray, list]:
    """類別欄 → (uint8 代碼, 代碼表)；代碼 0 保留給缺值。"""
    vals = order or sorted(s.dropna().unique().tolist())
    m = {v: i + 1 for i, v in enumerate(vals)}
    return s.map(m).fillna(0).astype(np.uint8).to_numpy(), [None] + vals


def main() -> None:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    b = pd.read_parquet(PROC / "buildings_risk.parquet").reset_index(drop=True)
    n = len(b)

    cols: dict[str, np.ndarray] = {
        "lon": b["lon"].astype("<f4").to_numpy(),
        "lat": b["lat"].astype("<f4").to_numpy(),
    }
    # 因子分數 0–1 → uint16（誤差 < 1e-5，分數誤差 < 0.001）
    for k in FACTORS:
        cols[f"s_{k}"] = np.round(b[f"s_{k}"].to_numpy() * 65535).astype("<u2")
    cols["n_units"] = b["n_units"].clip(upper=65535).astype("<u2").to_numpy()
    cols["completion_year"] = b["completion_year"].fillna(0).astype("<u2").to_numpy()
    cols["floor_count"] = b["floor_count"].fillna(0).clip(upper=255).astype(np.uint8).to_numpy()
    cols["fault_dist_m"] = b["fault_dist_m"].clip(upper=65535).round().astype("<u2").to_numpy()
    cols["structure_confidence_pct"] = np.round(b["structure_confidence"] * 100).astype(np.uint8).to_numpy()
    cols["p_masonry_pct"] = np.round(b["p_masonry"] * 100).astype(np.uint8).to_numpy()

    codebooks = {}
    cfgv = cfg["vulnerability"]
    for name, series, order in [
        ("district", b["district"], None),
        ("code_era", b["code_era"], list(cfgv["era_scores"].keys())),
        ("structure_final", b["structure_final"], list(cfgv["structure_scores"].keys())),
        ("structure_final_source", b["structure_final_source"], ["使照", "實價登錄", "推估"]),
        ("liq_level", b["liq_level"], ["高", "中", "低"]),
        ("seasand_class", b["seasand_class"], list(cfgv["seasand_override"].keys())),
        ("lvr_building_type", b["lvr_building_type"], None),
        ("lvr_elevator", b["lvr_elevator"], ["有", "無"]),
        ("fire_lane_name", b["fire_lane_name"], None),
    ]:
        arr, book = codes(series, order)
        if len(book) > 255:
            arr = series.map({v: i for i, v in enumerate(book) if v is not None}).fillna(0).astype("<u2").to_numpy()
        cols[name] = arr
        codebooks[name] = book

    # 里：代碼表含名稱、所屬區、65+ 比例與百分位分數（百分位即 s_elderly）
    vil = (b.dropna(subset=["VILLCODE"]).groupby("VILLCODE")
           .agg(name=("VILLNAME", "first"), district=("TOWNNAME", "first"),
                elderly_ratio=("village_elderly_ratio", "first"), elderly_pct=("s_elderly", "first"),
                population=("village_pop", "first"))
           .reset_index().sort_values("VILLCODE"))
    vidx = {c: i for i, c in enumerate(vil["VILLCODE"])}
    cols["village"] = b["VILLCODE"].map(vidx).fillna(65535).astype("<u2").to_numpy()

    flags = np.zeros(n, dtype=np.uint8)
    for name, cond in [
        ("in_fire_lane_list", b["in_fire_lane_list"].fillna(False).astype(bool)),
        ("village_has_fire_lane", b["village_has_fire_lane"].fillna(False).astype(bool)),
        ("arcade", b["f_arcade"].fillna(0) > 0),
        ("shop", b["lvr_building_type"].fillna("").str.startswith("店面")),
        ("district_mismatch", b["district_mismatch"].fillna(False).astype(bool)),
        ("year_unknown", b["completion_year"].isna()),
    ]:
        flags |= np.where(cond.to_numpy(), FLAG_BITS[name], 0).astype(np.uint8)
    cols["flags"] = flags

    # 寫二進位：各欄 4-byte 對齊
    OUT.mkdir(parents=True, exist_ok=True)
    layout, buf, off = [], bytearray(), 0
    for name, arr in cols.items():
        assert len(arr) == n, name
        pad = (-off) % 4
        buf += b"\0" * pad
        off += pad
        raw = np.ascontiguousarray(arr).tobytes()
        layout.append({"name": name, "dtype": {"<f4": "float32", "float32": "float32", "<u2": "uint16",
                                               "uint16": "uint16", "uint8": "uint8", "|u1": "uint8"}[arr.dtype.str
                                               if arr.dtype.str in ("<f4", "<u2", "|u1") else arr.dtype.name],
                       "offset": off, "length": n})
        buf += raw
        off += len(raw)
    # mtime=0 讓同樣內容產出相同的壓縮檔；順手刪掉舊版未壓縮檔，避免被一起部署
    (OUT / "buildings.bin.gz").write_bytes(gzip.compress(bytes(buf), compresslevel=9, mtime=0))
    (OUT / "buildings.bin").unlink(missing_ok=True)

    # 門牌分片：一棟的所有門牌（不含樓層）都可查到；main 為顯示用主門牌
    u = pd.read_parquet(PROC / "cadastral_units.parquet", columns=["lat", "lon", "address"])
    u = u[u["lat"].notna() & u["lon"].notna()]
    u["bkey"] = u["lat"].round(7).astype(str) + "," + u["lon"].round(7).astype(str)
    u = u.join(normalize(u["address"]))[["bkey", "district", "base"]].dropna().drop_duplicates(["bkey", "base"])
    bidx = pd.Series(b.index, index=b["bkey"])
    u["idx"] = u["bkey"].map(bidx)
    u = u.dropna(subset=["idx"])
    u["street"] = u["base"].str.replace(r"^台北市[一-鿿]{2}區", "", regex=True)
    (OUT / "addr").mkdir(exist_ok=True)
    dist_book = codebooks["district"]
    alias_dup = 0
    for di, dname in enumerate(dist_book):
        if dname is None:
            continue
        bd = b[b["district"] == dname]
        main = {int(i): [r.addr_base.replace(f"台北市{dname}", "") if isinstance(r.addr_base, str) else "",
                         r.license_no if isinstance(r.license_no, str) else "",
                         int(r.seasand_case) if pd.notna(r.seasand_case) else 0]
                for i, r in zip(bd.index, bd.itertuples())}
        ud = u[u["district"] == dname]
        # 同一門牌對到多棟（座標不同）時取戶數多的那棟
        ud = ud.assign(units=b.loc[ud["idx"].astype(int), "n_units"].to_numpy()).sort_values("units", ascending=False)
        alias_dup += int(ud["street"].duplicated().sum())
        alias = dict(zip(ud.drop_duplicates("street")["street"], ud.drop_duplicates("street")["idx"].astype(int)))
        (OUT / "addr" / f"{di}.json").write_text(
            json.dumps({"district": dname, "main": main, "alias": alias}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")

    # 路段索引：同一條路可能跨區（如仁愛路），值為所有出現過的區代碼
    u["road"] = u["street"].str.extract(r"^([一-鿿]+?(?:路|街|大道)(?:\d+段)?)")[0]
    u["dcode"] = u["district"].map({d: i for i, d in enumerate(dist_book) if d})
    roads = u.dropna(subset=["road"]).groupby("road")["dcode"].agg(lambda s: sorted(set(int(x) for x in s)))
    (OUT / "addr" / "roads.json").write_text(
        json.dumps(roads.to_dict(), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    no_road = u["road"].isna().mean()
    print(f"路段索引 {len(roads):,} 條（平均跨 {roads.map(len).mean():.2f} 區、最多 {roads.map(len).max()} 區）；"
          f"門牌抽不出路段 {no_road:.2%}（這些前端需退回載入全部分片）")

    meta = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "count": n,
        "columns": layout,
        "bin_gz_bytes": (OUT / "buildings.bin.gz").stat().st_size,
        "factor_keys": FACTORS,
        "factor_scale": 65535,
        "flag_bits": FLAG_BITS,
        "codebooks": codebooks,
        "villages": vil.drop(columns="VILLCODE").assign(code=vil["VILLCODE"]).round(4).to_dict(orient="records"),
        "config": cfg,
        "addr_shards": {i: f"addr/{i}.json" for i, d in enumerate(dist_book) if d},
        "sources": [
            {"name": "內政部地籍圖資便民查詢（逐戶門牌、座標、完成日、樓層）", "kind": "真實"},
            {"name": "臺北市歷年使用執照摘要", "url": "https://data.taipei/dataset/detail?id=c876ff02-af2e-4eb8-bd33-d444f5052733", "kind": "真實"},
            {"name": "內政部實價登錄（買賣、租賃）", "url": "https://plvr.land.moi.gov.tw/DownloadOpenData", "kind": "真實"},
            {"name": "臺北市土壤液化潛勢圖", "url": "https://data.taipei/dataset/detail?id=ec40e067-930f-4058-b7dc-71399d5f3147", "kind": "真實"},
            {"name": "山腳斷層（臺北市 ArcGIS Portal）", "kind": "真實"},
            {"name": "臺北市各里人口數按年齡分", "url": "https://data.taipei/dataset/detail?id=a6394e3f-3514-4542-87bd-de4310a40db3", "kind": "真實"},
            {"name": "臺北市消防通道清冊", "url": "https://data.taipei/dataset/detail?id=7a800e92-eb22-461f-b29d-8def2127a1bc", "kind": "真實"},
            {"name": "臺北市海砂屋列管清冊（115.3.25）", "url": "https://www-ws.gov.taipei/001/Upload/845/relfile/-1/845/7e3d3798-d6ab-4f35-b720-44854dec092c.pdf", "kind": "真實"},
            {"name": "結構類型（無使照／實價登錄者）", "kind": "模型推估"},
        ],
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    write_villages(vil["VILLCODE"].tolist())
    write_fixtures(b, u, cfg)
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"建物 {n:,} 棟；buildings.bin {len(buf) / 1e6:.1f} MB（gzip 後 {meta['bin_gz_bytes'] / 1e6:.1f} MB）；"
          f"門牌別名 {len(u):,} 筆（同門牌多棟 {alias_dup:,} 筆取戶數多者）；data/ 合計 {size / 1e6:.1f} MB -> {OUT}")


def write_villages(codes: list) -> None:
    """里界 → villages.json：簡化約 3 m、座標取 5 位小數（約 1 m），只留 meta.villages 的索引當屬性。"""
    v = gpd.read_file(RAW / "village_boundary" / "VILLAGE_NLSC_1150817.shp")
    v = v[v["COUNTYNAME"] == "臺北市"].to_crs("EPSG:4326")
    vidx = {c: i for i, c in enumerate(codes)}
    v = v[v["VILLCODE"].isin(vidx)]
    v["geometry"] = v.geometry.simplify(0.00003, preserve_topology=True)
    r5 = lambda ring: [[round(x, 5), round(y, 5)] for x, y in ring.coords]
    feats = []
    for code, geom in zip(v["VILLCODE"], v.geometry):
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        rings = [[r5(p.exterior)] + [r5(h) for h in p.interiors] for p in polys]
        feats.append({"type": "Feature", "properties": {"v": vidx[code]},
                      "geometry": {"type": "MultiPolygon", "coordinates": rings}})
    out = OUT / "villages.json"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")), encoding="utf-8")
    print(f"里界 {len(feats)} 里（meta 有 {len(codes)} 里）-> {out}（{out.stat().st_size / 1e3:.0f} KB）")


def write_fixtures(b: pd.DataFrame, u: pd.DataFrame, cfg: dict) -> None:
    """Python 端預期值：前端 JS 公式與門牌正規化必須對得上（分數容許誤差 0.01）。"""
    rng = np.random.default_rng(7)
    idx = sorted(set(rng.choice(len(b), 300, replace=False).tolist())
                 | set(b.nsmallest(20, "rank").index.tolist())
                 | set(b[b["seasand_case"].notna()].index[:10].tolist())
                 | set(b[b["completion_year"].isna()].index[:10].tolist()))
    f = pd.DataFrame({k: b[f"s_{k}"] for k in FACTORS + ["seasand"]})
    vw, hw, sw = cfg["vulnerability"]["weights"], cfg["hazard"]["weights"], cfg["social"]["weights"]
    cases = [
        {"name": "預設", "vulnerability": vw, "hazard": hw, "social": sw, "alpha": cfg["alpha"], "beta": cfg["beta"]},
        {"name": "改權重", "vulnerability": {"era": 0.1, "structure": 0.5, "typology": 0.1, "soft_story": 0.3},
         "hazard": {"liquefaction": 0.3, "fault": 0.7}, "social": {"elderly": 0.8, "fire_access": 0.2},
         "alpha": 1.0, "beta": 0.5},
        {"name": "無危害無社會", "vulnerability": vw, "hazard": hw, "social": sw, "alpha": 0.0, "beta": 0.0},
    ]
    for c in cases:
        score, d = risk.compute(f, c["vulnerability"], c["hazard"], c["social"], c["alpha"], c["beta"], detail=True)
        c["expected"] = [{"index": int(i), "score": round(float(score[i]), 6),
                          "contributions": {k[2:]: round(float(d[k][i]), 6) for k in d if k.startswith("c_")}}
                         for i in idx]

    # 門牌正規化案例：真實地籍門牌（含樓層）＋人工變形（臺/全形/中文段/之）
    sample = u.sample(40, random_state=7)
    addr_cases = []
    for r in sample.itertuples():
        raw_full = f"台北市{r.district}{r.street}"
        addr_cases.append({"input": raw_full + "3樓", "district": r.district, "street": r.street, "index": int(r.idx)})
    variants = [
        ("臺北市大安區仁愛路三段24巷1之1號2樓", "大安區", "仁愛路3段24巷1-1號"),
        ("台北市中山區中山北路二段６８號５樓", "中山區", "中山北路2段68號"),
        ("臺北市松山區南京東路五段251巷22弄28號 2樓", "松山區", "南京東路5段251巷22弄28號"),
        ("士林區中山北路五段618號5樓之2", "士林區", "中山北路5段618號"),
        ("台北市士林區下樹林街1之8號", "士林區", "下樹林街1-8號"),
        ("臺北市中正區民權東路十二段3號", "中正區", "民權東路12段3號"),
        ("仁愛路3段24巷1-1號", None, "仁愛路3段24巷1-1號"),
        # 「公舘路」異體字：使用者常打「公館路」，資料來源有「?」「□」等寫法
        ("台北市北投區公館路267之1號5樓", "北投區", "公舘路267-1號"),
        ("北投區公?路423巷8弄3號2樓", "北投區", "公舘路423巷8弄3號"),
        ("公□路185號", None, "公舘路185號"),
        # 郵遞區號與里名前綴要忽略（使用者常從信封或戶籍資料複製）
        ("106台北市大安區光武里10鄰仁愛路三段24巷1之1號2樓", "大安區", "仁愛路3段24巷1-1號"),
        ("10617臺北市大安區光武里仁愛路三段24巷1號", "大安區", "仁愛路3段24巷1號"),
        ("(106)大安區仁愛路三段24巷1號", "大安區", "仁愛路3段24巷1號"),
        ("106017 臺北市北投區週美里公館路267之1號", "北投區", "公舘路267-1號"),
        ("光武里仁愛路三段24巷1號", None, "仁愛路3段24巷1號"),
        ("台北市光武里10鄰仁愛路3段24巷1號", None, "仁愛路3段24巷1號"),
        ("24巷1號", None, "24巷1號"),
        ("(106)光武里10鄰仁愛路三段24巷16號", None, "仁愛路3段24巷16號"),
        ("106仁愛路三段24巷16號", None, "仁愛路3段24巷16號"),
        ("123巷4號", None, "123巷4號"),
    ]
    for raw, dist, street in variants:
        addr_cases.append({"input": raw, "district": dist, "street": street, "index": None})

    FIXTURES.mkdir(parents=True, exist_ok=True)
    (FIXTURES / "parity.json").write_text(json.dumps({
        "tolerance": 0.01,
        "note": "expected 由 scripts/06_risk_model.py 的 compute() 以浮點因子分數算出；前端用 uint16 量化後的因子分數重算，誤差須 < tolerance",
        "cases": cases,
        "address_cases": addr_cases,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"一致性測試資料：{len(idx)} 棟 × {len(cases)} 組權重、門牌案例 {len(addr_cases)} 個 -> {FIXTURES / 'parity.json'}")


if __name__ == "__main__":
    sys.exit(main())
