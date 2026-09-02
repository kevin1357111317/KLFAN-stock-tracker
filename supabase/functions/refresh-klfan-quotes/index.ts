// KLFAN 報價更新。
//
// 為什麼需要這一層：頁面是 Claude Artifact，CSP 擋死所有對外 fetch，所以瀏覽器
// 不可能直接打 Fugle。抓取放在這裡，結果寫進 klfan_quotes，頁面再用它既有的
// execute_sql 讀 —— 完全繞過 CSP，而且 API 金鑰永遠不會進到頁面裡。
//
// 呼叫路徑：頁面 → execute_sql: select refresh_klfan_quotes()
//                → Postgres（http 擴充，同步）→ 這裡
//
// 資料源分工（Fugle 只有台股，這是硬限制）：
//   TPE: 開頭   → Fugle intraday/quote
//   其餘        → Twelve Data quote（批次，一次帶多個代碼）
//   USD/TWD     → Twelve Data exchange_rate
//
// 代碼正規化：klfan_stocks.symbol 存的是 GOOGLEFINANCE 格式（TPE:2330、
// NASDAQ:AAPL、BATS:DRAM…）。這裡把交易所前綴剝掉再送出，但寫回 klfan_quotes
// 時用「原始的 symbol」當 key，頁面因此完全不需要知道正規化規則。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** 'TPE:2330' -> { venue: 'TPE', code: '2330' }；沒有前綴時 venue 為 null。 */
function splitSymbol(symbol: string): { venue: string | null; code: string } {
  const idx = symbol.indexOf(":");
  if (idx < 0) return { venue: null, code: symbol.trim() };
  return { venue: symbol.slice(0, idx).trim().toUpperCase(), code: symbol.slice(idx + 1).trim() };
}

// 送出去的代碼必須乾淨 —— 這些值最後會進到 URL 裡。
const SAFE_CODE = /^[0-9A-Za-z.\-]{1,16}$/;

/** Fugle 的 lastUpdated 是微秒 epoch（例如 1788327000000000），轉成 ISO 才看得懂。 */
function fugleStamp(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return typeof v === "string" && v ? v : null;
  const ms = n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** 有限併發的 map，避免同時打爆 Fugle 的每秒上限。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

type Quote = {
  symbol: string;
  price: number;
  currency: string;
  change: number | null;
  changePercent: number | null;
  source: string;
  quotedAt: string | null;
};
type Failure = { symbol: string; error: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const fugleKey = Deno.env.get("FUGLE_MARKETDATA_API_KEY") ?? "";
  const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return json({ error: "supabase_config_missing" }, 500);
  if (!fugleKey && !twelveKey) return json({ error: "market_keys_missing" }, 503);

  // 三張 klfan_ 表都是 RLS 開啟但沒有 policy，所以這裡用 service_role 寫。
  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let mode: string | null = null;
  try {
    const body = await req.json();
    if (body && typeof body.mode === "string") mode = body.mode;
  } catch { /* 空 body 是正常的 */ }

  // 只查台股官方名稱，不寫任何東西、也不碰行情商額度。
  // 來源是證交所的公開資料（STOCK_DAY_ALL 每一列都有 Code 與 Name），
  // 用來把 klfan_stocks.display 對回官方簡稱 —— 原本的名稱是從 Google
  // 試算表匯入的手打值，不保證與官方一致。
  //
  // 這一段放在 Edge Function 而不是本機，是因為開發沙箱的網路政策擋掉了
  // twse.com.tw；Supabase 這邊連得出去。
  if (mode === "twse-names") {
    const { data: all, error: allErr } = await db.from("klfan_stocks").select("key,symbol,display");
    if (allErr) return json({ error: "stocks_unavailable", detail: allErr.message }, 500);
    const tw = (all ?? [])
      .map((r) => ({ key: r.key, display: r.display, ...splitSymbol(String(r.symbol ?? "").trim()) }))
      .filter((r) => (r.venue === "TPE" || r.venue === "TWO") && SAFE_CODE.test(r.code));

    const map: Record<string, string> = {};
    const sources: Record<string, number | string> = {};

    // 先打每日收盤行情：JSON、一次到位、快。涵蓋絕大多數上市普通股與 ETF。
    try {
      const res = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) sources["stock_day_all"] = `http_${res.status}`;
      else {
        const rows = await res.json();
        let n = 0;
        if (Array.isArray(rows)) {
          for (const r of rows) {
            const c = String(r?.Code ?? "").trim();
            const nm = String(r?.Name ?? "").trim();
            if (c && nm) { map[c] = nm; n++; }
          }
        }
        sources["stock_day_all"] = n;
      }
    } catch {
      sources["stock_day_all"] = "unreachable";
    }

    // 每日收盤行情漏掉債券 ETF 與上櫃股，缺的再逐檔去證交所的
    // 「有價證券代號及名稱」查。用單檔端點而不是整份總表 —— 總表含權證、
    // 好幾 MB，會直接逾時。回應是 Big5 編碼的 HTML 表格。
    const missing = tw.filter((r) => !(r.code in map));
    if (missing.length > 0) {
      let found = 0;
      await mapLimit(missing, 3, async (r) => {
        try {
          const res = await fetch(
            `https://isin.twse.com.tw/isin/single_main.jsp?owncode=${encodeURIComponent(r.code)}`,
          );
          if (!res.ok) return;
          const html = new TextDecoder("big5").decode(await res.arrayBuffer());
          const cells: string[] = [];
          const re = /<td[^>]*>([\s\S]*?)<\/td>/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(html)) !== null) {
            cells.push(m[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim());
          }
          // 代號那一格的下一格就是名稱
          const i = cells.indexOf(r.code);
          if (i >= 0 && cells[i + 1]) { map[r.code] = cells[i + 1]; found++; }
        } catch { /* 查不到就留 null，由呼叫端決定怎麼辦 */ }
      });
      sources["isin_single"] = `${found}/${missing.length}`;
    }

    if (Object.keys(map).length === 0) return json({ error: "twse_unreachable", sources }, 502);

    return json({
      mode: "twse-names",
      sources,
      listed: Object.keys(map).length,
      names: tw.map((r) => ({
        key: r.key, code: r.code, current: r.display,
        official: map[r.code] ?? null,
      })),
    });
  }

  // klfan_live_symbols 只列出仍持有的標的。已出清的持股為 0、市值恆為 0，
  // 抓它的價格不會改變畫面上任何數字，卻會吃掉 Twelve Data 每分鐘 8 credits
  // 的額度（一檔算一個）—— 39 檔全抓會直接 429。
  const { data: stocks, error: stocksError } = await db
    .from("klfan_live_symbols")
    .select("symbol");
  if (stocksError) return json({ error: "stocks_unavailable", detail: stocksError.message }, 500);

  const quotes: Quote[] = [];
  const failures: Failure[] = [];
  let twelveDetail: string | null = null;

  // 以 symbol 去重：同一個代碼只抓一次，即使多個 key 指向它。
  const targets = new Map<string, { venue: string | null; code: string }>();
  for (const s of stocks ?? []) {
    const raw = String(s.symbol ?? "").trim();
    if (!raw) continue;
    if (targets.has(raw)) continue;
    targets.set(raw, splitSymbol(raw));
  }

  const twTargets: Array<[string, string]> = []; // [原始 symbol, 送出的代碼]
  const usTargets: Array<[string, string]> = [];
  for (const [raw, { venue, code }] of targets) {
    if (!SAFE_CODE.test(code)) {
      failures.push({ symbol: raw, error: "invalid_symbol" });
      continue;
    }
    // 路由看的是代碼前綴而不是 market 欄位 —— 資料庫裡確實有 market='台股'
    // 但 symbol='NASDAQ:AMSC' 的列，照前綴走才會抓到對的價格。
    if (venue === "TPE" || venue === "TWO") twTargets.push([raw, code]);
    else usTargets.push([raw, code]);
  }

  // ---- 台股：Fugle，一檔一個請求，併發 4 ----
  if (twTargets.length > 0) {
    if (!fugleKey) {
      for (const [raw] of twTargets) failures.push({ symbol: raw, error: "fugle_key_missing" });
    } else {
      await mapLimit(twTargets, 4, async ([raw, code]) => {
        try {
          const res = await fetch(
            `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(code)}`,
            { headers: { "X-API-KEY": fugleKey, Accept: "application/json" } },
          );
          if (!res.ok) {
            failures.push({ symbol: raw, error: `fugle_${res.status}` });
            return;
          }
          const q = await res.json();
          const price = Number(q.lastPrice ?? q.closePrice ?? q.previousClose);
          if (!Number.isFinite(price) || price <= 0) {
            failures.push({ symbol: raw, error: "price_unavailable" });
            return;
          }
          quotes.push({
            symbol: raw,
            price,
            currency: "TWD",
            change: Number.isFinite(Number(q.change)) ? Number(q.change) : null,
            changePercent: Number.isFinite(Number(q.changePercent)) ? Number(q.changePercent) : null,
            source: "fugle",
            quotedAt: fugleStamp(q.lastUpdated) ?? q.date ?? null,
          });
        } catch {
          failures.push({ symbol: raw, error: "fugle_unreachable" });
        }
      });
    }
  }

  // ---- 美股：Twelve Data，一次帶所有代碼。免費方案每分鐘 8 credits、
  //      一檔算一個，所以上面才要先篩掉已出清的標的。
  //      country 限定美國，避免抓到同名的歐洲標的（DRAM 就有這個坑）。 ----
  if (usTargets.length > 0) {
    if (!twelveKey) {
      for (const [raw] of usTargets) failures.push({ symbol: raw, error: "twelve_key_missing" });
    } else {
      const codes = usTargets.map(([, code]) => code);
      try {
        const res = await fetch(
          `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(codes.join(","))}` +
            `&country=United%20States&apikey=${encodeURIComponent(twelveKey)}`,
          { headers: { Accept: "application/json" } },
        );
        const body = await res.json();
        if (!res.ok || body?.status === "error") {
          // 配額類的錯誤把原文帶出來 —— 每分鐘上限和當日額度用完要用不同方式處理。
          const err = body?.code ? `twelve_${body.code}` : `twelve_${res.status}`;
          twelveDetail = typeof body?.message === "string" ? body.message : null;
          for (const [raw] of usTargets) failures.push({ symbol: raw, error: err });
        } else {
          // 單一代碼回傳物件本身，多代碼回傳以代碼為 key 的物件 —— 兩種都要吃。
          const pick = (code: string) =>
            usTargets.length === 1 ? body : (body?.[code] ?? null);
          for (const [raw, code] of usTargets) {
            const q = pick(code);
            if (!q || q.status === "error") {
              failures.push({ symbol: raw, error: q?.code ? `twelve_${q.code}` : "price_unavailable" });
              continue;
            }
            const price = Number(q.close);
            if (!Number.isFinite(price) || price <= 0) {
              failures.push({ symbol: raw, error: "price_unavailable" });
              continue;
            }
            quotes.push({
              symbol: raw,
              price,
              currency: String(q.currency ?? "USD").toUpperCase(),
              change: Number.isFinite(Number(q.change)) ? Number(q.change) : null,
              changePercent: Number.isFinite(Number(q.percent_change)) ? Number(q.percent_change) : null,
              source: "twelve_data",
              quotedAt: q.datetime ?? null,
            });
          }
        }
      } catch {
        for (const [raw] of usTargets) failures.push({ symbol: raw, error: "twelve_unreachable" });
      }
    }
  }

  // ---- 匯率 ----
  let fxRate: number | null = null;
  let fxError: string | null = null;
  if (twelveKey) {
    try {
      const res = await fetch(
        `https://api.twelvedata.com/exchange_rate?symbol=USD%2FTWD&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { Accept: "application/json" } },
      );
      const body = await res.json();
      const rate = Number(body?.rate);
      if (!res.ok || body?.status === "error" || !Number.isFinite(rate) || rate <= 0) {
        fxError = body?.code ? `twelve_${body.code}` : "fx_unavailable";
        if (!twelveDetail && typeof body?.message === "string") twelveDetail = body.message;
      } else {
        fxRate = rate;
      }
    } catch {
      fxError = "twelve_unreachable";
    }
  } else {
    fxError = "twelve_key_missing";
  }

  // ---- 寫回 ----
  const now = new Date().toISOString();
  const rows = quotes.map((q) => ({
    symbol: q.symbol,
    price: q.price,
    currency: q.currency,
    change: q.change,
    change_percent: q.changePercent,
    source: q.source,
    quoted_at: q.quotedAt,
    updated_at: now,
  }));
  if (fxRate !== null) {
    rows.push({
      symbol: "USD/TWD",
      price: fxRate,
      currency: "TWD",
      change: null,
      change_percent: null,
      source: "twelve_data",
      quoted_at: now,
      updated_at: now,
    });
  }

  let writeError: string | null = null;
  if (rows.length > 0) {
    const { error } = await db.from("klfan_quotes").upsert(rows, { onConflict: "symbol" });
    if (error) writeError = error.message;
  }

  // 清掉不再追蹤的代碼。沒有這一步，已出清標的的舊報價會一直留在表裡，
  // 頁面會把它當成「即時」顯示 —— 一個看起來很新、其實早就過期的價格
  // 比沒有價格更糟。
  const keep = [...targets.keys(), "USD/TWD"];
  let pruneError: string | null = null;
  if (keep.length > 0) {
    const { error } = await db
      .from("klfan_quotes")
      .delete()
      .not("symbol", "in", `(${keep.map((s) => `"${s}"`).join(",")})`);
    if (error) pruneError = error.message;
  }

  // 順手把今天的匯率補進 klfan_fx_daily，歷史換算才不會停在匯入當天。
  let fxDailyError: string | null = null;
  if (fxRate !== null) {
    const today = now.slice(0, 10);
    const { error } = await db
      .from("klfan_fx_daily")
      .upsert({ fx_date: today, rate: fxRate }, { onConflict: "fx_date" });
    if (error) fxDailyError = error.message;
  }

  return json({
    requestedAt: now,
    ok: quotes.length,
    failed: failures.length,
    fx: { rate: fxRate, error: fxError },
    twelveDetail,
    writeError,
    pruneError,
    fxDailyError,
    failures,
  });
});
