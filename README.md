# KLFAN 投資追蹤台帳

個人股票投資組合追蹤 App。輸入是 2019 年至今的完整交易紀錄，輸出是每一檔的
**年化報酬率（XIRR）**、損益與完整進出明細，台股／美股分開統計，可以隨時新增
買賣並自動重算。

無框架、無相依套件的單頁 App，資料存在 Supabase，即時股價與匯率透過 Google
試算表的 `GOOGLEFINANCE` 取得。

> 交接與維護細節（資料庫 schema、金額符號約定、核心算法、驗證基準、已知的坑）
> 都寫在 [`CLAUDE.md`](CLAUDE.md)。**動手改任何計算邏輯前先讀它。**

## 建置

```bash
python3 build.py
```

會產生兩個檔案（皆已 gitignore）：

| 產物 | 用途 |
|---|---|
| `klfan_app.html` | 發布用。Claude Artifact 的「片段」格式，不含 doctype／html／head／body |
| `klfan_app_full.html` | 本機預覽用，有完整文件外層，可直接用瀏覽器開 |

改 `app.js` / `app.css` → 跑 `build.py` → 重新發布 `klfan_app.html`。

## 檔案

| 檔案 | 說明 |
|---|---|
| `app.js` | 全部邏輯：XIRR、資料庫存取、報價、UI 渲染。約 1,100 行 |
| `app.css` | 樣式，含深色模式 |
| `build.py` | 把 css + js 組成單一 HTML |
| `CLAUDE.md` | 專案交接文件 |

## 資料來源

- **Supabase**：`klfan_stocks`（標的）、`klfan_transactions`（交易）、`klfan_fx_daily`（USD/TWD 每日收盤）
- **即時報價**：Google 試算表「KLFAN_即時報價」，每列一個 `GOOGLEFINANCE` 公式

頁面本身不含任何金鑰——透過 Claude Artifact 的 `mcp` capability 呼叫使用者自己的
連接器存取 Supabase 與 Google Drive。
