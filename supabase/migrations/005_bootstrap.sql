-- 開啟頁面所需的全部資料，一次回完。
--
-- 為什麼：每一趟 execute_sql 往返實測約 3 秒的固定成本，跟資料多寡幾乎無關
-- （實測 2.7KB 要 3.4s、61KB 要 3.1s）。原本開一次要 5 趟共 17.2 秒，
-- 其中光是往返就佔了 15 秒。所以要快就只能減少往返次數，不是縮小資料。
--
-- 連接器回應約 135KB 會被截斷，全欄位原樣輸出是 128.6KB，太貼近上限。
-- 這裡用字典編碼把重複字串換成索引（標的、銀行、備註、類型），再用
-- trim_scale 去掉數值補零 —— 1,484 筆從 128.6KB 壓到 93KB，沒有少任何欄位。
-- 餘裕約 40KB，大約還能再長 600 多筆；超過的話前端會發現 t 少於 n，
-- 自動退回分頁載入（見 app.js 的 loadTxPaged）。
--
-- 回傳結構：
--   s  標的  [[key,display,market,currency,symbol,manual_price], …]（依 key 排序）
--   q  報價  [[symbol,price,currency,source,quoted_at,updated_ms], …]
--   t  交易  [[id, 標的索引, 日期, 金額, 股數, 銀行索引, 類型索引, 備註索引, 台幣], …]
--   d  字典  { banks:[…], notes:[…], kinds:[…] }
--   n  交易總筆數（前端用來判斷有沒有被截斷）
create or replace function public.klfan_bootstrap()
returns jsonb
language sql
stable
as $$
with keys as (
  select key, (row_number() over (order by key)) - 1 as i from klfan_stocks
),
base as (
  select t.id, t.stock_key, t.tx_date, t.amount, t.shares,
         coalesce(t.bank,'') as bank, t.kind, coalesce(t.note,'') as note,
         round(case when s.currency = 'USD' then t.amount * coalesce(
           (select f.rate from klfan_fx_daily f where f.fx_date <= t.tx_date order by f.fx_date desc limit 1),
           (select f2.rate from klfan_fx_daily f2 order by f2.fx_date desc limit 1))
         else t.amount end, 4) as tw
  from klfan_transactions t join klfan_stocks s on s.key = t.stock_key
),
banks as (select bank, (row_number() over (order by bank)) - 1 as i from (select distinct bank from base) x),
notes as (select note, (row_number() over (order by note)) - 1 as i from (select distinct note from base) y),
kinds as (select kind, (row_number() over (order by kind)) - 1 as i from (select distinct kind from base) z)
select jsonb_build_object(
  's', (select coalesce(jsonb_agg(jsonb_build_array(key, display, market, currency, symbol, manual_price) order by key), '[]'::jsonb) from klfan_stocks),
  'q', (select coalesce(jsonb_agg(jsonb_build_array(symbol, price, currency, source, quoted_at,
          extract(epoch from updated_at) * 1000) order by symbol), '[]'::jsonb) from klfan_quotes),
  't', (select coalesce(jsonb_agg(jsonb_build_array(
          b.id, k.i, b.tx_date::text, round(b.amount, 4), trim_scale(round(b.shares, 6)),
          bk.i, kd.i, nt.i, trim_scale(b.tw)) order by b.id), '[]'::jsonb)
        from base b
        join keys  k  on k.key   = b.stock_key
        join banks bk on bk.bank = b.bank
        join notes nt on nt.note = b.note
        join kinds kd on kd.kind = b.kind),
  'd', jsonb_build_object(
        'banks', (select coalesce(jsonb_agg(bank order by i), '[]'::jsonb) from banks),
        'notes', (select coalesce(jsonb_agg(note order by i), '[]'::jsonb) from notes),
        'kinds', (select coalesce(jsonb_agg(kind order by i), '[]'::jsonb) from kinds)),
  'n', (select count(*) from base)
);
$$;

revoke all on function public.klfan_bootstrap() from public, anon, authenticated;

-- 報價更新完後把新報價一起帶回，前端就不必再發一次查詢讀它（省一趟 2.1 秒）。
-- 完整定義見 003_refresh_function.sql，這裡只列差異：
--   return body || jsonb_build_object('quotes', (select … from klfan_quotes));
