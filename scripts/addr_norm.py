"""門牌地址正規化（向量化，給 pandas Series 用）。

各來源寫法差異：
  地籍：台北市士林區下樹林街1之8號、5樓之2、中山北路五段
  使照：臺北市文山區仙岩路18-1號 2樓、B1樓
  消防：忠孝東路1段12號（無市、區，區由行政區編號補）
統一成：台北市 + 區 + 路街(段用阿拉伯數字) + 巷弄 + 號(之用 -) ，樓層另欄。
"""
import re
import unicodedata

import pandas as pd

_CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def _cn_to_int(s: str) -> str:
    # 段數只會到十幾，處理「十」「十一」「二十」即可
    if s.isdigit():
        return s
    if s == "十":
        return "10"
    if s.startswith("十"):
        return str(10 + _CN_NUM[s[1]])
    if s.endswith("十"):
        return str(_CN_NUM[s[0]] * 10)
    if "十" in s:
        a, b = s.split("十")
        return str(_CN_NUM[a] * 10 + _CN_NUM[b])
    return str(_CN_NUM.get(s, s))


def normalize(s: pd.Series) -> pd.DataFrame:
    """回傳 DataFrame：district, base（到「號」為止，含市區）, floor（號之後）。"""
    x = s.fillna("").map(lambda v: unicodedata.normalize("NFKC", v))
    x = x.str.replace(r"\s+", "", regex=True).str.replace("臺", "台", regex=False)
    # 去掉「XX里X鄰」「X鄰」
    x = x.str.replace(r"[一-鿿]{1,3}里\d+鄰", "", regex=True)
    x = x.str.replace(r"(?<=區)\d+鄰", "", regex=True)
    # 段：中文數字 → 阿拉伯數字
    x = x.str.replace(r"([一二三四五六七八九十]+)段", lambda m: _cn_to_int(m.group(1)) + "段", regex=True)
    # 號的「之」：18之1號 → 18-1號；巷/弄的「之」同理
    x = x.str.replace(r"(\d+)之(\d+)(?=[號巷弄])", r"\1-\2", regex=True)

    m = x.str.extract(r"^(?:台北市)?(?P<district>[一-鿿]{2}區)?(?P<street>.*?\d+(?:-\d+)?號)(?P<floor>.*)$")
    out = pd.DataFrame(index=s.index)
    out["district"] = m["district"]
    out["street_no"] = m["street"]
    out["base"] = ("台北市" + m["district"].fillna("") + m["street"]).where(m["street"].notna())
    out["floor"] = m["floor"].fillna("")
    return out


if __name__ == "__main__":
    demo = pd.Series([
        "台北市士林區下樹林街1之8號",
        "臺北市文山區仙岩路18-1號 2樓",
        "臺北市松山區南京東路五段251巷22弄28號 2樓",
        "台北市士林區中山北路五段618號5樓之2",
        "臺北市大安區仁愛路三段24巷1-1號 2樓",
        "忠孝東路1段12號",
        "臺北市中山區民權東路十二段3號",
    ])
    print(normalize(demo).to_string())
