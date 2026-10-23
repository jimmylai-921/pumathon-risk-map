"""下載 #6 危老耐震題目會用到的公開資料到 data/raw/。

可重跑：已存在的檔案預設跳過（加 --force 重抓）。
"""
import sys
import time
import zipfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"

# (檔名, 下載網址, 說明)
SOURCES = [
    # 臺北市歷年使用執照摘要（data.gov.tw 128203，都發局/建管處，XML，民國 114 年以前）
    ("use_license.xml",
     "https://data.taipei/api/dataset/c876ff02-af2e-4eb8-bd33-d444f5052733/resource/0f3f9675-8356-4f1a-9908-1ce8892012fa/download",
     "歷年使用執照摘要"),
    # 臺北市土壤液化潛勢圖（工務局，WGS84 GeoJSON）
    ("liquefaction_wgs84.geojson",
     "https://soil.taipei/Taipei2019/Main/pages/TPLiquid_84.GeoJSON",
     "土壤液化潛勢"),
    # 臺北市各里人口數按年齡分（民政局，Big5 CSV，取最新一期）
    ("village_pop_by_age.csv",
     "https://data.taipei/api/dataset/a6394e3f-3514-4542-87bd-de4310a40db3/resource/c8f5b53d-ef3d-4321-ae8e-58cd2a5ee73c/download",
     "各里人口數按年齡分"),
    # 臺北市現有營造建築物棟數（主計處，彙總統計，只用來驗證覆蓋率）
    ("building_count_stats.csv",
     "https://tsis.dbas.gov.taipei/statis/webMain.aspx?sys=220&ymf=6500&kind=21&type=0&funid=a05019201&cycle=4&outmode=12&compmode=0&outkind=1&deflst=2&nzo=1",
     "現有營造建築物棟數"),
    # 臺北市消防通道清冊（消防局，以「里」為單位）
    ("fire_lane_list.csv",
     "https://data.taipei/api/dataset/7a800e92-eb22-461f-b29d-8def2127a1bc/resource/351307e4-ffda-4660-ac72-1c4ef3808c38/download",
     "消防通道清冊"),
    # 臺北市火災搶救困難地區場所清冊（消防局，有地址）
    ("fire_difficult_places.csv",
     "https://data.taipei/api/dataset/0f322478-e09b-46af-8019-caeaa79678d7/resource/577b3810-49b7-44fd-a5b7-97897bb50f9e/download",
     "火災搶救困難地區"),
    # 山腳斷層（臺北市 ArcGIS Portal 公開項目，soil.taipei 地圖即載入此檔，CRS84 GeoJSON）
    ("shanchiao_fault.geojson",
     "https://arcgispor.gov.taipei/portal/sharing/rest/content/items/7dab54ea35454f5fb2a1c053eaaeb315/data",
     "山腳斷層"),
    # 臺北市高氯離子混凝土建築物（海砂屋）列管清冊（建管處，115.3.25 版 PDF；data.gov.tw 128196 的 CSV 只有市有 5 筆）
    ("seasand/list_1150325.pdf",
     "https://www-ws.gov.taipei/001/Upload/845/relfile/-1/845/7e3d3798-d6ab-4f35-b720-44854dec092c.pdf",
     "海砂屋列管清冊"),
    # 內政部村里界圖（TWD97 經緯度 SHP，用來把座標落到「里」）
    ("village_boundary.zip",
     "https://www.tgos.tw/tgos/VirtualDir/Product/a04697c8-64db-450a-a105-3eb471c45abd/村(里)界(TWD97經緯度).zip",
     "村里界圖"),
]


def fetch(name: str, url: str, desc: str, force: bool) -> None:
    out = RAW / name
    if out.exists() and not force:
        print(f"[skip] {desc}: {out.name} 已存在 ({out.stat().st_size:,} bytes)")
        return
    print(f"[get ] {desc}: {url}")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".part")
    with requests.get(url, stream=True, timeout=(30, 900), headers={"User-Agent": "Mozilla/5.0"}) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.replace(out)
    print(f"       -> {out.name} ({out.stat().st_size:,} bytes)")


def fetch_lvr(force: bool) -> None:
    """實價登錄（內政部 plvr.land.moi.gov.tw）臺北市逐季 CSV：a=不動產買賣、c=租賃。

    季別代碼為民國年＋S1~S4（101S1 起）；尚未公布的季別回傳非 CSV，直接略過。
    門牌已全面去區段化（含 101 年舊資料），可直接用門牌 join。
    """
    out_dir = RAW / "lvr"
    out_dir.mkdir(parents=True, exist_ok=True)
    got = 0
    for y in range(101, 116):
        for q in range(1, 5):
            season = f"{y}S{q}"
            for kind in ("a", "c"):
                out = out_dir / f"{season}_{kind}.csv"
                if out.exists() and not force:
                    got += 1
                    continue
                url = f"https://plvr.land.moi.gov.tw/DownloadSeason?season={season}&fileName=a_lvr_land_{kind}.csv"
                try:
                    r = requests.get(url, timeout=(30, 300), headers={"User-Agent": "Mozilla/5.0"})
                except Exception as e:
                    print(f"[FAIL] 實價登錄 {season} {kind}: {e}")
                    continue
                if r.status_code != 200 or "鄉鎮市區".encode() not in r.content[:200]:
                    continue  # 該季無資料或尚未公布
                out.write_bytes(r.content)
                got += 1
                time.sleep(0.5)  # 對政府站客氣一點
    print(f"[lvr ] 實價登錄臺北市季檔共 {got} 個 -> {out_dir}")


def main() -> None:
    force = "--force" in sys.argv
    RAW.mkdir(parents=True, exist_ok=True)
    for name, url, desc in SOURCES:
        try:
            fetch(name, url, desc, force)
        except Exception as e:  # 單一來源失敗不影響其他來源
            print(f"[FAIL] {desc}: {e}")
    fetch_lvr(force)

    # 村里界解壓
    z = RAW / "village_boundary.zip"
    if z.exists():
        dest = RAW / "village_boundary"
        if not dest.exists() or force:
            with zipfile.ZipFile(z) as zf:
                zf.extractall(dest)
            print(f"[unzip] {dest}")


if __name__ == "__main__":
    main()
