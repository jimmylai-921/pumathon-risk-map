# pumathon｜#6 危老耐震風險評級

> 最後更新：2026-10-23
> 市政 debug 松（puma.taipei/hackathon）題目 #6「危老耐震如何查，風險評級怎麼找」。目前完成：資料整合、結構推估、風險加權模型與驗證、地圖與健檢卡前端（已部署到 Cloudflare Workers）。

## 風險模型（方向 A）

公式與權重集中在 [config/risk_weights.json](config/risk_weights.json)，Python 與之後的前端共用同一份，前端滑桿只調權重、α 與 β。

```
建物脆弱度 V' = max( 加權平均(法規時期 .35, 結構 .30, 樓層型態 .20, 軟弱底層 .15), 海砂屋覆寫 )
場址危害   H  = 加權平均(土壤液化 .7, 山腳斷層 .3)
耐震風險      = V' × (1 + αH) / (1 + α)          α = 0.5
救災社會   S  = 加權平均(里高齡比例 .5, 消防通道 .5)
優先分數      = 100 × [ (1−β)·耐震風險 + β·S ]    β = 0.25
```

- **為什麼危害用乘的：** 用加法的話，蓋在高液化區的 2015 年 SRC 大樓會排在低液化區的 1970 年加強磚造前面。改成用乘的，結構好的新建物就算在不好的土壤上，分數仍然低。
- **結構用期望分數：** 計算方式是 Σ P(類別) × 類別分數，推估的不確定性會留在分數裡，不會被硬分類掉。
- **可解釋：** 每棟都有 `c_*` 各因子的貢獻分，加總剛好等於優先分數（腳本有 assert 檢查）。例如第 1 名 88.7 分 = 法規時期 17.5 + 土壤液化 16.7 + 結構 12.8 + 消防通道 12.5 + 里高齡比例 11.7 + 樓層型態 10.0 + 軟弱底層 7.5。
- **影響戶數另列，不混進分數：** `household_impact` = 分數 × 戶數。依棟分數排的前 5% 和依影響戶數排的前 5% 只重疊 2%。前者大多是低矮的老磚屋，後者大多是大型老公寓（涵蓋 39 萬戶），兩者回答的是不同問題，由 UI 切換。
- **分級（依預設權重的百分位）：** 極高為前 5%（≥63.1）、高為 5–15%、中為 15–40%、低為其餘。極高級共 11,798 棟、24,905 戶，其中加強磚造 66%、磚造 16%。

### 驗證（沒有逐棟震損資料可對答案，所以做這四項）

| 驗證 | 結果 | 解讀 |
|---|---|---|
| 海砂屋列管建物（859 棟）在原始分數中的排名 | 只有 0.3% 落在前 10%，中位數排在前 74% | **沒通過，但這本身是發現。** 海砂屋多為 1980 年代 RC，年代和結構因子抓不到材料缺陷，所以改以覆寫方式納入。覆寫後，77% 落在前 10% |
| 權重 ±20%、α 與 β 一起擾動，跑 1,000 次 | 前 5% 名單重疊率平均 93%，最差 84%；全市排名 Spearman ≥ 0.991 | 名單對權重的選擇是穩健的 |
| 「缺完成年＝老屋」的假設 | 前 5% 中有 49% 是缺完成年的建物；把這個分數從 1.0 降到 0.8，前 5% 只剩 82.6% 重疊 | **這是目前影響最大的單一假設**，比權重擾動的影響還大，UI 必須標示 |
| 官方統計與行政區分布 | 30 年以上屋齡比例：官方 90.9%，本資料 85–87%；大同、萬華分數最高，內湖、文山最低 | 和公開認知一致 |

完整數字見 [reports/risk_model.md](reports/risk_model.md)。含地址的前 1,000 棟清單在 `data/processed/top_priority_buildings.csv`（不進版控）。

## 結論先講

- **可以 join，而且逐棟粒度成立。** 地籍資料有 1,125,315 戶，依座標歸併後是 **235,964 棟**。官方統計臺北市 114 年現有建築物 222,459 棟，數量級吻合，可以當作全市逐棟底圖。
- **不需要另外拉 OSM 或國土測繪中心的建物資料**來產生每棟的點位。地籍資料本身就有門牌座標，地圖直接畫點，縮小時改用 H3 或 hexbin 聚合即可。建物輪廓（polygon）只是視覺加分，MVP 不需要。
- **結構類型靠實價登錄補上大半。** 「臺北市歷年使用執照摘要」實際上只有民國 90 年（2001）之後的資料，單靠它只有 7.6% 的建物有結構。加入實價登錄（101S4–115S3 的買賣與租賃，共 45 萬筆）的「主要建材」後：
  - 逐棟有結構：**41.6%**（98,160 棟）；以戶數加權是 **68.5%**，2000 年前老屋的戶數覆蓋是 62.3%。
  - 同一棟兩個來源都有的 11,305 棟，結構大類一致率 **98.5%**，可以放心使用實價登錄的結構。
  - 實價登錄還附帶「建物型態」，例如公寓（5 樓含以下無電梯），可以直接標記無電梯老公寓。
  - 剩下的缺口集中在 1983 年前 1–3 樓的低矮老屋，覆蓋率只有 14.9%，因為這類房子很少交易。
- **剩下的 58.4% 用模型推估，每棟都有結構類型與信心度。** 推估方法是 HistGradientBoosting，特徵只用每棟都有的地籍欄位：完成年、樓層、面積、戶數、樓層明細關鍵字、座標。5-fold 交叉驗證的結果：
  - 準確率 **97.3%**；磚造類（磚造、加強磚造、木造／土造）召回 95.7%、精確 94.3%。
  - 「1983 年前、1–3 樓」子群準確率 92.1%，磚造類召回 98.4%。
  - 機率校準良好：推估為磚造類、機率落在 0.7–0.9 的建物，實際有 84% 是磚造類。所以風險模型可以直接把 `p_masonry` 當成機率使用。
  - 詳細數字見 [reports/structure_inference.md](reports/structure_inference.md)。

## 前端：風險地圖與「我家安全嗎？」健檢卡

前端放在 `web/`，用 vanilla JS 寫，沒有框架。工具與函式庫是 Vite 7、deck.gl 9 與 MapLibre 6。`npm run build` 產出的 `dist/` 是純靜態檔，可以直接放到任何 static hosting。

```bash
cd web && npm install && npm run dev
```

### 部署（Cloudflare Workers 靜態資產）

線上版：<https://pumathon-risk-map.jimmylai921.workers.dev/>。設定檔是 `web/wrangler.jsonc`：Worker 名稱 `pumathon-risk-map`、靜態資產目錄 `./dist`、相容日期 `2026-10-23`。wrangler 已釘在 4.149.0，放在 devDependencies。

部署前需先以有該 Worker 權限的 Cloudflare 帳號登入：

```bash
cd web && npx wrangler login
```

**正式部署：** 先跑測試，接著 build，再 `wrangler deploy`。測試沒過就不會上傳。

```bash
cd web && npm run deploy
```

**預覽：** 用 `wrangler versions upload` 上傳一個新版本，會得到一個預覽網址，正式網址不受影響。

```bash
cd web && npm run deploy:preview
```

部署前請先跑完 `scripts/` 的資料管線，讓 `web/public/data/` 是最新的資料；這個資料夾不進版控，build 時會複製進 `dist/`。

| 頁面 | 功能 |
|---|---|
| `#/map`（A：給市府） | 23.6 萬棟依分數上色，底圖是國土測繪中心通用電子地圖（灰階）。側欄有 10 個滑桿（各因子權重與 α、β），拖動時重算加重繪約 30–60 ms。可依行政區、分級篩選；排行榜能在「依棟分數」與「依影響戶數」之間切換；能匯出前 N 棟 CSV。 |
| `#/check?q=地址`（B：給市民） | 健檢卡。輸入的地址可以帶或不帶市、區與樓層，也接受郵遞區號與里名前綴（例如「106台北市大安區光武里10鄰…」），以及「1號之2」與「公館路」這類寫法。沒寫行政區時，靠路段索引只載入相關的門牌分片。查不到時會列出同路段的建議門牌。卡片最後附「下一步」：耐震初評補助、危老條例條件、海砂屋處理。 |
| `#/about` | 資料來源，每項標示「真實」或「模型推估」。 |

- **可解釋性：** 點地圖上的建物或查地址，都會列出每個因子的「原始資料 → 計分規則 → 因子分數 → 權重 → 貢獻分」，加總等於總分。也會說明場址危害是乘數加成。
- **警示：** 結構為推估值、屋齡未知、使用了自訂權重時，都會另外標示。
- **測試：** `npm test` 共 23 項，包含與 Python 的一致性測試（3 組權重 × 340 棟，最大誤差 0.0005），以及 50 個門牌正規化案例。
- **驗收：** 由獨立 agent 用瀏覽器實測，內容包含：
  - 8 棟建物的分數與 Python 結果比對，以及全市 235,964 筆欄位逐一比對，0 筆不一致；
  - 12 種 XSS payload 都沒有執行；
  - 滑桿 9 種極端組合；
  - 375px 手機寬度。

## 資料來源與 join 結果

| 來源 | 真實/模擬 | 粒度 | join 方式 | 覆蓋率（逐棟） |
|---|---|---|---|---|
| 內政部地籍圖便民查詢（自有爬取） | 真實 | 戶（含座標、完成日、總樓層） | 主表；同座標歸併為一棟 | 完成年 88.2%、樓層 98.3% |
| [臺北市歷年使用執照摘要](https://data.taipei/dataset/detail?id=c876ff02-af2e-4eb8-bd33-d444f5052733)（XML） | 真實 | 使照（多門牌） | 正規化門牌（到「號」）＋年差 ≤ 2 年＋新建 | 7.6%（僅 2001 後） |
| [實價登錄](https://plvr.land.moi.gov.tw/DownloadOpenData)（內政部，臺北市逐季 CSV，買賣＋租賃） | 真實 | 交易（門牌已完整揭露） | 正規化門牌＋完成年差 ≤ 1＋總樓層相同，逐棟多筆投票 | 38.8%（各時期 27%–59%） |
| [土壤液化潛勢圖](https://data.taipei/dataset/detail?id=ec40e067-930f-4058-b7dc-71399d5f3147)（GeoJSON） | 真實 | 多邊形 | 點落面 | 88.9%（其餘多為山區） |
| 山腳斷層（臺北市 ArcGIS Portal，soil.taipei 地圖用的同一份） | 真實 | 線 | 點到線距離（TWD97） | 100% |
| [村里界圖](https://data.gov.tw/dataset/7438)（內政部 SHP） | 真實 | 里多邊形 | 點落面 | 100%（456 里） |
| [各里人口數按年齡分](https://data.taipei/dataset/detail?id=a6394e3f-3514-4542-87bd-de4310a40db3)（115 年 9 月） | 真實 | 里 | 里代碼 | 100%（65+ 比例 15.2%–36.3%） |
| [消防通道清冊](https://data.taipei/dataset/detail?id=7a800e92-eb22-461f-b29d-8def2127a1bc) | 真實 | 巷弄文字 | 區＋路段＋巷文字比對（只有路名時限同里） | 9,395 棟落在列管巷道 |
| [火災搶救困難地區場所清冊](https://data.gov.tw/dataset/145616) | 真實 | 場所地址 | 正規化門牌 | 411 筆中 285 筆對上（69%） |
| [海砂屋列管清冊](https://www-ws.gov.taipei/001/Upload/845/relfile/-1/845/7e3d3798-d6ab-4f35-b720-44854dec092c.pdf)（建管處，115.3.25 版 PDF） | 真實 | 案件（複合門牌） | 展開複合門牌到「號」＋使照年與完成年差 ≤ 3 | 158 件中有 151 件對上；859 棟、7,099 戶 |
| [現有營造建築物棟數](https://data.taipei/dataset/detail?id=7889e8a0-a71e-44e0-95c7-2213a7db1474) | 真實 | 全市彙總 | 不 join，只用來驗證覆蓋率 | — |

完整數字見 [reports/join_report.md](reports/join_report.md)，由腳本自動產生。

### 實驗中踩到的坑（已處理）

1. **液化 `class` 的數字是反的。** 依 Soil_taipei MapServer 的 legend，`1=高潛勢、2=中、3=低`。修正後，高潛勢的建物集中在士林、中山、大同、萬華，和公開資訊一致。
2. **地籍 CSV 是 Big5，而且第 8 欄 JSON 沒有加引號。** 直接用 CSV parser 讀會被逗號切爛，所以前 7 欄用逗號切，剩下整段當成 JSON。
3. **各來源的門牌寫法不一樣。** 例如地籍寫 `1之8號`、`五段`，使照寫 `18-1號`、`五段`，消防寫 `1段`、沒有市區。統一的正規化規則寫在 `scripts/addr_norm.py`。
4. **地籍完成日有少數只寫到「年月」**（例如 `06212`），仍然保留年份。
5. **「混凝土造」字串中含有「土造」。** 結構分類必須先判斷混凝土，否則 RC 會被誤判成土造。這段邏輯寫在 `scripts/structure.py`，使照和實價登錄共用。
6. **實價登錄的總樓層是中文數字**（例如 `十三層`、`一百零一層`），門牌是全形數字，正規化時用 NFKC 處理。
7. **海砂屋清冊只有 PDF 版是完整的。** data.gov.tw 128196 的 CSV 只收錄 5 筆市有建物。PDF 有幾個問題：
   - 用 CJK 筆畫字元 `㇐` 代替「一」，NFKC 不會轉換，要另外處理。
   - 案件 32 有一層重疊的隱藏文字，抽出來是亂碼；案件 124、141 在表格抽取時漏列。這三件依頁面影像或原文人工補正，補正內容寫在 `03c_stage_seasand.py` 的 `MANUAL_*`。
   - 補正後的合計（158 件、7,424 戶）和清冊頁尾的數字一致。
8. **北投區「公舘路」的「舘」不在 Big5。** 地籍爬取資料把它寫成 `公?路`，影響 1,002 棟、3,592 戶。實價登錄則有私用區字元、`□`、「館」、「錧」等多種寫法。`addr_norm.py` 把這些寫法統一成「公舘路」，前端 `addr.js` 也有同一條規則，所以使用者輸入「公館路」也查得到。

### 已知限制

- 「一棟」是用門牌座標近似的：同棟不同號可能是多個點，同一個點也可能有多棟（6,551 個點內的完成年相差超過 2 年）。
- 消防通道的比對是文字層級，「XX 號至 XX 號」這類路段範圍目前以整條巷計，會高估。
- 使照的 `構造種類` 以「最弱的材料」歸類，例如混用 RC 與鋼骨時取 RC。
- 最終的 `structure_class` 以使照優先，沒有使照才用實價登錄。實價登錄是賣方或代理人申報的資料，雖然交叉驗證一致率 98.5%，仍屬申報資料，不是官方鑑定。
- **推估結構有選樣偏誤的風險。** 交叉驗證只能在「有交易紀錄」的建物上做，沒交易過的建物在同一年代裡通常更矮、戶數更少。在同一耐震時期內，推估群的磚造比例高於已知群（例如 1974 年前：60.5% 對 44.4%）。這方向合理，但無法直接驗證，UI 必須標示「推估」與信心度。
- **地籍缺完成年的 27,859 棟，本身就是老磚屋的訊號。** 已知樣本中這群有 88% 是磚造類，多半是早年登記、沒有填完成日的建物。風險模型目前把它們比照 1974 年前計分，這是影響名單最大的假設（見上方驗證表）。
- 山腳斷層因子的平均貢獻只有 0.2 分：臺北市只有北投一帶距斷層 1 km 以內，對其他區幾乎沒有作用。
- 海砂屋有 7 件對不上地籍，另有 5 個門牌的完成年和使照年對不上，可能已經拆除重建，因此沒有標記。

## 目錄與重跑方式

```
scripts/01_fetch_sources.py     下載公開資料與實價登錄逐季檔到 data/raw/（冪等，已存在就跳過；逾時重跑即可補抓）
scripts/02_stage_cadastral.py   地籍 CSV → data/processed/cadastral_units.parquet
scripts/03_stage_use_license.py 使照 XML → use_license*.parquet
scripts/03b_stage_lvr.py        實價登錄 CSV → lvr.parquet
scripts/03c_stage_seasand.py    海砂屋列管清冊 PDF → seasand_cases / seasand_bases.parquet（展開複合門牌）
scripts/addr_norm.py            門牌正規化（共用）
scripts/structure.py            結構文字分類（共用）
scripts/04_integrate.py         逐棟整合 → buildings_integrated.parquet + reports/join_report.md
scripts/05_infer_structure.py   推估缺結構建物 → buildings_with_structure.parquet + reports/structure_inference.md
scripts/06_risk_model.py        風險分數、貢獻分、驗證 → buildings_risk.parquet + reports/risk_model.md
scripts/07_export_web.py        匯出前端靜態資料 → web/public/data/（bin + meta + 門牌分片）＋ web/test/fixtures/parity.json
config/risk_weights.json        風險模型的權重與計分表（Python／前端共用）
web/                            地圖與健檢卡前端（vanilla JS + Vite + deck.gl + MapLibre）
```

### 前端資料契約（`web/public/data/`）

| 檔案 | 內容 |
|---|---|
| `buildings.bin.gz`（gzip 後約 3.2 MB，解壓 10.6 MB） | 欄式二進位、little-endian，預先 gzip（Cloudflare 不壓縮 octet-stream），前端以 `DecompressionStream` 解壓。因子分數以 uint16（×65535）存放，其餘欄位為代碼或整數，各欄的 offset 寫在 `meta.json` |
| `meta.json` | 欄位表、類別代碼表、里資料（含 65 歲以上人口比例與百分位）、`config/risk_weights.json` 原文、資料來源（標示真實或模型推估） |
| `addr/{區代碼}.json`（12 個分片，每片 0.7–2 MB） | 主門牌、使照號碼、海砂屋案號，以及「門牌 → 建物」對照，查詢時才載入 |

`web/test/fixtures/parity.json` 存的是 Python 算出的預期分數（3 組權重 × 340 棟），以及 47 個門牌正規化案例。前端必須通過這組一致性測試，確保 JS 與 Python 的公式和門牌規則一致。依資料量化後實測，最大誤差 0.0005，容許值 0.01。

`data/` 不進版控，因為地籍資料是獨家來源，而且體積大。

```bash
python -m venv .venv && .venv/Scripts/python -m pip install duckdb geopandas pyarrow requests pyproj tabulate scikit-learn pdfplumber
```

```bash
.venv/Scripts/python scripts/01_fetch_sources.py
```

```bash
.venv/Scripts/python scripts/02_stage_cadastral.py "<地籍匯出 CSV 路徑>"
```

```bash
cd scripts && ../.venv/Scripts/python 03_stage_use_license.py && ../.venv/Scripts/python 03b_stage_lvr.py && ../.venv/Scripts/python 03c_stage_seasand.py
```

```bash
cd scripts && ../.venv/Scripts/python 04_integrate.py && ../.venv/Scripts/python 05_infer_structure.py && ../.venv/Scripts/python 06_risk_model.py && ../.venv/Scripts/python 07_export_web.py
```

## 整合表欄位（`buildings_integrated.parquet`，235,964 列）

`bkey, lat, lon, district, addr_base, n_units, completion_year(_min/_max), floor_count, total_floor_area_m2, age_2026, code_era, license_no, lic_structure_class, lic_structure_raw, floors_above, lvr_structure_class, lvr_structure_agree, lvr_building_type, lvr_elevator, lvr_records, structure_class, structure_source, seasand_case, seasand_class, VILLCODE, TOWNNAME, VILLNAME, village_pop, village_elderly_ratio, liq_class, liq_level, fault_dist_m, fire_lane_type, fire_lane_name, in_fire_lane_list, village_has_fire_lane, fire_difficult_place, fire_difficult_item`

`buildings_with_structure.parquet` 在上述欄位之外，再加上：`structure_pred, structure_pred_prob, p_masonry, p_<各結構類別>, structure_final, structure_final_source（使照／實價登錄／推估）, structure_confidence, f_arcade, f_basement, f_elev_hall`。

`buildings_risk.parquet` 再加上：`s_*`（各因子 0–1 分數）、`V, V_final, H, S, seismic, score`、`c_*`（各因子貢獻分）、`rank, tier, household_impact, rank_household`。

## 下一步（尚未做）

1. **補缺完成年那批建物的資料。** 確認地籍爬蟲能不能抓到建物標示部的「主要建材」或完成日。這能消除目前影響最大的假設，也能驗證結構推估的選樣偏誤。
2. **Demo 防斷網**：底圖依賴外部的 `wmts.nlsc.gov.tw`，現場斷網時會只剩點位。可以考慮把臺北的底圖做成 PMTiles 放在本機，同時準備健檢卡深連結的 QR code。
3. 預設權重可以對照官方「耐震能力初步評估表」的項目再校一次（尚未查證）。
