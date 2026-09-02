-- 只有「仍持有」的標的需要即時報價：已出清的持股為 0，市值恆為 0，
-- 抓它的價格對市值／損益／XIRR 都沒有任何影響，卻要吃掉 API 額度。
-- Twelve Data 免費方案是每分鐘 8 credits、一檔算一個，39 檔會直接 429；
-- 篩到實際持有的之後是 4 檔美股 + 1 次匯率 = 5，穩穩在額度內。
create or replace view public.klfan_live_symbols
with (security_invoker = true) as
select s.symbol
from klfan_stocks s
join klfan_transactions t on t.stock_key = s.key
where coalesce(s.symbol, '') <> ''
group by s.symbol
having sum(t.shares) > 0.000001;
