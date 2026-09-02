-- 查台股官方名稱（證交所）。唯讀：只回傳比對結果，不寫任何東西，
-- 也不碰 Fugle / Twelve Data 的額度。
--
-- 用途是把 klfan_stocks.display 對回官方簡稱 —— 原本的名稱是從 Google 試算表
-- 匯入的手打值，不保證與官方一致（實際查出兩處不符：00679B 少了「年」、
-- 00909 少了「服務」）。
--
-- 資料流：這裡 → Edge Function（mode=twse-names）→ 證交所
--   1. openapi.twse.com.tw 每日收盤行情：JSON、快，涵蓋多數上市普通股與 ETF
--   2. 缺的（債券 ETF、上櫃股）再逐檔查 isin.twse.com.tw 的單檔端點
--      —— 不要改用整份總表，那份含權證、好幾 MB，會直接逾時
create or replace function public.klfan_twse_names()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  resp extensions.http_response;
  anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdieHNud3Fiam1nZmlrcGJseW90Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MTczMzEsImV4cCI6MjEwMzI5MzMzMX0.bLBUY_-MkHt8Z2Wd9HIPXLk4Tok-ncIFJBMnhlMpV1w';
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '120');

  select * into resp from extensions.http((
    'POST',
    'https://gbxsnwqbjmgfikpblyot.supabase.co/functions/v1/refresh-klfan-quotes',
    array[extensions.http_header('Authorization', 'Bearer ' || anon_key)],
    'application/json',
    '{"mode":"twse-names"}'
  )::extensions.http_request);

  if resp.status <> 200 then
    return jsonb_build_object('error', 'edge_function_' || resp.status,
                              'detail', left(coalesce(resp.content, ''), 500));
  end if;
  return resp.content::jsonb;
exception when others then
  return jsonb_build_object('error', 'names_failed', 'detail', sqlerrm);
end;
$$;

revoke all on function public.klfan_twse_names() from public, anon, authenticated;

-- 把名稱同步成官方簡稱（可重複執行；已一致的不會被動到）
-- with official as (
--   select x->>'key' as key, x->>'official' as name
--   from jsonb_array_elements(klfan_twse_names()->'names') x
--   where x->>'official' is not null
-- )
-- update klfan_stocks s set display = o.name
-- from official o
-- where s.key = o.key and s.display is distinct from o.name;
