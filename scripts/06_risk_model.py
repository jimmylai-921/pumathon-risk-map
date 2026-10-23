"""危老耐震風險加權評級模型（方向 A）。

公式與權重在 config/risk_weights.json（前端滑桿共用同一份）：
  V' = max(加權平均(法規時期, 結構, 樓層型態, 軟弱底層), 海砂屋覆寫)
  H  = 加權平均(土壤液化, 山腳斷層距離)
  耐震風險 = V' × (1 + αH) / (1 + α)        ← 危害放大脆弱度，新建好結構在爛土上仍低
  S  = 加權平均(里高齡比例, 消防通道)
  優先分數 = 100 × [(1−β)·耐震風險 + β·S]
每棟輸出各因子貢獻分（加總恰等於優先分數），影響戶數另列不混進分數。

輸入：data/processed/buildings_with_structure.parquet
輸出：data/processed/buildings_risk.parquet、data/processed/top_priority_buildings.csv、reports/risk_model.md
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
PROC = ROOT / "data" / "processed"
RAW = ROOT / "data" / "raw"
CONFIG = ROOT / "config" / "risk_weights.json"
REPORT = ROOT / "reports" / "risk_model.md"

V_KEYS = ["era", "structure", "typology", "soft_story"]
H_KEYS = ["liquefaction", "fault"]
S_KEYS = ["elderly", "fire_access"]
LABEL = {"era": "屋齡法規時期", "structure": "結構", "typology": "樓層型態", "soft_story": "軟弱底層",
         "seasand": "海砂屋列管", "liquefaction": "土壤液化", "fault": "山腳斷層",
         "elderly": "里高齡比例", "fire_access": "消防通道"}

log: list[str] = []


def say(msg: str = "") -> None:
    print(msg)
    log.append(msg)


# ---------------------------------------------------------------- 因子分數（0–1）
def factor_scores(b: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    vc, hc, sc = cfg["vulnerability"], cfg["hazard"], cfg["social"]
    f = pd.DataFrame(index=b.index)
    f["era"] = b["code_era"].map(vc["era_scores"]).fillna(vc["era_scores"]["未知"])
    # 結構期望分數：Σ P(類別) × 類別分數，推估的不確定性留在分數裡
    f["structure"] = sum(b[f"p_{c}"] * s for c, s in vc["structure_scores"].items())

    fl = b["floor_count"].astype(float).to_numpy()
    typ = np.select([np.isnan(fl), fl <= 3, fl <= 7, fl <= 12], ["未知", "1-3", "4-7", "8-12"], default="13+")
    typ = np.where((typ == "4-7") & (b["lvr_elevator"] == "有"), "4-7_有電梯", typ)
    f["typology"] = pd.Series(typ, index=b.index).map(vc["typology_scores"])

    soft = (b["f_arcade"].fillna(0) > 0) | b["lvr_building_type"].fillna("").str.startswith("店面")
    f["soft_story"] = np.where(soft, vc["soft_story_scores"]["騎樓或店面"], vc["soft_story_scores"]["無"])
    f["seasand"] = b["seasand_class"].map(vc["seasand_override"])  # NaN = 非列管

    f["liquefaction"] = b["liq_level"].fillna("圖層外").map(hc["liquefaction_scores"])
    f["fault"] = (1 - b["fault_dist_m"] / hc["fault_zero_distance_m"]).clip(0, 1)

    # 里高齡比例：以 456 里百分位數計分（同里同分）
    vil = b[["VILLCODE", "village_elderly_ratio"]].dropna().drop_duplicates("VILLCODE")
    vil["pct"] = vil["village_elderly_ratio"].rank(pct=True)
    f["elderly"] = b["VILLCODE"].map(vil.set_index("VILLCODE")["pct"]).fillna(0.5)
    fa = sc["fire_access_scores"]
    f["fire_access"] = np.select([b["in_fire_lane_list"].fillna(False).astype(bool),
                                  b["village_has_fire_lane"].fillna(False).astype(bool)],
                                 [fa["列管巷道"], fa["所在里有列管"]], default=fa["無"])
    return f.astype(float)


# ---------------------------------------------------------------- 公式
def compute(f: pd.DataFrame | dict, wv: dict, wh: dict, ws: dict, alpha: float, beta: float,
            use_seasand: bool = True, detail: bool = False):
    """f 可為 DataFrame 或 {因子: ndarray}；回傳優先分數（ndarray），detail=True 另回中間值與貢獻分。"""
    g = (lambda k: f[k].to_numpy()) if isinstance(f, pd.DataFrame) else (lambda k: f[k])
    Wv, Wh, Ws = sum(wv.values()), sum(wh.values()), sum(ws.values())
    V = sum(wv[k] * g(k) for k in V_KEYS) / Wv
    Vp = np.fmax(V, g("seasand")) if use_seasand else V  # fmax：NaN（非列管）時取 V
    H = sum(wh[k] * g(k) for k in H_KEYS) / Wh
    S = sum(ws[k] * g(k) for k in S_KEYS) / Ws
    seismic = Vp * (1 + alpha * H) / (1 + alpha)
    score = 100 * ((1 - beta) * seismic + beta * S)
    if not detail:
        return score
    # 貢獻分拆解（加總 = score）。k·V'(1+αH) = k·V' + k·V'·αH：
    #   脆弱度因子 i：k·w_i·s_i/Wv；海砂屋：k·(V'−V)；危害因子 h（場址加成）：k·V'·α·w_h·s_h/Wh；社會因子 j：100β·w_j·s_j/Ws
    k = 100 * (1 - beta) / (1 + alpha)
    c = {f"c_{key}": k * wv[key] * g(key) / Wv for key in V_KEYS}
    c["c_seasand"] = k * (Vp - V)
    c.update({f"c_{key}": k * Vp * alpha * wh[key] * g(key) / Wh for key in H_KEYS})
    c.update({f"c_{key}": 100 * beta * ws[key] * g(key) / Ws for key in S_KEYS})
    return score, {"V": V, "V_final": Vp, "H": H, "S": S, "seismic": seismic, **c}


def default_args(cfg: dict) -> tuple:
    return (cfg["vulnerability"]["weights"], cfg["hazard"]["weights"], cfg["social"]["weights"],
            cfg["alpha"], cfg["beta"])


# ---------------------------------------------------------------- 驗證
def validate_seasand(b: pd.DataFrame, f: pd.DataFrame, cfg: dict) -> None:
    say("\n## 2. 驗證一：海砂屋列管建物是否被模型排在前面")
    flagged = b["seasand_case"].notna().to_numpy()
    raw = compute(f, *default_args(cfg), use_seasand=False)
    pct = pd.Series(raw).rank(pct=True, ascending=False).to_numpy()  # 1% = 最前面
    say(f"- 列管建物 {flagged.sum():,} 棟（不含海砂屋覆寫的原始分數）：")
    for top in [0.05, 0.10, 0.25, 0.50]:
        say(f"  - 落在前 {top:.0%}：{(pct[flagged] <= top).mean():.1%}（隨機基準 {top:.0%}）")
    say(f"  - 排名百分位中位數：前 {np.median(pct[flagged]):.1%}")
    era = b.loc[flagged, "code_era"].value_counts()
    say("  - 列管建物的法規時期：" + "、".join(f"{k} {v:,}" for k, v in era.items()))
    peers = (b["code_era"] == "1983-1996（1982 修正）").to_numpy() | (b["code_era"] == "1974-1982（初版耐震）").to_numpy()
    say(f"  - 對照同為 1974–1996 的非列管建物，排名百分位中位數：前 {np.median(pct[peers & ~flagged]):.1%}")
    say("- 解讀：海砂屋多為 1980 年代 RC 公寓，模型只看年代與結構時排在中段，代表「材料缺陷」是模型其他因子"
        "抓不到的獨立資訊，因此以覆寫方式納入，而不是期待模型自己排出來。")
    final = compute(f, *default_args(cfg))
    pct2 = pd.Series(final).rank(pct=True, ascending=False).to_numpy()
    say(f"- 加入覆寫後：落在前 10% {(pct2[flagged] <= 0.10).mean():.1%}、前 25% {(pct2[flagged] <= 0.25).mean():.1%}")


def validate_sensitivity(f: pd.DataFrame, cfg: dict, base: np.ndarray) -> None:
    sc = cfg["sensitivity"]
    rng = np.random.default_rng(sc["seed"])
    p, runs, n = sc["perturb"], sc["runs"], len(base)
    say(f"\n## 3. 驗證二：權重敏感度（每個權重與 α、β 各乘上 U({1 - p:.1f}, {1 + p:.1f})，{runs:,} 次）")
    arrays = {k: f[k].to_numpy() for k in f.columns}
    wv, wh, ws, alpha, beta = default_args(cfg)
    tops = {"前 1%": int(n * 0.01), "前 5%": int(n * 0.05)}
    base_top = {k: set(np.argpartition(-base, m)[:m]) for k, m in tops.items()}
    overlap = {k: [] for k in tops}
    stay = np.zeros(n)
    base_rank = pd.Series(base).rank().to_numpy()
    rho = []
    for i in range(runs):
        jit = lambda d: {k: v * rng.uniform(1 - p, 1 + p) for k, v in d.items()}
        s = compute(arrays, jit(wv), jit(wh), jit(ws),
                    alpha * rng.uniform(1 - p, 1 + p), min(beta * rng.uniform(1 - p, 1 + p), 0.95))
        for k, m in tops.items():
            idx = np.argpartition(-s, m)[:m]
            overlap[k].append(len(base_top[k].intersection(idx)) / m)
            if k == "前 1%":
                stay[idx] += 1
        if i < 100:
            rho.append(np.corrcoef(base_rank, pd.Series(s).rank().to_numpy())[0, 1])
    for k in tops:
        o = np.array(overlap[k])
        say(f"- {k}名單與預設權重的重疊率：平均 {o.mean():.1%}、最差 5% 情境 {np.percentile(o, 5):.1%}、最差 {o.min():.1%}")
    b1 = np.array(sorted(base_top["前 1%"]))
    say(f"- 預設前 1% 的建物中，在 ≥90% 的模擬裡仍留在前 1%：{(stay[b1] / runs >= 0.9).mean():.1%}")
    say(f"- 全市排名 Spearman 相關（前 100 次）：平均 {np.mean(rho):.3f}、最低 {np.min(rho):.3f}")


def validate_unknown_era(b: pd.DataFrame, f: pd.DataFrame, cfg: dict, base: np.ndarray) -> None:
    """缺完成年的建物比照 1974 前計分，這個假設對名單的影響比權重擾動還大，單獨列出。"""
    say("\n## 4. 驗證三：「缺完成年＝老屋」假設的影響")
    unk = (b["code_era"] == "未知").to_numpy()
    n = int(len(b) * 0.05)
    base_top = set(np.argpartition(-base, n)[:n])
    say(f"- 缺完成年 {unk.sum():,} 棟（推估磚造類比例 {b.loc[unk, 'p_masonry'].mean():.0%}）；"
        f"預設（比照 1974 前＝{cfg['vulnerability']['era_scores']['未知']}）時占前 5% 的 {unk[list(base_top)].mean():.0%}")
    for v in [0.8, 0.6]:
        f2 = f.copy()
        f2.loc[unk, "era"] = v
        s = compute(f2, *default_args(cfg))
        t = np.argpartition(-s, n)[:n]
        say(f"- 改為 {v}：前 5% 名單重疊 {len(base_top & set(t)) / n:.1%}，缺完成年者占前 5% 的 {unk[t].mean():.0%}")
    say("- 解讀：這是目前影響最大的單一假設（大於權重 ±20% 擾動）。若能從地籍爬蟲補到這批建物的完成日或"
        "主要建材，名單會更可靠；在那之前 UI 應標示「屋齡未知，依推估視為老屋」。")


def validate_districts(b: pd.DataFrame, out: pd.DataFrame) -> None:
    say("\n## 5. 驗證四：與官方統計及行政區分布對照")
    st = pd.read_csv(RAW / "building_count_stats.csv")
    last = st.iloc[-1]
    tot, old = last.iloc[1], last["屋齡別/30年以上數量[棟]"]
    known = b["completion_year"].notna()
    ours = (b.loc[known, "completion_year"] <= 1995).mean()
    say(f"- 屋齡 30 年以上比例：官方 {last.iloc[0]} {old:,}/{tot:,}（{old / tot:.1%}）；"
        f"本資料（完成年 ≤1995，已知完成年者）{ours:.1%}；若缺完成年者全視為老屋 "
        f"{((b['completion_year'] <= 1995) | ~known).mean():.1%}")
    say(f"- 棟數：官方 {tot:,}、本資料 {len(b):,}（門牌座標點，可能一棟多點）")
    g = out.groupby("district").agg(
        棟數=("score", "size"), 平均分數=("score", "mean"),
        前5pct占比=("tier", lambda s: (s == "極高").mean()),
        老屋占比=("code_era", lambda s: s.isin(["1974前（無耐震設計規定）", "未知"]).mean()),
        高液化占比=("liq_level", lambda s: (s == "高").mean()),
        影響戶數加權=("household_impact", "sum"),
    ).sort_values("平均分數", ascending=False)
    say("\n" + g.round(3).to_markdown() + "\n")


# ---------------------------------------------------------------- 主程式
def main() -> None:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    b = pd.read_parquet(PROC / "buildings_with_structure.parquet")
    f = factor_scores(b, cfg)
    score, d = compute(f, *default_args(cfg), detail=True)

    out = b.copy()
    for k in f.columns:
        out[f"s_{k}"] = f[k].to_numpy()
    for k, v in d.items():
        out[k] = v
    out["score"] = score
    gap = np.abs(out[[c for c in out.columns if c.startswith("c_")]].sum(axis=1) - out["score"]).max()
    assert gap < 1e-6, f"貢獻分加總與分數不符：{gap}"
    out["rank"] = out["score"].rank(ascending=False, method="min").astype(int)
    pct = out["score"].rank(pct=True, ascending=False)
    out["tier"] = np.select([pct <= 0.05, pct <= 0.15, pct <= 0.40], ["極高", "高", "中"], default="低")
    # 影響戶數另列：分數 × 戶數，供「依影響戶數排序」切換，不混進棟風險分數
    out["household_impact"] = out["score"] / 100 * out["n_units"]
    out["rank_household"] = out["household_impact"].rank(ascending=False, method="min").astype(int)

    say("## 1. 分數分布（預設權重）")
    say(f"- 建物 {len(out):,} 棟；分數 平均 {out['score'].mean():.1f}、中位數 {out['score'].median():.1f}、"
        f"最高 {out['score'].max():.1f}、最低 {out['score'].min():.1f}")
    th = out.groupby("tier")["score"].min()
    say(f"- 分級（依預設權重百分位）：極高＝前 5%（≥{th['極高']:.1f}）、高＝5–15%（≥{th['高']:.1f}）、"
        f"中＝15–40%（≥{th['中']:.1f}）、低＝其餘")
    top = out[out["tier"] == "極高"]
    say(f"- 極高級 {len(top):,} 棟：涵蓋 {int(top['n_units'].sum()):,} 戶；" + "、".join(
        f"{k} {v:.0%}" for k, v in top["structure_final"].value_counts(normalize=True).head(4).items()))
    say("  - 法規時期：" + "、".join(f"{k} {v:.0%}" for k, v in top["code_era"].value_counts(normalize=True).head(4).items()))
    say(f"  - 結構為推估值：{(top['structure_final_source'] == '推估').mean():.0%}（推估信心中位數 "
        f"{top.loc[top['structure_final_source'] == '推估', 'structure_confidence'].median():.2f}）")
    ct = [c for c in out.columns if c.startswith("c_")]
    say("- 極高級平均因子貢獻分：" + "、".join(
        f"{LABEL[c[2:]]} {top[c].mean():.1f}" for c in sorted(ct, key=lambda c: -top[c].mean())))
    hh = out.nsmallest(int(len(out) * 0.05), "rank_household")
    both = len(set(hh.index) & set(top.index)) / len(top)
    say(f"- 依影響戶數排序的前 5% 與依棟分數的前 5% 重疊 {both:.0%}：前者涵蓋 {int(hh['n_units'].sum()):,} 戶，"
        "兩種排序回答不同問題（哪棟最危險 vs 健檢一棟能保護最多戶），由 UI 切換")

    validate_seasand(b, f, cfg)
    validate_sensitivity(f, cfg, score)
    validate_unknown_era(b, f, cfg, score)
    validate_districts(b, out)

    path = PROC / "buildings_risk.parquet"
    out.to_parquet(path, index=False)
    cols = ["rank", "score", "tier", "addr_base", "district", "VILLNAME", "completion_year", "floor_count",
            "n_units", "structure_final", "structure_final_source", "structure_confidence", "liq_level",
            "fault_dist_m", "seasand_class", *ct, "household_impact", "rank_household"]
    out.sort_values("rank").head(1000)[cols].to_csv(PROC / "top_priority_buildings.csv", index=False, encoding="utf-8-sig")
    say(f"\n輸出：{path.relative_to(ROOT)}；前 1,000 棟清單 data/processed/top_priority_buildings.csv（含地址，不進版控）")
    REPORT.write_text("# 危老耐震風險模型報告（自動產生）\n\n參數：`config/risk_weights.json`\n\n"
                      + "\n".join(log) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
