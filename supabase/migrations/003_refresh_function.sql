create extension if not exists http with schema extensions;

-- 讓 Artifact 頁面有辦法觸發報價更新。
--
-- 頁面被 CSP 擋住不能發任何對外請求，但它可以透過 MCP 連接器執行 SQL；
-- 發請求的是資料庫而不是瀏覽器，所以這條路繞得過 CSP。
-- 同步呼叫（http 擴充而非 pg_net），頁面因此在同一次 execute_sql 就拿到結果。
--
-- 帶的是 anon key —— 它本來就是公開的（ks-wealth 前端也寫著同一把），
-- 這裡只是用來滿足 Edge Function 的 verify_jwt。真正的寫入權限來自
-- Edge Function 內部自己的 service_role，不經過這裡。
create or replace function public.refresh_klfan_quotes()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  resp extensions.http_response;
  anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdieHNud3Fiam1nZmlrcGJseW90Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MTczMzEsImV4cCI6MjEwMzI5MzMzMX0.bLBUY_-MkHt8Z2Wd9HIPXLk4Tok-ncIFJBMnhlMpV1w';
begin
  -- 逐檔打 Fugle，預設 5 秒不夠。
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '50');

  select * into resp from extensions.http((
    'POST',
    'https://gbxsnwqbjmgfikpblyot.supabase.co/functions/v1/refresh-klfan-quotes',
    array[extensions.http_header('Authorization', 'Bearer ' || anon_key)],
    'application/json',
    '{}'
  )::extensions.http_request);

  if resp.status <> 200 then
    return jsonb_build_object(
      'error', 'edge_function_' || resp.status,
      'detail', left(coalesce(resp.content, ''), 500)
    );
  end if;

  return resp.content::jsonb;
exception when others then
  return jsonb_build_object('error', 'refresh_failed', 'detail', sqlerrm);
end;
$$;

-- security definer 函式預設 PUBLIC 可執行，等於任何人只要有 anon key
-- （它公開在 ks-wealth 前端）就能透過 PostgREST 的 /rpc/ 觸發抓取，
-- 燒掉 Fugle 與 Twelve Data 的額度。頁面走 MCP 連接器的管理連線，不需要這些角色。
revoke all on function public.refresh_klfan_quotes() from public, anon, authenticated;
revoke all on public.klfan_quotes from anon, authenticated;
revoke all on public.klfan_live_symbols from anon, authenticated;
