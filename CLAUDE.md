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
| 報價 Edge Function | `refresh-klfan-quotes`（Fugle + Twelve Data → `klfan_quotes`） |
| 舊的報價試算表 | `1ns4IMViBeJkfRBxeWM9n3vwNnu26LkwcBh64DfiuNx0`（KLFAN_即時報價，**已不再使用**） |
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
| `supabase/functions/refresh-klfan-quotes/` | 報價 Edge Function 原始碼 |
| `supabase/migrations/*.sql` | 報價那一套的 schema（表、view、觸發用的函式） |

改 `app.js` / `app.css` → 跑 `build.py` → 重新發布 `klfan_app.html`。

---

## 資料庫

```sql
klfan_stocks       (key PK, display, market '台股'|'美股', currency 'TWD'|'USD',
                    symbol, manual_price, created_at)
klfan_transactions (id PK, stock_key FK→klfan_stocks, tx_date, amount, shares,
                    bank, kind 'trade'|'dividend', note)
klfan_fx_daily     (fx_date PK, rate)     -- USD/TWD 每日收盤
klfan_quotes       (symbol PK, price, currency, change, change_percent,
                    source 'fugle'|'twelve_data', quoted_at, updated_at)
klfan_live_symbols (view) -- 仍持有的 symbol，報價只抓這些
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

**多根問題（2026/09/02 修）**：現金流方向變號超過一次時 NPV 可能有多個根，
直接在 `[-1, 1000]` 兩端試正負號會漏掉 —— 兩端同號不代表無解，可能是中間穿過去又穿回來。
實際踩到：AMSC 改列美股後，它那筆「一週內獲利出場」變成美股桶最早的現金流，
NPV 在高折現率端翻回正的，整個美股 XIRR 直接變成「—」。
現在改成**先在折現率網格上找第一個變號區間，再在那個小區間裡二分**，取最小的根。
單根時與原本做法結果完全相同（已用 39 檔標的的台幣與原幣現金流、以及三個市場別回歸驗證）。

### 匯率（最容易搞錯的地方）

| 用途 | 用哪個匯率 | 在哪裡算 |
|---|---|---|
| 歷史買賣／股息換算台幣 | **該筆交易當日**匯率（查 `klfan_fx_daily`） | **SQL 端** |
| 目前市值換算台幣 | **即時匯率**（Twelve Data，存在 `klfan_quotes` 的 `USD/TWD` 那一列） | JS 端 |

交易資料從 SQL 回來時，每筆已經附帶換算好的 `tw` 欄位，JS 不再做歷史換算。

---

## 驗證基準（改完一定要對這三個數字）

| 指標 | 應為 |
|---|---|
| 台股累計淨投入 | `5,990,435` |
| 美股累計淨投入（台幣） | `15,101,451` |
| 合計 | `21,091,886` |

> 2026/09/02 起的數字。AMSC 的 `market` 從「台股」改成「美股」後，
> 那筆 +48,920 的已實現獲利換了桶子，台股／美股兩格因此與最初匯入時
> （5,941,515 ／ 15,150,371）不同。**合計沒變**，金額計算也沒動過。

這三個數字與 Kevin 原 Excel 完全一致。個股 XIRR 也已逐一比對過：
VOO 23.9%、台積電 27.5%、聯發科 58.7%、QQQ 30.0%、SOXX 37.4%、DRAM 260%、00631L 235%。

> 個股 XIRR 會隨當日股價浮動，**不要拿它當精確的回歸基準**（例如 2026/09/02 的
> 收盤價下 VOO 是 23.51%、QQQ 29.47%、SOXX 37.65%、DRAM 253.61%）。
> 要驗證計算邏輯，正確做法是拿改動前後的同一份輸入比對，而不是比對這些數字。

市場別 XIRR（2026/09/02 當日價）：台股 24.26%、美股 34.41%、合計 26.89%。

**改動任何計算邏輯後，用這些數字回歸驗證。**

---

## 部署方式（重要，跟一般網站不一樣）

目前是 Claude Artifact，頁面透過 `mcp` capability 呼叫**使用者自己的**連接器，
所以頁面原始碼裡沒有任何金鑰：

```
capabilities: {
  mcp: { servers: [
    { server: "Supabase", tools: ["execute_sql"] }
  ]}
}
```

> 2026/09/02 起**不再需要 Google Drive 連接器** —— 報價改由 Supabase 端抓取，
> 頁面只剩 `execute_sql` 這一條路。重新發布時記得把 Google Drive 從 capabilities 拿掉。

### Artifact 的硬限制

1. **不能對任何外部網域發 fetch/XHR**（CSP）。
   頁面因此永遠不可能自己打 Fugle。解法是讓**資料庫**去發請求（見「即時報價」），
   而不是讓頁面發 —— CSP 管的是瀏覽器。
2. **連接器回應有大小上限。** 一次回 135KB 會被截斷 → JSON 解析失敗。
   交易資料因此分頁載入：**每頁 800 筆約 70KB**（全部 1,480 筆是 128KB，太貼近上限）。
   每一頁都是一次連接器往返，所以頁數直接決定開啟速度 —— 不要為了保險把它調小。
3. **一次只發一個 `execute_sql`。** 帳本與報價現在都走 Supabase，`connect()` 是
   排隊執行的（帳本 → 報價 → 更新），不要改成並行。
   代價是開啟時要 3 次往返才有數字，所以才有下面的快取先上。
4. **`<untrusted-data-…>` 信封不能用「第一個」開標籤去抓。** 前言那句話
   （「…within the below `<untrusted-data-UUID>` boundaries.」）本身就含有一組
   同名開標籤，從第一個抓會把 `boundaries. <untrusted-data-…>` 一起吃進去，
   JSON 解不開、整頁變成 0。要取結束標籤前的**最後一個**開標籤 —— 見
   `parseSqlRows()`，另外備有「從第一個 `[` 取到最後一個 `]`」的退路。
5. 頁面自己不能存資料，所有寫入都要走 Supabase。

---

## 開啟速度

`connect()` 會**先用 localStorage 的快照把畫面畫出來**，再去資料庫對齊。
沒有這一步的話，要等 3 次連接器往返（標的 + 2 頁交易）數字才會出現。

**時間花在哪（2026/09/02 實測）**

| 項目 | 實測 |
|---|---|
| 交易分頁查詢（Postgres 端） | **11.6ms** |
| 報價更新（Edge Function + Fugle + Twelve Data） | **2,121ms** |
| 標的 1.9KB／報價 0.8KB／交易每頁 61KB | — |

Postgres 端可以忽略不計，**時間幾乎全在連接器往返上**（瀏覽器 → claude.ai →
MCP → Supabase）。所以優化方向只有兩個：減少往返次數、縮小回應。

頁尾會顯示「本次載入：… 各 X.Xs｜合計 X.Xs」，要判斷還慢在哪就看那一行。

目前冷啟動是 2 次往返（合併查詢 + 第 2 頁交易），加上報價更新（若超過
`QUOTE_FRESH_MS`）。

兩個容易改壞的地方：

1. **`loadFromDb` 讀進 `staged`，全部到齊才 `state.stocks = staged`。**
   中途就換上去的話，畫面會先看到「有標的、零筆交易」，所有數字瞬間歸零再跳回來。
2. **`QUOTE_FRESH_MS`（10 分鐘）內不重抓報價。** 抓一次要等 Fugle 四檔加
   Twelve Data 兩次往返，反覆重開不該每次都付這個成本，也會吃額度。
   要最新的按「重新整理」。

報價也有自己的快取（`klfan_quote_cache_v1`），開啟時價格一起先上。

---

## 即時報價（2026/09/02 改版，已不用 Google 試算表）

```
頁面 ──execute_sql──▶ refresh_klfan_quotes()  ← Postgres，http 擴充，同步
                            │
                            ▼  POST /functions/v1/refresh-klfan-quotes
                      Edge Function
                            ├──▶ Fugle        intraday/quote/{code}   台股
                            ├──▶ Twelve Data  quote?symbol=a,b,c      美股（批次）
                            └──▶ Twelve Data  exchange_rate USD/TWD
                            │
                            ▼  service_role 寫入
                      klfan_quotes ──execute_sql──▶ 頁面讀
```

**為什麼要繞這麼一圈**：Artifact 的 CSP 擋死頁面的所有對外 fetch，所以頁面永遠
不可能自己打 Fugle。但頁面可以執行 SQL，而**發請求的是資料庫不是瀏覽器** ——
這條路 CSP 管不到。金鑰全留在 Edge Function 的 secret 裡，頁面原始碼依然沒有任何金鑰。

**更新時機**：開啟頁面時更新一次（上次抓取在 60 秒內則略過），或按「重新整理」。
沒有排程，`pg_cron` 沒有用在這裡。

### 只抓仍持有的標的（重要，不要「修正」成全抓）

`klfan_live_symbols` 這個 view 只列出 `sum(shares) > 0` 的標的。理由有兩層：

1. 已出清的標的持股為 0，市值恆為 0，抓它的價格**不會改變畫面上任何數字**。
2. Twelve Data 免費方案是**每分鐘 8 credits、一檔算一個**。39 檔全抓會直接回 429
   （實測過，訊息是 *"19 API credits were used, with the current limit being 8"*）。
   篩到實際持有之後是 4 檔美股 + 1 次匯率 = 5，穩穩在額度內。

Fugle 沒有這個壓力（實測 20 檔全過），但一併篩掉比較快也比較省。

### 代碼正規化

`klfan_stocks.symbol` 仍然沿用 GOOGLEFINANCE 格式（`TPE:2330`、`NASDAQ:AAPL`、
`BATS:DRAM`）。Edge Function 送出前把交易所前綴剝掉，但寫回 `klfan_quotes` 時
**用原始 symbol 當 key**，所以頁面完全不需要知道正規化規則。

**路由看的是代碼前綴，不是 `market` 欄位** —— 資料庫裡確實有 `market='台股'` 但
`symbol='NASDAQ:AMSC'` 的列（見「已知的坑」），照前綴走才會抓到對的價格。

- `TPE:` / `TWO:` → Fugle（送出 `2330`、`00631L`）
- 其餘一律 → Twelve Data（送出 `AAPL`、`DRAM`、`VOO`）

Twelve Data 帶 `country=United States`，避免 `DRAM` 抓到同名的歐洲 ETF。

### 新增標的

只要 `klfan_stocks.symbol` 填對前綴就會自動被抓，**不再需要去維護任何試算表**。

### 台股名稱來自證交所

`klfan_stocks.display` 原本是從 Google 試算表匯入的手打值。2026/09/02 已用
`select klfan_twse_names()` 對過證交所並同步（改了兩處：`00679B` 元大美債20 →
**元大美債20年**、`00909` 國泰數位支付 → **國泰數位支付服務**；其餘 18 檔本來就一致，
代號前綴也一併從名稱裡拿掉了）。

那個函式是唯讀的，只回傳「現在的名稱 vs 官方名稱」讓你比對，要不要套用是另一道
`update`（SQL 附在 `supabase/migrations/004_twse_names.sql` 的註解裡）。

取名稱的兩個來源，順序不能反過來：
1. `openapi.twse.com.tw` 每日收盤行情 —— JSON、快，但**漏掉債券 ETF 與上櫃股**
2. 缺的再逐檔查 `isin.twse.com.tw/isin/single_main.jsp?owncode=<代號>`
   —— **不要改用整份總表**（`C_public.jsp`），那份含權證、好幾 MB，會直接逾時

---

## 已知的坑

1. **Kevin 原 Excel「股票總表」的美股彙總是壞的。**
   `M4` 公式抓 `VOO!J4+QQQ!J4+SOXX!J4+DRAM!J4`，但各工作表的 `J4` 是「目前持股股數」，
   市值在 `J6`。所以那張表的美股目前市值／累計損益／XIRR 三格不能當基準（台股那三格是對的）。
   **不要拿那三個數字去「校正」這個 App。**

2. **不要從各個股工作表分別抓資料。** 我一開始這樣做，發現有幾張表混入了多餘的列，
   加總對不上。正確來源是「股票總表」工作表（它自己就是全部個股的彙整）。

3. ~~`0050` 前導零在 Google 試算表會被吃掉~~ —— 已解決。報價不再經過試算表，
   Fugle 直接吃 `0050` / `00631L`，實測正常。

4. ~~Fugle 被 CSP 擋死~~ —— 已解決（2026/09/02），走 Postgres → Edge Function。
   但**沙箱的對外連線仍然不通**：在 Cowork/Claude Code 裡無法直接測 Fugle 或
   Twelve Data，只能透過部署好的 Edge Function 間接驗證。

5. **`AMSC` 是「用台幣買的美股」，不是資料錯誤。**
   2023/07/31–08/07 透過中信複委託買賣，記帳金額是台幣。所以：
   - `currency='TWD'` 是**對的**，不要「修正」成 USD —— 那才是他實際的現金流，
     換匯只看這一欄，改了會弄壞損益與 XIRR。
   - `market` 已於 2026/09/02 從「台股」改成「美股」（它就是美股；這一欄只影響分組顯示，
     不參與計算）。驗證基準已同步更新。
   - `symbol='NASDAQ:AMSC'`，報價路由看前綴會去 Twelve Data 抓 USD 價格，
     但頁面發現幣別不符會**拒絕採用**、退回手動價格。這是刻意的，見 `livePriceFor()`。
     目前它已出清（持股 0），影響為零。
   - 若之後又出現「台幣買的美股」而且需要即時價，正解是把現金流幣別與報價幣別
     拆成兩欄，不是去改 `currency`。

6. **Twelve Data 免費方案每分鐘只有 8 credits，一檔算一個。**
   不要「順手」把報價改成全部標的都抓，會立刻 429。

---

## 待辦（Kevin 提過但還沒做）

- 已實現／未實現損益拆開（目前合在一起算）
- 券商別分析（國泰 913 筆、中信 328、元大 127、凱基 112）
- 走勢圖（注意：**沒有歷史股價資料**，不要編造；要嘛接行情 API，要嘛只畫現金流累積）

## 如果要搬離 Artifact（例如 Vercel）

1. 資料層：`execute_sql` 經連接器 → 改成 Supabase JS client + anon key，
   並為三張表補 RLS policy。
2. 報價層：可以拿掉 Postgres 那一跳，前端直接 `sb.functions.invoke('refresh-klfan-quotes')`
   （ks-wealth 就是這樣做的，可以照抄）。Edge Function 本身完全不用改。
3. 這時候 `app.js` 的 UI 與計算邏輯可以整段沿用，只需要換掉資料存取那一層
   （集中在 `sql()` / `loadFromDb()` / `mutate()`，以及 `loadQuotes()` / `refreshQuotes()`）。
