"""整合各來源到「逐棟（門牌座標點）」一張表，並輸出 join 覆蓋率報告。

建物單位定義：地籍資料同一組 (lat, lon) 視為同一棟（同門牌的各樓層戶共用座標）。

輸入：data/processed/cadastral_units.parquet、use_license*.parquet、data/raw/ 下各公開資料
輸出：data/processed/buildings_integrated.parquet
      reports/join_report.md
"""
import re
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

from addr_norm import normalize

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROC = ROOT / "data" / "processed"
REPORT = ROOT / "reports" / "join_report.md"
TM2 = "EPSG:3826"  # TWD97 TM2，算距離用（公尺）

# 土壤液化 class 定義：依 gis.liquid.net.tw Soil_taipei MapServer legend，1=高、2=中、3=低（數字越小越危險）
LIQ_LABEL = {1: "高", 2: "中", 3: "低"}

log: list[str] = []


def say(msg: str = "") -> None:
    print(msg)
    log.append(msg)


def pct(a, b) -> str:
    return f"{a:,} / {b:,}（{a / b:.1%}）" if b else f"{a} / 0"


def code_era(y: float) -> str:
    """耐震法規關鍵年份分段（以完成年粗分，實際應看建照申請日）。"""
    if pd.isna(y):
        return "未知"
    if y < 1974:
        return "1974前（無耐震設計規定）"
    if y < 1983:
        return "1974-1982（初版耐震）"
    if y < 1997:
        return "1983-1996（1982 修正）"
    if y < 2000:
        return "1997-1999（1997 修正、921 前）"
    if y < 2006:
        return "2000-2005（921 後修正）"
    return "2006 後（現行規範）"


# ---------------------------------------------------------------- 1. 地籍 → 逐棟
def load_buildings():
    u = pd.read_parquet(PROC / "cadastral_units.parquet")
    u = u[u["lat"].notna() & u["lon"].notna()].copy()
    n = normalize(u["address"])
    u = u.join(n)
    say("## 1. 地籍資料（逐戶 → 逐棟）")
    say(f"- 戶數（列）：{len(u):,}")
    say(f"- 地址可解析到「號」：{pct(int(u['base'].notna().sum()), len(u))}")

    u["bkey"] = u["lat"].round(7).astype(str) + "," + u["lon"].round(7).astype(str)
    g = u.groupby("bkey", sort=False)
    b = pd.DataFrame({
        "lat": g["lat"].first(),
        "lon": g["lon"].first(),
        "district": g["district"].agg(lambda s: s.mode().iat[0] if s.notna().any() else None),
        "addr_base": g["base"].agg(lambda s: min(s.dropna(), key=len) if s.notna().any() else None),
        "n_units": g.size(),
        "completion_year": g["completion_year"].agg(lambda s: s.mode().iat[0] if s.notna().any() else pd.NA),
        "completion_year_min": g["completion_year"].min(),
        "completion_year_max": g["completion_year"].max(),
        "floor_count": g["floor_count"].max(),
        "total_floor_area_m2": g["building_area"].sum(),
    }).reset_index()
    b["completion_year"] = pd.to_numeric(b["completion_year"], errors="coerce")
    b["age_2026"] = 2026 - b["completion_year"]
    b["code_era"] = b["completion_year"].map(code_era)
    say(f"- 逐棟（不重複座標）：{len(b):,}")
    say(f"- 有完成年：{pct(int(b['completion_year'].notna().sum()), len(b))}；有樓層數：{pct(int(b['floor_count'].notna().sum()), len(b))}")
    mixed = (b["completion_year_max"] - b["completion_year_min"]).fillna(0) > 2
    say(f"- 同座標內完成年相差 >2 年（可能多棟共點或增建）：{int(mixed.sum()):,}")
    say("- 耐震法規時期分布：")
    for k, v in b["code_era"].value_counts().items():
        say(f"  - {k}：{v:,}")
    return u, b


# ---------------------------------------------------------------- 2. 使用執照（結構）
def join_license(u: pd.DataFrame, b: pd.DataFrame) -> pd.DataFrame:
    lic = pd.read_parquet(PROC / "use_license.parquet")
    la = pd.read_parquet(PROC / "use_license_address.parquet")
    la = la.join(normalize(la["address_raw"]))
    la = la.merge(lic[["license_no", "issue_date", "completion_date", "build_type",
                       "structure_class", "structure_raw", "floors_above"]], on="license_no")
    la["lic_year"] = la["issue_date"].dt.year

    say("\n## 2. 使用執照摘要 ↔ 地籍（門牌號層級）")
    say(f"- 使照：{len(lic):,} 張，門牌 {len(la):,} 筆（僅民國 90 年後，921 前老屋不在內）")
    lb = la.dropna(subset=["base"]).drop_duplicates(["license_no", "base"])
    cad_bases = set(u["base"].dropna())
    hit = lb["base"].isin(cad_bases)
    say(f"- 使照門牌（號層級去重）在地籍找得到：{pct(int(hit.sum()), len(lb))}")
    lic_hit = lb[hit]["license_no"].nunique()
    say(f"- 至少一個門牌對上的使照張數：{pct(lic_hit, len(lic))}")

    # 逐戶對使照，再用年份驗證（登記完成日 vs 使照發照年 差 ≤ 2 年）
    m = u[["bkey", "base", "completion_year"]].dropna(subset=["base"]).drop_duplicates(["bkey", "base"]).merge(
        lb[["base", "license_no", "lic_year", "build_type", "structure_class", "structure_raw", "floors_above"]],
        on="base")
    m["year_diff"] = (m["completion_year"].astype("Float64") - m["lic_year"]).abs()
    say(f"- 門牌對上的 (棟, 使照) 配對：{len(m):,}；年差分布：")
    vc = pd.cut(m["year_diff"].astype(float), [-0.1, 0.5, 1.5, 2.5, 5.5, 200], labels=["0", "1", "2", "3-5", ">5"]).value_counts().sort_index()
    for k, v in vc.items():
        say(f"  - 年差 {k}：{v:,}")
    say(f"  - 地籍無完成年：{int(m['year_diff'].isna().sum()):,}")

    good = m[(m["year_diff"] <= 2) & (m["build_type"] == "新建")]
    # 一棟對到多張使照時，取年差最小者
    good = good.sort_values("year_diff").drop_duplicates("bkey")
    b = b.merge(good[["bkey", "license_no", "structure_class", "structure_raw", "floors_above", "year_diff"]]
                .rename(columns={"year_diff": "license_year_diff", "structure_class": "lic_structure_class",
                                 "structure_raw": "lic_structure_raw"}), on="bkey", how="left")
    post2001 = b["completion_year"] >= 2001
    say(f"- 逐棟取得使照結構（新建、年差≤2）：{pct(int(b['lic_structure_class'].notna().sum()), len(b))}")
    say(f"  - 其中 2001 後完成之棟：{pct(int((b['lic_structure_class'].notna() & post2001).sum()), int(post2001.sum()))}")
    fc_ok = (b["floors_above"].notna() & b["floor_count"].notna())
    same = (b.loc[fc_ok, "floors_above"] == b.loc[fc_ok, "floor_count"]).sum()
    say(f"  - 驗證：使照地上層數 = 地籍總樓層數：{pct(int(same), int(fc_ok.sum()))}")
    say("  - 結構分布：" + "、".join(f"{k} {v:,}" for k, v in b["lic_structure_class"].value_counts().items()))
    return b


# ---------------------------------------------------------------- 2b. 實價登錄（主要建材、建物型態、電梯）
def join_lvr(u: pd.DataFrame, b: pd.DataFrame) -> pd.DataFrame:
    lv = pd.read_parquet(PROC / "lvr.parquet").dropna(subset=["base"])
    say("\n## 2b. 實價登錄 ↔ 地籍（門牌號層級）")
    say(f"- 實價登錄含建物紀錄：{len(lv):,}（{lv['season'].min()}–{lv['season'].max()}，"
        + "、".join(f"{k} {v:,}" for k, v in lv["source"].value_counts().items()) + "）")
    ub = u[["bkey", "base"]].dropna().drop_duplicates()
    m = lv.merge(ub, on="base")
    say(f"- 紀錄門牌在地籍找得到：{pct(len(m.drop_duplicates(['source', 'record_no'])), len(lv))}")

    # 逐筆驗證：完成年差 ≤1、總樓層一致（任一缺值不判為不一致）
    m = m.merge(b[["bkey", "completion_year", "floor_count"]].rename(
        columns={"completion_year": "cad_year", "floor_count": "cad_floors"}), on="bkey")
    yd = (m["completion_year"] - m["cad_year"]).abs()
    fd = (m["total_floors"] - m["cad_floors"].astype("Float64")).abs()
    m["consistent"] = (yd.isna() | (yd <= 1)) & (fd.isna() | (fd == 0))
    say(f"- 對上的 (紀錄, 棟) 配對：{len(m):,}；年份與樓層皆一致：{pct(int(m['consistent'].sum()), len(m))}")
    say(f"  - 年差 ≤1：{pct(int((yd <= 1).sum()), int(yd.notna().sum()))}；總樓層相同：{pct(int((fd == 0).sum()), int(fd.notna().sum()))}")

    ok = m[m["consistent"] & (m["structure_class"] != "未知")]

    def vote(s: pd.Series):
        vc = s.value_counts()
        return vc.index[0], int(vc.iat[0]), int(vc.sum())

    agg = ok.groupby("bkey").agg(
        lvr_structure=("structure_class", vote),
        lvr_building_type=("building_type", lambda s: s.mode().iat[0] if s.notna().any() else None),
        lvr_elevator=("elevator", lambda s: s.dropna().mode().iat[0] if s.notna().any() else None),
        lvr_records=("record_no", "size"),
    )
    agg["lvr_structure_class"] = agg["lvr_structure"].map(lambda t: t[0])
    agg["lvr_structure_agree"] = agg["lvr_structure"].map(lambda t: t[1] / t[2])
    agg = agg.drop(columns="lvr_structure").reset_index()
    b = b.merge(agg, on="bkey", how="left")

    has = b["lvr_structure_class"].notna()
    say(f"- 逐棟取得實價登錄結構：{pct(int(has.sum()), len(b))}；多筆紀錄間結構一致率中位數 "
        f"{b.loc[has, 'lvr_structure_agree'].median():.0%}")
    say("  - 各耐震時期覆蓋：")
    for era, grp in b.groupby("code_era"):
        say(f"    - {era}：{pct(int(grp['lvr_structure_class'].notna().sum()), len(grp))}")
    say("  - 結構分布：" + "、".join(f"{k} {v:,}" for k, v in b["lvr_structure_class"].value_counts().items()))

    # 交叉驗證：同棟使照 vs 實價登錄
    both = b["lic_structure_class"].notna() & has
    agree = (b.loc[both, "lic_structure_class"] == b.loc[both, "lvr_structure_class"]).sum()
    say(f"- 交叉驗證（同棟兩來源都有）：結構大類一致 {pct(int(agree), int(both.sum()))}")
    if both.any():
        ct = pd.crosstab(b.loc[both, "lic_structure_class"], b.loc[both, "lvr_structure_class"])
        say("  - 使照(列) × 實價登錄(欄)：\n\n" + ct.to_markdown() + "\n")

    # 最終結構：使照優先（官方、逐案），其次實價登錄
    b["structure_class"] = b["lic_structure_class"].fillna(b["lvr_structure_class"])
    b["structure_source"] = np.select(
        [b["lic_structure_class"].notna(), b["lvr_structure_class"].notna()], ["使照", "實價登錄"], default=None)
    say(f"- **合併後逐棟有結構：{pct(int(b['structure_class'].notna().sum()), len(b))}**")
    old = b["completion_year"] < 2000
    say(f"  - 其中 2000 年前完成的老屋：{pct(int((b['structure_class'].notna() & old).sum()), int(old.sum()))}")
    say("  - 合併後結構分布：" + "、".join(f"{k} {v:,}" for k, v in b["structure_class"].value_counts().items()))
    return b


# ---------------------------------------------------------------- 3. 空間圖層
def join_spatial(b: pd.DataFrame) -> gpd.GeoDataFrame:
    g = gpd.GeoDataFrame(b, geometry=gpd.points_from_xy(b["lon"], b["lat"]), crs="EPSG:4326")

    say("\n## 3. 空間 join")
    # 3a 村里界
    v = gpd.read_file(RAW / "village_boundary" / "VILLAGE_NLSC_1150817.shp")
    v = v[v["COUNTYNAME"] == "臺北市"].to_crs("EPSG:4326")[["VILLCODE", "TOWNNAME", "VILLNAME", "geometry"]]
    g = gpd.sjoin(g, v, how="left", predicate="within").drop(columns="index_right")
    say(f"- 落入臺北市里界：{pct(int(g['VILLCODE'].notna().sum()), len(g))}（{len(v)} 里）")
    town_mismatch = g["TOWNNAME"].notna() & g["district"].notna() & (g["TOWNNAME"] != g["district"])
    say(f"  - 座標所在區 ≠ 地址的區（座標或地址可疑）：{int(town_mismatch.sum()):,}")
    g["district_mismatch"] = town_mismatch

    # 3b 里人口：65 歲以上比例（最新一期）
    p = pd.read_csv(RAW / "village_pop_by_age.csv", encoding="cp950")
    p = p[(p["年份"] == p["年份"].max())]
    p = p[(p["月份"] == p["月份"].max()) & (p["性別"] == "計")]
    p = p[p["區域代碼"].astype(str).str.len() == 11]
    age_cols = [f"{i}歲數量" for i in range(65, 100)] + ["100歲以上"]
    pop = pd.DataFrame({
        "VILLCODE": p["區域代碼"].astype(str),
        "village_pop": p["總計"],
        "village_elderly_ratio": p[age_cols].sum(axis=1) / p["總計"],
    })
    g = g.merge(pop, on="VILLCODE", how="left")
    say(f"- 里人口（{p['年份'].iat[0]} 年 {p['月份'].iat[0]} 月）：對上 {pct(int(g['village_elderly_ratio'].notna().sum()), len(g))}；"
        f"里 65+ 比例範圍 {pop['village_elderly_ratio'].min():.1%}–{pop['village_elderly_ratio'].max():.1%}")

    # 3c 土壤液化潛勢
    liq = gpd.read_file(RAW / "liquefaction_wgs84.geojson")[["class", "geometry"]]
    liq["liq_class"] = liq["class"].astype(int)
    g = gpd.sjoin(g, liq[["liq_class", "geometry"]], how="left", predicate="within")
    # 多邊形若重疊：同一點取最危險（class 最小）
    g = g.sort_values("liq_class").drop_duplicates("bkey").drop(columns="index_right")
    g["liq_level"] = g["liq_class"].map(LIQ_LABEL)
    say("- 土壤液化潛勢：" + "、".join(
        f"{k} {v:,}" for k, v in g["liq_level"].fillna("圖層外（多為山區）").value_counts().items()))
    say("  - 各區高潛勢棟數：" + "、".join(
        f"{k} {v:,}" for k, v in g.loc[g["liq_class"] == 1, "district"].value_counts().head(5).items()))

    # 3d 山腳斷層距離（臺北市 ArcGIS Portal 圖資）
    fault = gpd.read_file(RAW / "shanchiao_fault.geojson").to_crs(TM2).union_all()
    gt = g.to_crs(TM2)
    g["fault_dist_m"] = gt.geometry.distance(fault).round(0)
    say("- 距山腳斷層：" + "、".join(
        f"{k} {v:,}" for k, v in pd.cut(g["fault_dist_m"], [0, 1000, 2000, 5000, 1e9],
                                         labels=["<1km", "1-2km", "2-5km", ">5km"]).value_counts().sort_index().items()))
    return g


# ---------------------------------------------------------------- 4. 消防
_ROAD = r"([一-鿿]+?(?:路|街|大道))(\d+段)?"


def parse_fire_lane(name: str) -> list[tuple[str, str | None]]:
    """把「齊東街53巷及齊東街70巷」「康寧路1段156、176巷」拆成 [(路段, 巷|None), ...]。"""
    from addr_norm import _cn_to_int
    s = re.sub(r"([一二三四五六七八九十]+)段", lambda m: _cn_to_int(m.group(1)) + "段", name)
    s = re.sub(r"[（(].*?[)）]", "", s).replace("　", "")
    out, last_road = [], None
    for part in re.split(r"及|、|接|連通|右轉|至|起至|自|間|,", s):
        part = part.strip()
        if not part:
            continue
        m = re.match(_ROAD + r"(?:(\d+)巷)?", part)
        if m:
            last_road = m.group(1) + (m.group(2) or "")
            out.append((last_road, m.group(3)))
        elif last_road and (m2 := re.match(r"(?:同巷)?(\d+)巷", part)):
            out.append((last_road, m2.group(1)))
    return out


def join_fire(g: gpd.GeoDataFrame, u: pd.DataFrame) -> gpd.GeoDataFrame:
    say("\n## 4. 消防資料")
    v = gpd.read_file(RAW / "village_boundary" / "VILLAGE_NLSC_1150817.shp", ignore_geometry=True)
    town_by_code = v[v["COUNTYNAME"] == "臺北市"].drop_duplicates("TOWNCODE").set_index("TOWNCODE")["TOWNNAME"].to_dict()

    # 4a 消防通道清冊：區 + 路段(+巷) 文字比對到門牌
    fl = pd.read_csv(RAW / "fire_lane_list.csv")
    fl["district"] = fl["行政區代碼"].astype(str).map(town_by_code)
    rules = []
    for _, r in fl.iterrows():
        for road, lane in parse_fire_lane(str(r["列管名稱"])):
            rules.append({"district": r["district"], "village": r["里別"], "road": road, "lane": lane,
                          "fire_lane_type": r["列管要件"], "fire_lane_name": r["列管名稱"]})
    rules = pd.DataFrame(rules)
    parsed = fl["列管名稱"].map(lambda s: len(parse_fire_lane(str(s))) > 0).sum()
    say(f"- 消防通道清冊 {len(fl)} 筆，可解析出路段/巷：{pct(int(parsed), len(fl))}")

    sn = g[["bkey", "district", "VILLNAME", "addr_base"]].copy()
    sn["street"] = sn["addr_base"].str.replace(r"^台北市[一-鿿]{2}區", "", regex=True)
    ext = sn["street"].str.extract(r"^" + _ROAD)
    sn["road"] = ext[0] + ext[1].fillna("")
    sn["lane"] = sn["street"].str.extract(r"(\d+)巷")[0]
    hit = []
    for (d, road), grp in rules.groupby(["district", "road"]):
        cand = sn[(sn["district"] == d) & (sn["road"] == road)]
        for _, r in grp.iterrows():
            c = cand if r["lane"] is None else cand[cand["lane"] == r["lane"]]
            # 只有路名（無巷）時，限縮在清冊所列的里，避免整條長路都被標記
            if r["lane"] is None:
                c = c[c["VILLNAME"] == r["village"]]
            hit.append(c[["bkey"]].assign(fire_lane_type=r["fire_lane_type"], fire_lane_name=r["fire_lane_name"]))
    hit = pd.concat(hit).drop_duplicates("bkey") if hit else pd.DataFrame(columns=["bkey"])
    g = g.merge(hit, on="bkey", how="left")
    g["in_fire_lane_list"] = g["fire_lane_type"].notna()
    say(f"- 逐棟落在列管巷道（文字比對）：{int(g['in_fire_lane_list'].sum()):,} 棟")

    # 里層級旗標：該里是否有任何列管
    vill_flag = set(zip(fl["district"], fl["里別"]))
    g["village_has_fire_lane"] = [(d, vn) in vill_flag for d, vn in zip(g["TOWNNAME"], g["VILLNAME"])]
    say(f"- 所在里有消防通道列管：{int(g['village_has_fire_lane'].sum()):,} 棟")

    # 4b 火災搶救困難地區場所清冊：地址 join
    fd = pd.read_csv(RAW / "fire_difficult_places.csv")
    fd["district"] = fd["行政區編號"].astype(str).map(town_by_code)
    n = normalize(fd["地址"])
    fd["base"] = "台北市" + fd["district"].fillna("") + n["street_no"]
    ub = u[["bkey", "base"]].dropna().drop_duplicates("base")
    fdm = fd.merge(ub, on="base", how="left")
    say(f"- 火災搶救困難場所 {len(fd)} 筆，地址對上地籍：{pct(int(fdm['bkey'].notna().sum()), len(fd))}")
    agg = fdm.dropna(subset=["bkey"]).groupby("bkey").agg(
        fire_difficult_place=("場所名稱", "first"), fire_difficult_item=("認定項目", "first"))
    g = g.merge(agg, on="bkey", how="left")
    return g


def main() -> None:
    u, b = load_buildings()
    b = join_license(u, b)
    b = join_lvr(u, b)
    g = join_spatial(b)
    g = join_fire(g, u)

    say("\n## 5. 整合結果欄位完整度（逐棟）")
    for c in ["completion_year", "floor_count", "structure_class", "lic_structure_class", "lvr_structure_class",
              "lvr_building_type", "lvr_elevator", "VILLCODE",
              "village_elderly_ratio", "liq_class", "fault_dist_m", "fire_lane_type", "fire_difficult_place"]:
        say(f"- {c}：{pct(int(g[c].notna().sum()), len(g))}")

    out = PROC / "buildings_integrated.parquet"
    g.drop(columns="geometry").to_parquet(out, index=False)
    say(f"\n輸出：{out.relative_to(ROOT)}（{len(g):,} 棟）")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("# 資料整合 join 報告（自動產生）\n\n" + "\n".join(log) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
