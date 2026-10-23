"""地籍圖便民查詢爬取資料（Big5、無 header、第 8 欄為未加引號的 JSON）→ parquet。

輸入：AddressExport*.csv（路徑由參數指定，預設 ~/Downloads/AddressExport20261023.csv）
輸出：data/processed/cadastral_units.parquet（一列一個建號/門牌單位）
"""
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed" / "cadastral_units.parquet"
DEFAULT_SRC = Path.home() / "Downloads" / "AddressExport20261023.csv"

COLS = ["id", "lat", "lon", "address", "building_area", "completion_date_roc",
        "floor_count", "floor_details"]


def parse_line(line: str):
    # 前 7 欄以逗號切，剩下整段是 JSON（內含逗號）
    parts = line.rstrip("\r\n").split(",", 7)
    if len(parts) < 8:
        parts += [""] * (8 - len(parts))
    return parts


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    rows, bad = [], 0
    with open(src, encoding="cp950", errors="replace") as f:
        for line in f:
            p = parse_line(line)
            if not p[0].strip().isdigit():
                bad += 1
                continue
            rows.append(p)
    df = pd.DataFrame(rows, columns=COLS)
    df["id"] = df["id"].astype("int64")
    for c in ["lat", "lon", "building_area"]:
        df[c] = pd.to_numeric(df[c].str.strip(), errors="coerce")
    df["floor_count"] = pd.to_numeric(df["floor_count"].str.strip(), errors="coerce").astype("Int16")
    df["completion_date_roc"] = df["completion_date_roc"].str.strip()

    # 民國 yyyMMdd → 西元日期；民國年固定 3 碼含前導 0（如 0560615）
    # 少數只有 yyyMM（如 06212）或 yyyMMd，年份仍可取前 3 碼
    d = df["completion_date_roc"]
    has_year = d.str.fullmatch(r"\d{5,7}")
    roc_y = pd.to_numeric(d.str[:3].where(has_year), errors="coerce")
    roc_y = roc_y.where(roc_y > 0)
    df["completion_year"] = (roc_y + 1911).astype("Int16")
    full = d.str.fullmatch(r"\d{7}")
    df["completion_date"] = pd.to_datetime(
        (roc_y + 1911).astype("Int64").astype("string") + d.str[3:7].where(full),
        format="%Y%m%d", errors="coerce")

    # 樓層明細 JSON：轉成 key 清單以便後續判斷「平臺/騎樓/陽臺」等附屬
    def keys(s: str):
        try:
            return list(json.loads(s).keys()) if s else []
        except Exception:
            return None
    df["floor_detail_keys"] = df["floor_details"].map(keys)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    print(f"rows={len(df):,} bad_lines={bad} -> {OUT}")
    print(df.head(3).T)
    print("缺座標:", df["lat"].isna().sum(), " 缺完成日:", df["completion_year"].isna().sum(),
          " 缺樓層數:", df["floor_count"].isna().sum(), " JSON 解析失敗:", df["floor_detail_keys"].isna().sum())


if __name__ == "__main__":
    main()
