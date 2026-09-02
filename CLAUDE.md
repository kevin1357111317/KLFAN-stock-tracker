# KLFAN 投資追蹤台帳 — 專案交接

> 這份是給接手的 AI／工程師看的。前一段開發在 Claude Cowork 完成，
> 程式碼、資料庫、報價來源都已經是可運作狀態。**先讀完這份再動手。**

## 這是什麼

Kevin 的個人投資組合追蹤 App。輸入是他從 2019 年至今的完整股票交易紀錄，
輸出是每一檔的**年化報酬率（XIRR）**、損益、完整進出明細，台股／美股分開統計，
可以隨時新增買賣並自動重算。

原始資料來自他的 Google 試算表「KLFAN_管理」，已經全部匯進 Supabase。

## 目前狀態：可用

- 已發布：`https://claude.ai/code/artifact/b6b9ec65-f527-410a-b026-4a13c8d42571`
- 39 檔標的、1,480 筆交易、822 天匯率，全部在 Supabase
- 即時股價與匯率會自動更新
- 手機可開，資料跨裝置同步

---

## 資源清單

| 資源 | 識別碼 |
|---|---|
| Supabase 專案 | `gbxsnwqbjmgfikpblyot`（ap-northeast-1, PG17） |
| 即時報價試算表 | `1ns4IMViBeJkfRBxeWM9n3vwNnu26LkwcBh64DfiuNx0`（KLFAN_即時報價） |
| 原始資料試算表 | `1Qqz2uXBhUsKQGrzxMaZfdTOrDL8dr_Ro9eXV71uyyZk`（KLFAN_管理） |
| 已發布頁面 | Artifact `b6b9ec65-f527-410a-b026-4a13c8d42571` |

---

## 檔案

| 檔案 | 說明 |
|---|---|
| `app.js` | 全部邏輯：XIRR、資料庫存取、報價、UI 渲染。約 1,100 行，無框架、無相依套件 |
| `app.css` | 樣式，含深色模式 |
| `build.py` | `python3 build.py` → 產生 `klfan_app.html` |
| `klfan_app.html` | 建置產物（發布用，是「片段」格式，無 doctype） |
| `klfan_app_full.html` | 建置產物（本機預覽用，有完整外層） |

改 `app.js` / `app.css` → 跑 `build.py` → 重新發布 `klfan_app.html`。

---

## 資料庫

```sql
klfan_stocks       (key PK, display, market '台股'|'美股', currency 'TWD'|'USD',
                    symbol, manual_price, created_at)
klfan_transactions (id PK, stock_key FK→klfan_stocks, tx_date, amount, shares,
                    bank, kind 'trade'|'dividend', note)
klfan_fx_daily     (fx_date PK, rate)     -- USD/TWD 每日收盤
```

三張表都 **enable RLS 且沒有任何 policy**。目前只透過 MCP 連接器的管理 API 存取，
所以擋掉 anon 是對的；**如果改成用 anon key 直連，記得要先補 policy，否則什麼都讀不到。**

### 金額符號約定（動任何計算前先確認你懂這個）

`amount` 一律是**現金流**：

| 情境 | amount | shares |
|---|---|---|
| 買進 | 負 | 正 |
| 賣出 | 正 | 負 |
| 股息 | 正 | 0 |

所有算法都建立在這個約定上。

---

## 核心算法

### 累計淨投入
```
淨投入 = -Σ(所有現金流，含股息) = 買進支出 − 賣出回收 − 已收股息
```
已獲利出場的標的這個值會是負的（拿回來比投入多），**這是正確的，不要「修正」它。**

### 累計損益
```
損益 = 目前市值 − 累計淨投入 = Σ(所有現金流) + 目前市值
```

### 年化報酬（XIRR）
所有交易現金流 + 一筆「今天以目前市值全部賣出」的虛擬現金流，求 NPV = 0 的折現率。
用**二分法**求解（`app.js` 的 `xirr()`），比 Newton 法穩定；無解回傳 `null`，UI 顯示「—」。

### 匯率（最容易搞錯的地方）

| 用途 | 用哪個匯率 | 在哪裡算 |
|---|---|---|
| 歷史買賣／股息換算台幣 | **該筆交易當日**匯率（查 `klfan_fx_daily`） | **SQL 端** |
| 目前市值換算台幣 | **即時匯率**（GOOGLEFINANCE） | JS 端 |

交易資料從 SQL 回來時，每筆已經附帶換算好的 `tw` 欄位，JS 不再做歷史換算。

---

## 驗證基準（改完一定要對這三個數字）

| 指標 | 應為 |
|---|---|
| 台股累計淨投入 | `5,941,515` |
| 美股累計淨投入（台幣） | `15,150,371` |
| 合計 | `21,091,886` |

這三個數字與 Kevin 原 Excel 完全一致。個股 XIRR 也已逐一比對過：
VOO 23.9%、台積電 27.5%、聯發科 58.7%、QQQ 30.0%、SOXX 37.4%、DRAM 260%、00631L 235%。

**改動任何計算邏輯後，用這些數字回歸驗證。**

---

## 部署方式（重要，跟一般網站不一樣）

目前是 Claude Artifact，頁面透過 `mcp` capability 呼叫**使用者自己的**連接器，
所以頁面原始碼裡沒有任何金鑰：

```
capabilities: {
  mcp: { servers: [
    { server: "Supabase",     tools: ["execute_sql"] },
    { server: "Google Drive", tools: ["download_file_content"] }
  ]}
}
```

### Artifact 的硬限制

1. **不能對任何外部網域發 fetch/XHR**（CSP）。
   這就是為什麼報價要繞 Google 試算表，而不能直接打 Fugle 或任何行情 API。
2. **連接器回應有大小上限。** 一次回 135KB 會被截斷 → JSON 解析失敗。
   交易資料因此改成每頁 400 筆分頁載入（每頁約 26KB）。
3. 頁面自己不能存資料，所有寫入都要走 Supabase。

---

## 即時報價

Google 試算表「KLFAN_即時報價」，兩欄 `symbol,price`，每列一個 GOOGLEFINANCE 公式，
外加 `CURRENCY:USDTWD`（即時匯率）與 `_UPDATED`（時間戳）。

App 用 `download_file_content`（`exportMimeType: text/csv`）讀取後 base64 解碼解析。

> **`read_file_content` 對這張表會回空白**（公式格的計算值讀不到），
> 一定要用 `download_file_content` 匯出 CSV。

代碼對應的坑：
- 台股要加 `TPE:` 前綴（`TPE:2330`、`TPE:0050`）
- `DRAM` 必須是 **`BATS:DRAM`**；裸寫 `DRAM` 會抓到歐洲一檔完全不同的 ETF（價差十倍）
- `MUU` / `MVLL` / `SPCX` 不加前綴才抓得到
- **新增標的後要把 symbol 加進這張試算表**，否則沒有即時價

---

## 已知的坑

1. **Kevin 原 Excel「股票總表」的美股彙總是壞的。**
   `M4` 公式抓 `VOO!J4+QQQ!J4+SOXX!J4+DRAM!J4`，但各工作表的 `J4` 是「目前持股股數」，
   市值在 `J6`。所以那張表的美股目前市值／累計損益／XIRR 三格不能當基準（台股那三格是對的）。
   **不要拿那三個數字去「校正」這個 App。**

2. **不要從各個股工作表分別抓資料。** 我一開始這樣做，發現有幾張表混入了多餘的列，
   加總對不上。正確來源是「股票總表」工作表（它自己就是全部個股的彙整）。

3. `0050` 這類代號在 CSV 匯入 Google 試算表時前導零會被吃掉（變成 `50`），
   所以報價表用 `symbol` 當 key，不用代號。

4. Fugle API：Kevin 有金鑰，但 Artifact 的 CSP 擋死了，Cowork 沙箱的對外連線也不通。
   **離開 Artifact 之後（例如搬到 Vercel）就可行了。**

---

## 待辦（Kevin 提過但還沒做）

- 已實現／未實現損益拆開（目前合在一起算）
- 券商別分析（國泰 913 筆、中信 328、元大 127、凱基 112）
- 走勢圖（注意：**沒有歷史股價資料**，不要編造；要嘛接行情 API，要嘛只畫現金流累積）

## 如果要搬離 Artifact（例如 Vercel）

1. 資料層：`execute_sql` 經連接器 → 改成 Supabase JS client + anon key，
   並為三張表補 RLS policy。
2. 報價層：讀 Google 試算表 → 可以直接打 Fugle（CSP 限制消失了）。
3. 這時候 `app.js` 的 UI 與計算邏輯可以整段沿用，只需要換掉資料存取那一層
   （集中在 `sql()` / `loadFromDb()` / `mutate()` 三個函式，以及 `initLive` 那段報價）。
