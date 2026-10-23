"""臺北市高氯離子混凝土建築物（海砂屋）列管清冊 PDF → 案件表＋展開門牌表。

來源：建管處「臺北市高氯離子混凝土建築物善後處理自治條例列管清冊」（data/raw/seasand/list_1150325.pdf）
地點欄是複合門牌，例如「永吉路：328號、330號1至14樓、326巷3之1號1樓至3之1號14樓」
「安泰街45巷2至12（雙）號、47巷1至8號（全）、3之1」，需展開成逐「號」才能 join 地籍。
輸出：data/processed/seasand_cases.parquet、seasand_bases.parquet（case_no, base）
"""
import re
import unicodedata
from pathlib import Path

import pandas as pd
import pdfplumber

from addr_norm import _cn_to_int

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "raw" / "seasand" / "list_1150325.pdf"
OUT_CASES = ROOT / "data" / "processed" / "seasand_cases.parquet"
OUT_BASES = ROOT / "data" / "processed" / "seasand_bases.parquet"

# PDF 表格抽取失敗的案件，人工依清冊原文補正（115.3.25 版）
#   32：p.4 有重疊的隱藏文字層，抽出亂碼，依頁面影像判讀
#   124、141：p.10–11 表格抽取漏列，依 extract_text 原文
MANUAL_LOCATION = {
    32: "東湖路113巷95弄85至145號(單號)",
    124: "康樂街72巷17弄41、43號",
    141: "前港街58巷1弄2、4、6、8、10號及劍潭路55巷17弄2、6、8、10、12號",
}
MANUAL_FIELDS = {
    124: {"行政區": "內湖區", "使照號碼": "073-1119", "列管戶數": "10", "列管分類": "須拆除重建"},
    141: {"行政區": "士林區", "使照號碼": "069-0783", "列管戶數": "50", "列管分類": "須拆除重建"},
}

COLS = ["序號", "行政區", "地點", "使照號碼", "列管戶數", "鑑定結果", "詳細處理情形", "列管分類", "起造人", "監造人", "承造人"]
_ROAD = r"[一-鿿]+?(?:路|街|大道)(?:\d+段)?"


def clean(s: str | None) -> str:
    s = (s or "").replace("㇐", "一")  # PDF 用 CJK 筆畫字元代替「一」，NFKC 不會轉
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+", "", s)


def read_cases() -> pd.DataFrame:
    rows = []
    with pdfplumber.open(SRC) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for r in table:
                    if not r or len(r) != len(COLS):
                        continue
                    r = [clean(x) for x in r]
                    if r[0].isdigit():
                        rows.append(r)
                    elif rows and r[0] == "" and any(r[1:]):
                        # 跨頁延續列：把文字接回上一筆
                        rows[-1] = [a + b for a, b in zip(rows[-1], r)]
    df = pd.DataFrame(rows, columns=COLS)
    df["序號"] = df["序號"].astype(int)
    for n, fields in MANUAL_FIELDS.items():
        for k, v in fields.items():
            df.loc[df["序號"] == n, k] = v
    for n, loc in MANUAL_LOCATION.items():
        df.loc[df["序號"] == n, "地點"] = loc
    df["列管戶數"] = pd.to_numeric(df["列管戶數"], errors="coerce")
    df["license_roc_year"] = pd.to_numeric(df["使照號碼"].str[:3], errors="coerce")
    return df


def expand_location(loc: str) -> list[str]:
    """複合門牌 → ['永吉路328號', '永吉路326巷3-1號', ...]（不含市區，樓層丟棄）。"""
    s = re.sub(r"([一二三四五六七八九十]+)段", lambda m: _cn_to_int(m.group(1)) + "段", loc)
    s = s.replace("(全)", "")
    # 「…14樓虎林街:66巷…」換路時沒有分隔符：在「樓/號」與「路名:」之間補一個頓號
    s = re.sub(r"(?<=[樓號])(?=[一-鿿]{1,6}?(?:路|街|大道)(?:\d+段)?[:：])", "、", s)
    out: list[str] = []
    road = lane = alley = None
    for item in re.split(r"[、,，;；]|及|和", s):
        if not item:
            continue
        # 「永吉路:328號」：路名後可能帶冒號
        m = re.match(r"(" + _ROAD + r")[:：]?", item)
        if m:
            road, lane, alley = m.group(1), None, None
            item = item[m.end():]
        m = re.match(r"(\d+)巷", item)
        if m:
            lane, alley = m.group(1), None
            item = item[m.end():]
        m = re.match(r"(\d+)弄", item)
        if m:
            alley = m.group(1)
            item = item[m.end():]
        if not road:
            continue
        # 「(雙)」「(單)」「(雙號)」「(單號)」都表示只取同奇偶的號
        parity = 2 if re.search(r"\((?:單|雙)號?\)", item) else 1
        item = re.sub(r"\((?:單|雙)號?\)", "", item)
        m = re.match(r"(\d+)(?:之(\d+))?", item)
        if not m:
            continue
        rest = item[m.end():]
        nums: list[str]
        rng = re.match(r"至(\d+)(?:之\d+)?(號|樓)?", rest)
        if rng and rng.group(2) != "樓" and not m.group(2):
            a, b = int(m.group(1)), int(rng.group(1))
            if b < a or b - a > 200:  # 不合理的範圍當成單號
                nums = [m.group(1)]
            else:
                nums = [str(n) for n in range(a, b + 1, parity)]
        elif rng and rng.group(2) == "樓" and not rest.startswith("號"):
            # 「12至14樓」這種純樓層片段，沿用前一個號，不產生新門牌
            continue
        else:
            nums = [m.group(1) + (f"-{m.group(2)}" if m.group(2) else "")]
        prefix = road + (f"{lane}巷" if lane else "") + (f"{alley}弄" if alley else "")
        out += [f"{prefix}{n}號" for n in nums]
    return list(dict.fromkeys(out))


def main() -> None:
    cases = read_cases()
    bases = []
    for _, r in cases.iterrows():
        for street in expand_location(r["地點"]):
            bases.append({"case_no": r["序號"], "base": f"台北市{r['行政區']}{street}"})
    bases = pd.DataFrame(bases)
    cases = cases.rename(columns={"序號": "case_no"})
    OUT_CASES.parent.mkdir(parents=True, exist_ok=True)
    cases.to_parquet(OUT_CASES, index=False)
    bases.to_parquet(OUT_BASES, index=False)
    print(f"案件 {len(cases)} 件（列管戶數合計 {int(cases['列管戶數'].sum()):,}）；展開門牌 {len(bases):,} 個")
    print("列管分類：", cases["列管分類"].value_counts().to_dict())
    no_addr = sorted(set(cases["case_no"]) - set(bases["case_no"]))
    print(f"無法展開門牌的案件：{len(no_addr)}", cases.loc[cases["case_no"].isin(no_addr), "地點"].tolist()[:10])


if __name__ == "__main__":
    main()
