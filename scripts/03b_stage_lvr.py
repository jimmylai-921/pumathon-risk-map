"""實價登錄臺北市季檔（買賣 a、租賃 c）→ data/processed/lvr.parquet。

用途：補「主要建材」（結構）與「建物型態／電梯」，涵蓋 921 前老屋（使照只有 2001 後）。
一列一筆交易，保留全部紀錄，逐棟彙整（投票）在 04_integrate.py 做。
"""
import re
from pathlib import Path

import pandas as pd

from addr_norm import normalize
from structure import classify_structure

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "raw" / "lvr"
OUT = ROOT / "data" / "processed" / "lvr.parquet"

_CN = {"零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn_floor(s) -> float:
    """「十三層」「二十三層」「一百零一層」→ 數字；無法解析回傳 NaN。"""
    if not isinstance(s, str):
        return float("nan")
    s = s.strip().replace("層", "")
    if s.isdigit():
        return float(s)
    total, num = 0, 0
    for ch in s:
        if ch in _CN:
            num = _CN[ch]
        elif ch == "百":
            total += (num or 1) * 100
            num = 0
        elif ch == "十":
            total += (num or 1) * 10
            num = 0
        else:
            return float("nan")
    return float(total + num) if (total + num) > 0 else float("nan")


def roc_year(s) -> float:
    """建築完成年月：多為 7 碼 yyyMMdd，少數 6 碼（民國 100 年前省略前導 0）。"""
    s = str(s).strip() if pd.notna(s) else ""
    s = re.sub(r"\D", "", s)
    if len(s) == 7:
        y = int(s[:3])
    elif len(s) == 6:
        y = int(s[:2])
    else:
        return float("nan")
    return float(y + 1911) if 0 < y < 200 else float("nan")


def load_one(path: Path) -> pd.DataFrame:
    season, kind = path.stem.split("_")
    # 第 2 列是英文欄名，跳過
    df = pd.read_csv(path, skiprows=[1], dtype=str, encoding="utf-8-sig")
    date_col = "交易年月日" if kind == "a" else "租賃年月日"
    elev_col = "電梯" if "電梯" in df.columns else ("有無電梯" if "有無電梯" in df.columns else None)
    return pd.DataFrame({
        "source": "買賣" if kind == "a" else "租賃",
        "season": season,
        "record_no": df.get("編號"),
        "target": df["交易標的"],
        "address_raw": df["土地位置建物門牌"],
        "trade_date_roc": df[date_col],
        "total_floors_raw": df["總樓層數"],
        "building_type": df["建物型態"],
        "main_use": df["主要用途"],
        "structure_raw": df["主要建材"],
        "completion_raw": df["建築完成年月"],
        "elevator": df[elev_col] if elev_col else None,
    })


def main() -> None:
    files = sorted(SRC.glob("*_[ac].csv"))
    df = pd.concat([load_one(f) for f in files], ignore_index=True)
    n_all = len(df)
    # 純土地交易沒有建物資訊
    df = df[df["target"] != "土地"].copy()
    df = df.join(normalize(df["address_raw"]))
    df["total_floors"] = df["total_floors_raw"].map(cn_floor).astype("Float64")
    df["completion_year"] = df["completion_raw"].map(roc_year).astype("Float64")
    df["structure_class"] = df["structure_raw"].map(classify_structure)
    df = df.drop_duplicates(["source", "record_no"]) if df["record_no"].notna().all() else df

    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    print(f"季檔 {len(files)} 個；總列 {n_all:,}，含建物 {len(df):,} -> {OUT}")
    print("來源：", df["source"].value_counts().to_dict())
    print("季別範圍：", df["season"].min(), "~", df["season"].max())
    print("門牌可解析到號：", f"{df['base'].notna().mean():.1%}")
    print("總樓層可解析：", f"{df['total_floors'].notna().mean():.1%}",
          " 完成年可解析：", f"{df['completion_year'].notna().mean():.1%}")
    print(df["structure_class"].value_counts().to_dict())
    print(df["building_type"].value_counts().head(10).to_dict())


if __name__ == "__main__":
    main()
