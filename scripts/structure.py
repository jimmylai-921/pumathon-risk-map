"""結構（構造種類／主要建材）自由文字 → 耐震上有意義的大類。使照與實價登錄共用。"""


def classify_structure(s: str | None) -> str:
    """混用多種材料時取最弱的一種；無法判讀（如「見使用執照」）回傳「未知」。"""
    s = s.strip() if isinstance(s, str) else ""
    if not s or "見" in s:
        return "未知"
    if "磚" in s and "加強" not in s:
        return "磚造"
    if "加強磚" in s:
        return "加強磚造"
    # 混凝土要先判斷，否則「混凝土造」會被「土造」吃掉
    if "RC" in s or "混凝土" in s:
        if "鋼骨" in s and not ("RC造、" in s or "、RC" in s):
            return "SRC"
        return "RC"
    if "木" in s or "土造" in s:
        return "木造/土造"
    if "鋼" in s:
        return "鋼構"
    return "其他"
