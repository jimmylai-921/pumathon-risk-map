"""臺北市歷年使用執照摘要 XML → 兩張 parquet。

注意：data.taipei 這份「歷年」實際只有民國 90 年（2001）以後的使照（建管處系統自 90 年起建置），
921 前的老屋查不到結構，結構類型只能拿來校正推估模型，不能直接覆蓋老屋。

輸出：
  data/processed/use_license.parquet          一列一張使照
  data/processed/use_license_address.parquet  一列一個使照上的門牌（含樓層）
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd

from structure import classify_structure

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "raw" / "use_license.xml"
OUT_LIC = ROOT / "data" / "processed" / "use_license.parquet"
OUT_ADDR = ROOT / "data" / "processed" / "use_license_address.parquet"


def roc_to_date(s: str | None):
    s = (s or "").strip()
    if not re.fullmatch(r"\d{7}", s):
        return pd.NaT
    try:
        return pd.Timestamp(int(s[:3]) + 1911, int(s[3:5]), int(s[5:7]))
    except ValueError:
        return pd.NaT


def to_int(s: str | None):
    m = re.search(r"-?\d+", s or "")
    return int(m.group()) if m else None


def to_float(s: str | None):
    m = re.search(r"-?\d+(?:\.\d+)?", s or "")
    return float(m.group()) if m else None


def main() -> None:
    lic_rows, addr_rows = [], []
    for _, el in ET.iterparse(SRC):
        if el.tag != "Data":
            continue
        lic_no = (el.findtext("執照號碼") or "").strip()
        structure = (el.findtext("構造種類") or "").strip()
        lic_rows.append({
            "license_no": lic_no,
            "license_year_roc": to_int(el.findtext("執照年度")),
            "issue_date": roc_to_date(el.findtext("發照日期")),
            "completion_date": roc_to_date(el.findtext("竣工日期")),
            "start_date": roc_to_date(el.findtext("開工日期")),
            "build_type": (el.findtext("建造類別") or "").strip(),
            "structure_raw": structure,
            "structure_class": classify_structure(structure),
            "public_use": "供公眾使用" in structure and "非供公眾" not in structure,
            "zoning": (el.findtext("使用分區") or "").strip(),
            "buildings": to_int(el.findtext("建物資訊/棟數")),
            "floors_above": to_int(el.findtext("建物資訊/地上層數")),
            "floors_below": to_int(el.findtext("建物資訊/地下層數")),
            "households": to_int(el.findtext("建物資訊/戶數")),
            "building_area_m2": to_float(el.findtext("建物面積/建築面積")),
            "height_m": to_float(el.findtext("建物高度")),
            "lots": "|".join((x.text or "").strip() for x in el.findall("地段地號/地段號")),
        })
        for a in el.findall("建築地點/地址"):
            raw = (a.text or "").strip()
            if raw:
                addr_rows.append({"license_no": lic_no, "address_raw": raw})
        el.clear()

    lic = pd.DataFrame(lic_rows)
    addr = pd.DataFrame(addr_rows).drop_duplicates()
    OUT_LIC.parent.mkdir(parents=True, exist_ok=True)
    lic.to_parquet(OUT_LIC, index=False)
    addr.to_parquet(OUT_ADDR, index=False)
    print(f"licenses={len(lic):,} addresses={len(addr):,}")
    print(lic["structure_class"].value_counts())
    print(lic["build_type"].value_counts().head(10))
    print("發照年分布:", lic["issue_date"].dt.year.value_counts().sort_index().to_dict())


if __name__ == "__main__":
    main()
