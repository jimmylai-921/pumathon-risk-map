"""推估沒有使照／實價登錄結構的建物結構類型。

訓練集：04_integrate.py 已有 structure_class 的建物（使照或實價登錄）。
特徵：只用「每棟都有」的地籍資訊（完成年、樓層、面積、戶數、樓層明細關鍵字、區、座標），
      不用實價登錄的建物型態（未知那群本來就沒有，會洩漏）。
模型：分層多數決（基準，好解釋）vs HistGradientBoosting（較準），5-fold CV 比較後選用。
輸出：data/processed/buildings_with_structure.parquet、reports/structure_inference.md
"""
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import StratifiedKFold

ROOT = Path(__file__).resolve().parent.parent
PROC = ROOT / "data" / "processed"
REPORT = ROOT / "reports" / "structure_inference.md"
SEED = 42

CLASSES = ["RC", "加強磚造", "磚造", "SRC", "鋼構", "木造/土造"]
MASONRY = ["加強磚造", "磚造", "木造/土造"]

# 樓層明細（地籍建物分層）關鍵字 → 特徵；地下層與避難室幾乎只出現在 RC 以上的結構
FLAG_KEYS = {
    "f_basement": ("地下", "避難室", "停車場"),
    "f_elev_hall": ("電梯樓梯間",),
    "f_arcade": ("騎樓",),
    "f_rain_shelter": ("雨遮",),
    "f_flower_bed": ("花台", "栽植槽"),
    "f_balcony": ("陽臺", "陽台", "露台"),
    "f_mezzanine": ("夾層",),
    "f_rooftop": ("屋頂突出物", "瞭望", "水箱", "水塔"),
    "f_see_license": ("見使用執照",),
}

log: list[str] = []


def say(msg: str = "") -> None:
    print(msg)
    log.append(msg)


def floor_bin(f) -> str:
    if pd.isna(f):
        return "?"
    return "1-3" if f <= 3 else "4-5" if f <= 5 else "6-7" if f <= 7 else "8-12" if f <= 12 else "13+"


def year_bin(y) -> str:
    if pd.isna(y):
        return "?"
    return str(int(min(max(y, 1950), 2025) // 5 * 5))


def build_features(b: pd.DataFrame) -> pd.DataFrame:
    u = pd.read_parquet(PROC / "cadastral_units.parquet",
                        columns=["lat", "lon", "building_area", "floor_detail_keys"])
    u = u[u["lat"].notna() & u["lon"].notna()]
    # bkey 與 04_integrate.py 相同算法
    u["bkey"] = u["lat"].round(7).astype(str) + "," + u["lon"].round(7).astype(str)
    keys = u["floor_detail_keys"].map(lambda ks: "|".join(ks) if ks is not None else "")
    for col, words in FLAG_KEYS.items():
        u[col] = keys.str.contains("|".join(words), regex=True).astype("int8")
    # 戶內登記樓層數（一戶跨幾層：透天常見）
    u["unit_levels"] = u["floor_detail_keys"].map(
        lambda ks: sum(1 for k in ks if k.endswith("層") and not k.startswith("地下")) if ks is not None else 0)
    agg = u.groupby("bkey").agg(
        **{c: (c, "mean") for c in FLAG_KEYS},
        unit_levels_max=("unit_levels", "max"),
        unit_area_mean=("building_area", "mean"),
        unit_area_max=("building_area", "max"),
    ).reset_index()

    x = b[["bkey", "lat", "lon", "district", "completion_year", "floor_count", "n_units",
           "total_floor_area_m2", "completion_year_min", "completion_year_max"]].merge(agg, on="bkey", how="left")
    x["year_span"] = x["completion_year_max"] - x["completion_year_min"]
    x["units_per_floor"] = x["n_units"] / x["floor_count"].astype("Float64")
    x["area_per_floor"] = x["total_floor_area_m2"] / x["floor_count"].astype("Float64")
    x["district_code"] = x["district"].astype("category").cat.codes
    return x


FEATURES = ["lat", "lon", "district_code", "completion_year", "floor_count", "n_units", "total_floor_area_m2",
            "year_span", "units_per_floor", "area_per_floor", "unit_levels_max", "unit_area_mean",
            "unit_area_max", *FLAG_KEYS]


def make_model() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        max_iter=400, learning_rate=0.08, max_leaf_nodes=63, l2_regularization=1.0,
        # 不用 class_weight="balanced"：會讓磚造類機率嚴重高估（校準表 0.7–0.9 區間實際僅 32%），
        # 風險模型要的是校準過的 p_masonry，不是硬分類
        categorical_features=[FEATURES.index("district_code")], random_state=SEED)


def evaluate(x: pd.DataFrame, y: pd.Series, strata: pd.Series) -> None:
    say("## 1. 5-fold 交叉驗證（訓練集 = 已知結構建物）")
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    pred_base = pd.Series(index=y.index, dtype=object)
    pred_hgb = pd.Series(index=y.index, dtype=object)
    p_mas = pd.Series(index=y.index, dtype=float)
    for tr, te in skf.split(x, y):
        # 基準：(完成年 5 年段 × 樓層段) 多數決，該層樣本太少退回樓層段多數決
        tr_df = pd.DataFrame({"s": strata.iloc[tr], "fb": x["floor_count"].iloc[tr].map(floor_bin), "y": y.iloc[tr]})
        maj_s = tr_df.groupby("s")["y"].agg(lambda s: s.mode().iat[0] if len(s) >= 20 else None).dropna()
        maj_f = tr_df.groupby("fb")["y"].agg(lambda s: s.mode().iat[0])
        te_s, te_f = strata.iloc[te], x["floor_count"].iloc[te].map(floor_bin)
        pred_base.iloc[te] = te_s.map(maj_s).fillna(te_f.map(maj_f)).fillna("RC").values

        m = make_model().fit(x[FEATURES].iloc[tr], y.iloc[tr])
        pred_hgb.iloc[te] = m.predict(x[FEATURES].iloc[te])
        proba = pd.DataFrame(m.predict_proba(x[FEATURES].iloc[te]), columns=m.classes_)
        p_mas.iloc[te] = proba[[c for c in MASONRY if c in proba]].sum(axis=1).values

    def report(name: str, pred: pd.Series, mask: pd.Series | None = None) -> None:
        yy, pp = (y, pred) if mask is None else (y[mask], pred[mask])
        is_m, pm = yy.isin(MASONRY), pp.isin(MASONRY)
        rec = (is_m & pm).sum() / max(is_m.sum(), 1)
        prec = (is_m & pm).sum() / max(pm.sum(), 1)
        say(f"- {name}：準確率 {accuracy_score(yy, pp):.1%}、macro-F1 {f1_score(yy, pp, average='macro'):.3f}、"
            f"磚造類 召回 {rec:.1%} / 精確 {prec:.1%}（n={len(yy):,}）")

    report("分層多數決（全部）", pred_base)
    report("HistGradientBoosting（全部）", pred_hgb)
    old_low = (x["completion_year"] < 1983) & (x["floor_count"] <= 3)
    say("- 關鍵子群「1983 前、1–3 樓」（未知建物最多的一群）：")
    report("  分層多數決", pred_base, old_low)
    report("  HistGradientBoosting", pred_hgb, old_low)

    say("\n### 混淆矩陣（HGB，列=真實、欄=推估）\n")
    say(pd.crosstab(y, pred_hgb).reindex(index=CLASSES, columns=CLASSES, fill_value=0).to_markdown())

    say("\n### 機率校準：推估為磚造類的機率 vs 實際磚造類比例\n")
    cal = pd.DataFrame({"p": p_mas, "m": y.isin(MASONRY)})
    cal["bin"] = pd.cut(cal["p"], [0, .1, .3, .5, .7, .9, 1.0], include_lowest=True)
    t = cal.groupby("bin", observed=True).agg(n=("m", "size"), 平均推估機率=("p", "mean"), 實際比例=("m", "mean"))
    say(t.round(3).to_markdown())


def main() -> None:
    b = pd.read_parquet(PROC / "buildings_integrated.parquet")
    x = build_features(b)
    known = b["structure_class"].isin(CLASSES)
    y = b.loc[known, "structure_class"].reset_index(drop=True)
    xk = x[known.values].reset_index(drop=True)
    strata = xk["completion_year"].map(year_bin) + "|" + xk["floor_count"].map(floor_bin)

    say(f"- 已知結構（訓練）：{known.sum():,} 棟；待推估：{(~known).sum():,} 棟")
    say("- 訓練集類別：" + "、".join(f"{k} {v:,}" for k, v in y.value_counts().items()))

    # 選樣偏誤檢查：同一子群內，已知 vs 未知的特徵分布
    say("\n## 0. 選樣偏誤檢查（已知結構的建物多半有交易，未知的多半沒有）")
    old_low_all = (x["completion_year"] < 1983) & (x["floor_count"] <= 3)
    cmp_cols = ["floor_count", "n_units", "unit_area_mean", "unit_levels_max", "f_basement", "f_arcade", "f_rain_shelter"]
    t = pd.DataFrame({
        "已知": x.loc[old_low_all & known.values, cmp_cols].mean(),
        "未知": x.loc[old_low_all & ~known.values, cmp_cols].mean(),
    }).round(2)
    say("「1983 前、1–3 樓」子群特徵平均：\n\n" + t.to_markdown() + "\n")
    evaluate(xk, y, strata)

    # 全量訓練 → 推估未知
    model = make_model().fit(xk[FEATURES], y)
    xu = x[~known.values]
    proba = pd.DataFrame(model.predict_proba(xu[FEATURES]), columns=model.classes_, index=xu.index)
    out = b.copy()
    out["structure_pred"] = None
    out.loc[~known, "structure_pred"] = proba.idxmax(axis=1).values
    out.loc[~known, "structure_pred_prob"] = proba.max(axis=1).values
    out.loc[~known, "p_masonry"] = proba[[c for c in MASONRY if c in proba]].sum(axis=1).values
    out.loc[known, "p_masonry"] = b.loc[known, "structure_class"].isin(MASONRY).astype(float)
    # 各類別機率（已知者 one-hot），風險模型用來算「結構期望分數」，保留推估的不確定性
    for c in CLASSES:
        out[f"p_{c}"] = (b["structure_class"] == c).astype(float)
        if c in proba:
            out.loc[~known, f"p_{c}"] = proba[c].values
    # 樓層明細特徵一併輸出，風險模型的「軟弱底層」用騎樓比例
    out = out.merge(x[["bkey", "f_arcade", "f_basement", "f_elev_hall"]], on="bkey", how="left")
    out["structure_final"] = out["structure_class"].where(known, out["structure_pred"])
    out["structure_final_source"] = out["structure_source"].where(known, "推估")
    out["structure_confidence"] = np.where(known, 1.0, out["structure_pred_prob"])

    say("\n## 2. 推估結果（全量模型）")
    pu = out.loc[~known]
    say("- 推估類別分布：" + "、".join(f"{k} {v:,}" for k, v in pu["structure_pred"].value_counts().items()))
    say("- 推估信心（最大類別機率）：" + "、".join(
        f"{k} {v:,}" for k, v in pd.cut(pu["structure_pred_prob"], [0, .5, .7, .9, 1.0],
                                         labels=["<0.5", "0.5-0.7", "0.7-0.9", "≥0.9"]).value_counts().sort_index().items()))
    say("- 最終結構來源：" + "、".join(f"{k} {v:,}" for k, v in out["structure_final_source"].value_counts().items()))
    say("- 最終結構分布：" + "、".join(f"{k} {v:,}" for k, v in out["structure_final"].value_counts().items()))

    # 特徵重要度（排列重要度，抽樣以控時間）
    sample = xk.sample(min(20000, len(xk)), random_state=SEED)
    pi = permutation_importance(model, sample[FEATURES], y.loc[sample.index], n_repeats=3,
                                random_state=SEED, scoring="f1_macro")
    imp = pd.Series(pi.importances_mean, index=FEATURES).sort_values(ascending=False)
    say("\n## 3. 特徵重要度（permutation，macro-F1 下降量）\n")
    say(imp.head(10).round(4).to_frame("importance").to_markdown())

    path = PROC / "buildings_with_structure.parquet"
    out.to_parquet(path, index=False)
    say(f"\n輸出：{path.relative_to(ROOT)}（{len(out):,} 棟）")
    REPORT.write_text("# 結構推估報告（自動產生）\n\n" + "\n".join(log) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
