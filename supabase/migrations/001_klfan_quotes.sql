-- 即時報價快取。Edge Function 寫入，Artifact 頁面透過 execute_sql 讀。
-- symbol 用 klfan_stocks.symbol 的原始值當 key（例如 'TPE:2330'、'NASDAQ:VOO'），
-- 這樣頁面不需要知道任何代碼正規化規則。匯率以 symbol='USD/TWD' 存成一列。
create table if not exists klfan_quotes (
  symbol         text primary key,
  price          numeric not null,
  currency       text    not null,
  change         numeric,
  change_percent numeric,
  source         text    not null,          -- 'fugle' | 'twelve_data'
  quoted_at      text,                      -- 資料源自己的時間戳，原樣保留
  updated_at     timestamptz not null default now()
);

-- 與 klfan_stocks / klfan_transactions / klfan_fx_daily 一致：開 RLS 但不給 policy，
-- 只透過 MCP 連接器的管理 API 與 Edge Function 的 service_role 存取。
alter table klfan_quotes enable row level security;
