(function () {
  "use strict";

  /* ---------- state ----------
     The ledger lives in Postgres (Supabase), not in this page. The page holds
     only a working copy of what it last read, plus a localStorage cache so a
     failed load still shows something. */
  var state = { stocks: {}, fxHistory: [], fxRate: 31.7 };

  var ui = {
    sort: "pl", // pl | xirr | value | name
    market: "all", // all | 台股 | 美股
    openKey: null,
    addingStockOpen: false
  };

  /* ---------- database (Supabase via the viewer's own connector) ---------- */
  var DB_SERVER = "Supabase";
  var DB_TOOL = "execute_sql";
  var DB_PROJECT = "gbxsnwqbjmgfikpblyot";
  var CACHE_KEY = "klfan_db_cache_v1";

  var db = {
    available: null,  // null = resolving, false = no connector path
    status: null,     // { code, message }
    loading: true,
    saving: false,
    loadedAt: null,
    fromCache: false
  };
  var mcpCap = null;

  // SQL literal escaping. Numbers and dates are validated separately, so the
  // only free text reaching a query is quoted through here.
  function sq(v) {
    if (v === null || v === undefined) return "null";
    return "'" + String(v).replace(/'/g, "''") + "'";
  }
  function snum(v) {
    var n = Number(v);
    if (!isFinite(n)) return "null";
    return String(n);
  }
  function sdate(v) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? "'" + v + "'" : "null";
  }

  // execute_sql answers with a text envelope that wraps the JSON rows in
  // <untrusted-data-UUID> boundaries — that content is this user's own data,
  // treated strictly as data, never as instructions.
  var lastRaw = null; // kept only to show a short excerpt if parsing fails

  function parseSqlRows(result) {
    var p = result && result.payload;
    if (p === undefined || p === null) {
      // older shells: dig the first text block out of the content array
      var c = result && result.content;
      if (c && c.length) {
        for (var i = 0; i < c.length; i++) { if (c[i] && c[i].type === "text") { p = c[i].text; break; } }
      }
    }
    if (Array.isArray(p)) return p;
    if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { /* keep the string */ } }
    if (Array.isArray(p)) return p;
    var text = (p && typeof p === "object" && p.result !== undefined) ? p.result : p;
    if (typeof text !== "string") {
      lastRaw = "payload type=" + (typeof p) + " keys=" + (p && typeof p === "object" ? Object.keys(p).join(",") : "-");
      return null;
    }
    var m = text.match(/<untrusted-data-[^>]*>([\s\S]*?)<\/untrusted-data-[^>]*>/);
    var body = (m ? m[1] : text).trim();
    try { return JSON.parse(body); } catch (e) {
      lastRaw = "len=" + text.length + (m ? " (已取出區塊 " + body.length + ")" : " (找不到資料區塊)") +
        " 開頭:" + body.slice(0, 80) + " 結尾:" + body.slice(-40);
      return null;
    }
  }

  function sql(query) {
    if (!mcpCap) return Promise.reject({ code: "not_granted", message: "no connector" });
    return mcpCap.callTool(DB_SERVER, DB_TOOL, { project_id: DB_PROJECT, query: query }, { cache: false })
      .then(function (r) {
        var rows = parseSqlRows(r);
        if (rows === null) throw { code: "bad_response", message: "資料庫回應看不懂" + (lastRaw ? "（" + lastRaw + "）" : "") };
        return rows;
      });
  }

  // The whole ledger in one response was too big to come back intact, so the
  // load is paged and the FX conversion is done in SQL — each transaction
  // arrives with its TWD value already computed at that day's rate.
  var PAGE = 400;

  var STOCKS_SQL =
    "select coalesce(json_agg(json_build_array(key,display,market,currency,symbol,manual_price) order by key),'[]'::json) as d from klfan_stocks";

  function txPageSql(offset) {
    return "select coalesce(json_agg(json_build_array(id,stock_key,d,a,q,b,k,n,tw) order by id),'[]'::json) as d from (" +
      "select t.id, t.stock_key, t.tx_date::text as d, round(t.amount,4) as a, round(t.shares,6) as q," +
      " coalesce(t.bank,'') as b, t.kind as k, coalesce(t.note,'') as n," +
      " round(case when s.currency='USD' then t.amount * coalesce(" +
        "(select f.rate from klfan_fx_daily f where f.fx_date <= t.tx_date order by f.fx_date desc limit 1)," +
        "(select f2.rate from klfan_fx_daily f2 order by f2.fx_date desc limit 1))" +
      " else t.amount end, 4) as tw" +
      " from klfan_transactions t join klfan_stocks s on s.key = t.stock_key" +
      " order by t.id limit " + PAGE + " offset " + offset + ") q";
  }

  function firstCell(rows) {
    return rows && rows[0] ? rows[0].d : null;
  }

  function hydrateStocks(list) {
    var stocks = {};
    (list || []).forEach(function (r) {
      stocks[r[0]] = {
        display: r[1], market: r[2], currency: r[3], symbol: r[4] || "",
        currentPrice: r[5] === null ? null : Number(r[5]),
        transactions: []
      };
    });
    state.stocks = stocks;
  }

  function hydrateTxPage(list) {
    (list || []).forEach(function (r) {
      var s = state.stocks[r[1]];
      if (!s) return;
      s.transactions.push({
        id: r[0], date: r[2], amount: Number(r[3]), shares: Number(r[4]),
        bank: r[5] || "", kind: r[6], note: r[7] || "", twd: Number(r[8])
      });
    });
  }

  function cacheWrite(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: data })); } catch (e) {}
  }
  function cacheRead() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function dbErrorCopy(code, message) {
    switch (code) {
      case "needs_reauth":
        return "Supabase 授權過期了：到 claude.ai 設定 → 連接器 重新連接。";
      case "server_not_connected":
        return "找不到 Supabase 連接器：到 claude.ai 設定 → 連接器 加入 Supabase。";
      case "selection_required":
        return "你有多個 Supabase 連接器，請先選擇要用哪一個。";
      case "blocked_by_policy":
        return "組織政策擋下了 Supabase 呼叫。";
      case "approval_required":
        return "這個呼叫需要逐次核准，Artifact 目前不支援。";
      case "not_in_manifest":
        return "這個頁面沒有取得呼叫 Supabase 的授權。";
      case "server_not_found":
        return "Supabase 連接器已不存在。";
      case "tool_error":
        return "資料庫錯誤：" + (message || "查詢被拒絕");
      case "server_unavailable":
      case "rate_limited":
      case "upstream_error":
        return "暫時連不到資料庫";
      case "bad_response":
        return "資料庫回應格式看不懂" + (message ? "（" + message + "）" : "");
      default:
        return "資料庫目前不可用";
    }
  }

  function loadFromDb(isRetry) {
    db.loading = true;
    db.progress = 0;
    render();
    return sql(STOCKS_SQL).then(function (rows) {
      var list = firstCell(rows);
      if (!list) throw { code: "bad_response", message: "查無標的" };
      hydrateStocks(list);
      render();
      // page through the ledger; each page is a small, safely-sized response
      function nextPage(offset) {
        return sql(txPageSql(offset)).then(function (r2) {
          var page = firstCell(r2) || [];
          hydrateTxPage(page);
          db.progress = offset + page.length;
          render();
          if (page.length === PAGE) return nextPage(offset + PAGE);
        });
      }
      return nextPage(0);
    }).then(function () {
      cacheWrite(exportForCache());
      db.status = null;
      db.loading = false;
      db.fromCache = false;
      db.loadedAt = Date.now();
      render();
    }).catch(function (err) {
      var code = (err && err.code) || "upstream_error";
      if (!isRetry && err && err.retryable) {
        return new Promise(function (res) { setTimeout(res, 800 + Math.random() * 700); })
          .then(function () { return loadFromDb(true); });
      }
      db.loading = false;
      db.status = { code: code, message: dbErrorCopy(code, err && err.message) };
      var cached = cacheRead();
      if (cached && cached.data && !Object.keys(state.stocks).length) {
        hydrateStocks(cached.data.stocks);
        hydrateTxPage(cached.data.txs);
        db.fromCache = true;
        db.loadedAt = cached.at;
      }
      render();
    });
  }

  // Every mutation goes to Postgres first; the local copy is refreshed from
  // what the statement returns, so the page never drifts from the table.
  function mutate(query, applyLocal) {
    db.saving = true;
    render();
    return sql(query).then(function (rows) {
      if (applyLocal) applyLocal(rows);
      db.status = null;
      db.saving = false;
      cacheWrite(exportForCache());
      render();
    }).catch(function (err) {
      var code = (err && err.code) || "upstream_error";
      db.saving = false;
      db.status = { code: code, message: "存檔失敗 — " + dbErrorCopy(code, err && err.message) };
      render();
    });
  }

  function exportForCache() {
    var stocks = [], txs = [];
    Object.keys(state.stocks).forEach(function (k) {
      var s = state.stocks[k];
      stocks.push([k, s.display, s.market, s.currency, s.symbol, s.currentPrice]);
      s.transactions.forEach(function (t) {
        txs.push([t.id, k, t.date, t.amount, t.shares, t.bank, t.kind, t.note, t.twd]);
      });
    });
    return { stocks: stocks, txs: txs };
  }

  /* ---------- live quotes (Fugle + Twelve Data, via Supabase) ----------
     The page can't fetch anything itself — the Artifact CSP blocks every
     external domain — so it never talks to a quote API. A Supabase Edge
     Function does the fetching and parks the result in klfan_quotes; this
     page just reads that table over the same execute_sql path the ledger
     uses, and triggers a refresh by calling refresh_klfan_quotes(). The
     API keys stay in the function's secrets and never reach the browser.

     Only currently-held symbols are quoted: an exited position is worth 0
     whatever the price, and Twelve Data's free tier bills per symbol. */

  var QUOTES_SQL =
    "select coalesce(json_agg(json_build_array(symbol,price,currency,source,quoted_at," +
    "extract(epoch from updated_at)*1000) order by symbol),'[]'::json) as d from klfan_quotes";
  var REFRESH_SQL = "select refresh_klfan_quotes() as d";

  // Re-opening the page refreshes, but a reload loop shouldn't burn API
  // credits — anything fetched within this window is treated as current.
  var QUOTE_FRESH_MS = 60000;

  var live = {
    available: null,   // null = still resolving, false = no connector path
    prices: null,      // { symbol: { price, currency } }
    fx: null,
    fetchedAt: null,   // when the Edge Function last wrote these rows
    sources: null,     // { fugle: n, twelve_data: n }
    status: null,      // { code, message } for a degraded state
    busy: false
  };
  // mcpCap is declared once, up in the database section — both the ledger and
  // the quote feed share the same resolved capability.

  function applyQuoteRows(list) {
    // 各來源的 quoted_at 意義不同（台股是今天收盤，美股是前一交易日收盤），
    // 湊成單一「報價時間」只會誤導，所以只用抓取時間。
    var prices = {}, fx = null, sources = {}, newest = 0;
    (list || []).forEach(function (r) {
      var sym = r[0], price = Number(r[1]), cur = r[2], src = r[3], upd = Number(r[5]);
      if (!isFinite(price)) return;
      if (sym === "USD/TWD") { fx = price; }
      else { prices[sym] = { price: price, currency: cur }; sources[src] = (sources[src] || 0) + 1; }
      if (isFinite(upd) && upd > newest) newest = upd;
    });
    live.prices = prices;
    live.fx = fx;
    live.sources = sources;
    live.fetchedAt = newest || Date.now();
    live.status = null;
    live.available = true;
  }

  // Each code gets its own fix — never one generic "something went wrong".
  function quoteErrorCopy(code, message) {
    switch (code) {
      case "needs_reauth":
        return "Supabase 授權過期了：到 claude.ai 設定 → 連接器 重新連接後即可恢復報價。";
      case "server_not_connected":
        return "找不到 Supabase 連接器：到 claude.ai 設定 → 連接器 加入 Supabase。";
      case "selection_required":
        return "你有多個 Supabase 連接器，請先在提示中選擇要用哪一個。";
      case "blocked_by_policy":
        return "組織政策擋下了這個連接器呼叫，改用下方手動價格。";
      case "approval_required":
        return "這個呼叫需要逐次核准，目前在 Artifact 裡還不支援，改用下方手動價格。";
      case "not_in_manifest":
        return "這個頁面沒有取得呼叫該工具的授權。";
      case "server_not_found":
        return "報價來源的連接器已不存在。";
      // 下面兩個是抓取端自己回報的，不是連接器的問題。
      case "fugle_down":
        return "Fugle 抓不到台股報價" + (message ? "（" + message + "）" : "") + "，改用上次的價格。";
      case "twelve_quota":
        return "Twelve Data 額度用完了" + (message ? "：" + message : "") + "，美股改用上次的價格。";
      case "partial":
        return message || "部分標的沒抓到報價，那幾檔改用下方手動價格。";
      case "tool_error":
        return "更新報價失敗：" + (message || "資料庫回報錯誤");
      case "server_unavailable":
      case "rate_limited":
      case "upstream_error":
        return "暫時連不到 Supabase";
      default:
        return "報價目前不可用，改用下方手動價格。";
    }
  }

  var RETRACTING = { needs_reauth: 1, server_not_connected: 1, selection_required: 1, blocked_by_policy: 1, approval_required: 1, not_in_manifest: 1, server_not_found: 1 };
  var SILENT = { not_granted: 1, capability_disabled: 1, capability_removed: 1 };

  function handleQuoteError(err) {
    var code = (err && err.code) || "upstream_error";
    if (SILENT[code]) { live.available = false; live.status = null; render(); return; }
    if (RETRACTING[code]) { live.prices = null; live.fx = null; }
    live.available = true;
    live.status = { code: code, message: quoteErrorCopy(code, err && err.message) };
    render();
  }

  // Read whatever the last refresh left in the table. Cheap, and it means a
  // failed refresh still shows the previous prices instead of nothing.
  function loadQuotes() {
    return sql(QUOTES_SQL)
      .then(function (rows) { applyQuoteRows(firstCell(rows)); })
      .catch(function (e) { handleQuoteError(e); });
  }

  // One capability resolution drives both the database and the quote feed.
  function connect() {
    function offline() {
      live.available = false;
      db.available = false;
      db.loading = false;
      db.status = { code: "not_granted", message: "這個畫面連不到連接器，資料庫與報價都無法載入" };
      var cached = cacheRead();
      if (cached && cached.data) {
        hydrateStocks(cached.data.stocks);
        hydrateTxPage(cached.data.txs);
        db.fromCache = true;
        db.loadedAt = cached.at;
      }
      render();
    }
    if (typeof claude === "undefined" || !claude || !claude.use) { offline(); return; }
    claude.use("mcp").then(function (m) {
      if (!m) { offline(); return; }
      mcpCap = m;
      live.available = null;
      db.available = true;
      // 一次只發一個 execute_sql。帳本與報價現在都走 Supabase，同時發出去
      // 會讓回應對不上請求，解析直接失敗（報價原本走 Google Drive，是不同的
      // 連接器，所以以前不會有這個問題）。
      loadFromDb(false)
        .then(function () { return loadQuotes(); })
        .then(function () {
          // 開啟時更新一次 —— 但若上一次抓取還很新就不重抓，避免重整頁面
          // 就白白吃掉 Twelve Data 的額度。
          if (!live.fetchedAt || Date.now() - live.fetchedAt > QUOTE_FRESH_MS) refreshQuotes();
          else render();
        });
    }).catch(function () { offline(); });
  }

  // refresh_klfan_quotes() 同步跑完抓取才回來，所以按一次就拿得到結果 ——
  // 發請求的是資料庫而不是這個頁面，CSP 管不到。
  function refreshQuotes() {
    if (!mcpCap || live.busy) return;
    live.busy = true;
    render();
    sql(REFRESH_SQL)
      .then(function (rows) {
        var r = firstCell(rows) || {};
        return loadQuotes().then(function () {
          // 抓取本身的失敗與連接器的失敗要分開講，使用者的處置方式不同。
          if (r.error) live.status = { code: "tool_error", message: r.detail || r.error };
          else if (r.failed > 0) {
            var names = (r.failures || []).map(function (f) { return f.symbol; }).join("、");
            live.status = {
              code: r.twelveDetail ? "twelve_quota" : "partial",
              message: r.twelveDetail || (names + " 沒抓到報價")
            };
          }
        });
      })
      .catch(function (e) { handleQuoteError(e); })
      .then(function () { live.busy = false; render(); });
  }

  // 幣別不符就不採用即時價。資料庫裡確實有 market/currency 標錯的列
  // （例如 currency='TWD' 但 symbol='NASDAQ:AMSC'），拿美元價格當台幣用
  // 會算出一個沒有任何提示的錯誤市值 —— 寧可退回手動價格。
  function livePriceFor(s) {
    if (!live.prices || !s.symbol) return null;
    var q = live.prices[s.symbol];
    if (!q || typeof q.price !== "number") return null;
    if (q.currency && s.currency && q.currency !== s.currency) return null;
    return q.price;
  }

  function effectivePrice(s) {
    var lp = livePriceFor(s);
    return lp !== null ? lp : (s.currentPrice || null);
  }

  function effectiveFx() {
    return live.fx !== null && live.fx !== undefined ? live.fx : state.fxRate;
  }

  /* ---------- helpers ---------- */
  function fmtMoney(n, cur, opts) {
    opts = opts || {};
    if (n === null || n === undefined || isNaN(n)) return "—";
    var digits = cur === "USD" ? 2 : 0;
    var s = Math.abs(n).toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    var sign = n < 0 ? "-" : (opts.showPlus ? "+" : "");
    var symbol = cur === "USD" ? "$" : "NT$";
    return sign + symbol + s;
  }

  function fmtPct(n, opts) {
    opts = opts || {};
    if (n === null || n === undefined || isNaN(n)) return "—";
    var s = (n * 100).toLocaleString("zh-TW", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    var sign = n > 0 && opts.showPlus ? "+" : "";
    return sign + s + "%";
  }

  function fmtShares(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    var r = Math.round(n * 10000) / 10000;
    return r.toLocaleString("zh-TW", { maximumFractionDigits: 4 });
  }

  function fmtDate(d) {
    return d;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function uid(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2, 9);
  }

  /* ---------- finance math ---------- */
  function daysBetween(a, b) {
    var A = new Date(a + "T00:00:00Z").getTime();
    var B = new Date(b + "T00:00:00Z").getTime();
    return (B - A) / 86400000;
  }

  function xnpv(rate, cfs, base) {
    var total = 0;
    for (var i = 0; i < cfs.length; i++) {
      var t = daysBetween(base, cfs[i].date) / 365;
      total += cfs[i].amount / Math.pow(1 + rate, t);
    }
    return total;
  }

  // 掃描用的折現率網格：接近 -100% 的地方要密，往上逐漸放寬到 1000。
  function rateGrid() {
    var g = [-0.9999, -0.999, -0.995, -0.99, -0.98, -0.95, -0.9, -0.85, -0.8,
             -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1];
    var r = -0.05;
    while (r <= 1000) {
      g.push(Math.round(r * 1e6) / 1e6);
      r = r < 1 ? r + 0.01 : (r < 10 ? r + 0.1 : r * 1.15);
    }
    g.push(1000);
    return g;
  }

  // 現金流方向變號超過一次時，NPV 可能有多個根。直接在 [-1, 1000] 兩端試
  // 正負號會漏掉這種情形 —— 兩端同號不代表無解，可能是中間穿過去又穿回來。
  // 實際遇過：某個桶最早的現金流是一筆一週內就獲利出場的交易，NPV 在高折現率
  // 端翻回正的，兩端同號，整個市場別的 XIRR 就變成「—」。
  //
  // 所以改成先在網格上找出第一個變號區間，再在那個小區間裡二分。取到的是
  // 最小的根，也就是經濟意義上的那一個。單根時與原本的做法結果完全相同
  // （已用全部 39 檔標的與各市場別回歸驗證過）。
  function xirr(cfs) {
    if (!cfs.length) return null;
    var hasPos = cfs.some(function (c) { return c.amount > 0; });
    var hasNeg = cfs.some(function (c) { return c.amount < 0; });
    if (!hasPos || !hasNeg) return null;
    var base = cfs.reduce(function (m, c) { return c.date < m ? c.date : m; }, cfs[0].date);

    var g = rateGrid();
    var prevR = null, prevF = null;
    for (var i = 0; i < g.length; i++) {
      var f = xnpv(g[i], cfs, base);
      if (!isFinite(f)) { prevR = null; prevF = null; continue; }
      if (prevF !== null && (prevF < 0) !== (f < 0)) {
        var lo = prevR, flo = prevF, hi = g[i], mid = lo, fmid;
        for (var j = 0; j < 200; j++) {
          mid = (lo + hi) / 2;
          fmid = xnpv(mid, cfs, base);
          if (Math.abs(fmid) < 1e-9) break;
          if ((flo < 0) === (fmid < 0)) { lo = mid; flo = fmid; } else { hi = mid; }
        }
        return isFinite(mid) ? mid : null;
      }
      prevR = g[i]; prevF = f;
    }
    return null;
  }

  function currentShares(stock) {
    var s = 0;
    stock.transactions.forEach(function (t) { s += t.shares || 0; });
    return Math.round(s * 1e6) / 1e6;
  }

  function netInvested(stock) {
    // 買進支出 − 賣出回收 − 已收股息：全部現金流加總後反號（買進為負、賣出/股息為正）
    var n = 0;
    stock.transactions.forEach(function (t) { n -= t.amount; });
    return n;
  }

  function totalDividends(stock) {
    var n = 0;
    stock.transactions.forEach(function (t) { if (t.kind === "dividend") n += t.amount; });
    return n;
  }

  function currentValue(stock) {
    var sh = currentShares(stock);
    var price = effectivePrice(stock);
    if (!price || sh <= 0.0000001) return 0;
    return sh * price;
  }

  function totalPL(stock) {
    var sumAll = 0;
    stock.transactions.forEach(function (t) { sumAll += t.amount; });
    return sumAll + currentValue(stock);
  }

  function stockXirr(stock) {
    var cfs = stock.transactions.map(function (t) { return { date: t.date, amount: t.amount }; });
    var cv = currentValue(stock);
    var sh = currentShares(stock);
    if (sh > 0.0000001 && cv > 0) {
      cfs = cfs.concat([{ date: today(), amount: cv }]);
    }
    return xirr(cfs);
  }

  function today() {
    var d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function stockKeys() {
    return Object.keys(state.stocks);
  }

  /* ---------- portfolio aggregates ----------
     Cash flows arrive from SQL already converted at the rate of their own trade
     date (klfan_fx_daily, the same daily series the sheet's XLOOKUP used), so
     JS never converts a historical amount. Only *today's* unrealized market
     value uses the live rate — the historical/live split the original sheet
     drew between 目前市值 and 累計淨投入/XIRR. */
  function txTwd(t, s) {
    if (typeof t.twd === "number" && isFinite(t.twd)) return t.twd;
    // a row added in this session before a reload: value it at the live rate
    return s.currency === "USD" ? t.amount * effectiveFx() : t.amount;
  }

  function toTWD(amount, currency) {
    return currency === "USD" ? amount * effectiveFx() : amount;
  }

  function blankBucket() {
    return { value: 0, invested: 0, pl: 0, div: 0, cfs: [], holdings: 0, tickers: 0 };
  }

  function addToBucket(b, s) {
    var cv = currentValue(s); // today's value -> live/current rate
    var cvTwd = toTWD(cv, s.currency);
    var ni = 0, plCash = 0, div = 0;
    s.transactions.forEach(function (t) {
      var twd = txTwd(t, s); // historical, date-of-trade rate (computed in SQL)
      ni -= twd;
      plCash += twd;
      if (t.kind === "dividend") div += twd;
      b.cfs.push({ date: t.date, amount: twd });
    });
    b.value += cvTwd;
    b.invested += ni;
    b.pl += plCash + cvTwd;
    b.div += div;
    b.tickers += 1;
    if (currentShares(s) > 0.0000001) {
      b.holdings += 1;
      if (cv > 0) b.cfs.push({ date: today(), amount: cvTwd });
    }
  }

  function finishBucket(b) {
    b.xirr = xirr(b.cfs);
    b.returnPct = b.invested !== 0 ? b.pl / b.invested : null;
    return b;
  }

  // 台股 / 美股 / 合計 — same three-way split your 股票總表 summary block uses
  function marketStats() {
    var tw = blankBucket(), us = blankBucket(), all = blankBucket();
    stockKeys().forEach(function (k) {
      var s = state.stocks[k];
      addToBucket(s.market === "美股" ? us : tw, s);
      addToBucket(all, s);
    });
    return { 台股: finishBucket(tw), 美股: finishBucket(us), 合計: finishBucket(all) };
  }

  function portfolioStats() {
    var m = marketStats();
    var a = m["合計"];
    return {
      totalValue: a.value,
      totalInvested: a.invested,
      totalPL: a.pl,
      totalDiv: a.div,
      blendedXirr: a.xirr,
      markets: m
    };
  }

  /* ---------- rendering ---------- */
  function sortedKeys() {
    var keys = stockKeys().filter(function (k) {
      var s = state.stocks[k];
      if (ui.market !== "all" && s.market !== ui.market) return false;
      return currentShares(s) > 0.0000001 || s.transactions.length > 0;
    });
    keys.sort(function (a, b) {
      var sa = state.stocks[a], sb = state.stocks[b];
      if (ui.sort === "xirr") {
        var xa = stockXirr(sa), xb = stockXirr(sb);
        return (xb === null ? -Infinity : xb) - (xa === null ? -Infinity : xa);
      }
      if (ui.sort === "value") {
        return toTWD(currentValue(sb), sb.currency) - toTWD(currentValue(sa), sa.currency);
      }
      if (ui.sort === "name") {
        return sa.display.localeCompare(sb.display, "zh-Hant");
      }
      // pl default
      return toTWD(totalPL(sb), sb.currency) - toTWD(totalPL(sa), sa.currency);
    });
    return keys;
  }

  function plClass(n) {
    if (n === null || n === undefined || isNaN(n)) return "neu";
    return n > 0 ? "gain" : (n < 0 ? "loss" : "neu");
  }

  function render() {
    var app = document.getElementById("app");
    app.innerHTML = renderApp();
    attachHandlers();
  }

  function renderApp() {
    var stats = portfolioStats();
    return (
      '<header class="topbar">' +
        '<div class="brand">' +
          '<span class="brand-mark">KL</span>' +
          '<div class="brand-text"><h1>投資追蹤台帳</h1><p class="sub">個股年化報酬與損益 · 即時報價</p></div>' +
        "</div>" +
      "</header>" +

      '<section class="summary">' +
        statTile("目前總市值", fmtMoney(stats.totalValue, "TWD"), "TWD 換算", "neu") +
        statTile("累計淨投入", fmtMoney(stats.totalInvested, "TWD"), "TWD 換算", "neu") +
        statTile("總損益", fmtMoney(stats.totalPL, "TWD", { showPlus: true }), fmtPct(stats.totalInvested ? stats.totalPL / stats.totalInvested : null, { showPlus: true }), plClass(stats.totalPL)) +
        statTile("整體年化報酬", fmtPct(stats.blendedXirr, { showPlus: true }), "美股現金流採歷史當日匯率", plClass(stats.blendedXirr)) +
      "</section>" +

      renderDbBar() +

      renderLiveBar() +

      renderMarketTable(stats.markets) +

      '<section class="toolbar">' +
        '<div class="sortgroup" role="tablist" aria-label="市場">' +
          marketBtn("all", "全部") + marketBtn("台股", "台股") + marketBtn("美股", "美股") +
        "</div>" +
        '<button class="btn btn-add" id="btn-add-stock" type="button">＋ 新增個股</button>' +
      "</section>" +

      '<section class="toolbar">' +
        '<div class="sortgroup" role="tablist" aria-label="排序方式">' +
          sortBtn("pl", "損益") + sortBtn("xirr", "年化報酬") + sortBtn("value", "市值") + sortBtn("name", "名稱") +
        "</div>" +
      "</section>" +

      (ui.addingStockOpen ? renderAddStockForm() : "") +

      '<section class="stocklist">' + sortedKeys().map(renderStockCard).join("") + "</section>" +

      '<footer class="foot">' +
        "<p>交易資料存在你自己的 Supabase（klfan_stocks／klfan_transactions／klfan_fx_daily），" +
        "原始資料匯入自 Google Sheet「KLFAN_管理」（2026/09/01）。" +
        "在這裡新增或刪除會直接寫進資料庫，但不會回寫 Google Sheet。" +
        "報價由 Supabase Edge Function 抓取後存進 klfan_quotes：" +
        "台股來自 Fugle，美股與匯率來自 Twelve Data，只抓仍持有的標的。</p>" +
      "</footer>"
    );
  }

  function renderDbBar() {
    var btn = '<button class="btn btn-sm btn-ghost" id="btn-reload-db" type="button"' +
      (db.loading ? " disabled" : "") + ">" + (db.loading ? "載入中…" : "重新載入") + "</button>";
    if (db.loading) {
      var got = db.progress || 0;
      return '<section class="livebar pending"><span class="dot"></span><span class="livetext">' +
        (got ? "正在從資料庫載入…已讀 " + got + " 筆交易" : "正在從資料庫載入…") + "</span></section>";
    }
    if (db.status) {
      var tail = db.fromCache ? "，顯示的是本機上次載入的快照" : (Object.keys(state.stocks).length ? "" : "，目前沒有資料可顯示");
      return '<section class="livebar warn"><span class="dot"></span><span class="livetext">' +
        escapeHtml(db.status.message) + escapeHtml(tail) + "</span>" + btn + "</section>";
    }
    var n = Object.keys(state.stocks).length;
    var txn = Object.keys(state.stocks).reduce(function (a, k) { return a + state.stocks[k].transactions.length; }, 0);
    var when = db.loadedAt ? new Date(db.loadedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" }) : "";
    return (
      '<section class="livebar ok"><span class="dot"></span><span class="livetext">' +
        "Supabase｜" + n + " 檔・" + txn + " 筆交易｜讀取於 " + when +
        (db.saving ? "｜儲存中…" : "") +
      "</span>" + btn + "</section>"
    );
  }

  function renderLiveBar() {
    if (live.available === false) return "";
    if (live.available === null) {
      return '<section class="livebar pending"><span class="dot"></span>正在連線報價來源…</section>';
    }
    var count = live.prices ? Object.keys(live.prices).length : 0;
    var btn = '<button class="btn btn-sm btn-ghost" id="btn-refresh-quotes" type="button"' +
      (live.busy ? " disabled" : "") + ">" + (live.busy ? "更新中…" : "重新整理") + "</button>";

    if (live.status) {
      var stale = count ? "，以下顯示上次抓到的報價" : "，改用下方手動價格";
      return '<section class="livebar warn"><span class="dot"></span><span class="livetext">' +
        escapeHtml(live.status.message) + escapeHtml(stale) + "</span>" + btn + "</section>";
    }
    if (!count) {
      return '<section class="livebar pending"><span class="dot"></span><span class="livetext">報價載入中…</span>' + btn + "</section>";
    }
    var when = live.fetchedAt ? new Date(live.fetchedAt).toLocaleString("zh-TW") : "—";
    var src = live.sources || {};
    var srcText = [];
    if (src.fugle) srcText.push("台股 " + src.fugle + " 檔 Fugle");
    if (src.twelve_data) srcText.push("美股 " + src.twelve_data + " 檔 Twelve Data");
    return (
      '<section class="livebar ok"><span class="dot"></span>' +
        '<span class="livetext">' + (srcText.join("／") || "報價 " + count + " 檔") +
        "｜USD/TWD " + (live.fx ? live.fx.toFixed(4) : "—") +
        "｜更新於 " + escapeHtml(when) + "</span>" + btn +
      "</section>"
    );
  }

  function statTile(label, value, sub, cls) {
    return (
      '<div class="tile">' +
        '<p class="tile-label">' + label + "</p>" +
        '<p class="tile-value ' + cls + '">' + value + "</p>" +
        '<p class="tile-sub">' + sub + "</p>" +
      "</div>"
    );
  }

  function sortBtn(key, label) {
    var active = ui.sort === key ? " active" : "";
    return '<button class="sortbtn' + active + '" data-sort="' + key + '" type="button">' + label + "</button>";
  }

  function marketBtn(key, label) {
    var active = ui.market === key ? " active" : "";
    return '<button class="sortbtn' + active + '" data-market="' + key + '" type="button">' + label + "</button>";
  }

  // 台股 / 美股 / 合計 breakdown — mirrors the 績效統計 block in 股票總表
  function renderMarketTable(m) {
    var cols = ["台股", "美股", "合計"];
    function row(label, pick, cls) {
      return "<tr><th>" + label + "</th>" +
        cols.map(function (c) {
          var v = pick(m[c]);
          return '<td class="num ' + (cls ? cls(m[c]) : "") + '">' + v + "</td>";
        }).join("") + "</tr>";
    }
    return (
      '<section class="card markettable">' +
        '<div class="mt-head"><h3>台股 ／ 美股 分開看</h3><span class="mt-note">全部以台幣計算</span></div>' +
        '<div class="txtable-wrap"><table class="txtable mt">' +
        "<thead><tr><th>指標</th>" + cols.map(function (c) {
          return "<th class=\"num\">" + c + (c === "合計" ? "" : "（" + m[c].tickers + " 檔）") + "</th>";
        }).join("") + "</tr></thead><tbody>" +
        row("累計淨投入", function (b) { return fmtMoney(b.invested, "TWD"); }) +
        row("目前市值", function (b) { return fmtMoney(b.value, "TWD"); }) +
        row("累計股息", function (b) { return fmtMoney(b.div, "TWD"); }) +
        row("累計損益", function (b) { return fmtMoney(b.pl, "TWD", { showPlus: true }); }, function (b) { return plClass(b.pl); }) +
        row("總報酬率", function (b) { return fmtPct(b.returnPct, { showPlus: true }); }, function (b) { return plClass(b.returnPct); }) +
        row("年化報酬 XIRR", function (b) { return fmtPct(b.xirr, { showPlus: true }); }, function (b) { return plClass(b.xirr); }) +
        row("目前持有檔數", function (b) { return b.holdings + " / " + b.tickers; }) +
        "</tbody></table></div>" +
      "</section>"
    );
  }

  function renderAddStockForm() {
    return (
      '<section class="card addcard">' +
        '<h3>新增個股</h3>' +
        '<form id="form-add-stock" class="form-grid">' +
          '<label>代號／名稱<input type="text" name="display" placeholder="例如 00981A 或 AAPL" required></label>' +
          '<label>幣別<select name="currency"><option value="TWD">TWD 台股</option><option value="USD">USD 美股</option></select></label>' +
          '<label>報價代碼（選填，例如 TPE:2330 或 NASDAQ:AAPL）<input type="text" name="symbol" placeholder="留空則不抓即時價"></label>' +
          '<div class="form-actions"><button type="submit" class="btn btn-primary">建立</button>' +
          '<button type="button" class="btn btn-ghost" id="btn-cancel-add-stock">取消</button></div>' +
        "</form>" +
      "</section>"
    );
  }

  function renderStockCard(key) {
    var s = state.stocks[key];
    var sh = currentShares(s);
    var cv = currentValue(s);
    var ni = netInvested(s);
    var pl = totalPL(s);
    var plPct = ni !== 0 ? pl / ni : null;
    var x = stockXirr(s);
    var open = ui.openKey === key;
    var cur = s.currency;

    var invBar = 0, valBar = 0, maxBar = Math.max(Math.abs(ni), Math.abs(cv), 1);
    invBar = Math.min(100, Math.abs(ni) / maxBar * 100);
    valBar = Math.min(100, Math.abs(cv) / maxBar * 100);

    return (
      '<article class="card stockcard' + (open ? " open" : "") + '" data-key="' + escapeHtml(key) + '">' +
        '<button type="button" class="stockhead" data-toggle="' + escapeHtml(key) + '">' +
          '<div class="stockid">' +
            '<span class="ticker">' + escapeHtml(s.display) + '</span>' +
            '<span class="curbadge">' + escapeHtml(s.market || "") + " · " + cur + (sh > 0.0000001 ? "" : " · 已出清") + "</span>" +
          "</div>" +
          '<div class="stockmetrics">' +
            '<div class="metric"><span class="m-label">損益</span><span class="m-value ' + plClass(pl) + '">' + fmtMoney(pl, cur, { showPlus: true }) + "</span>" +
              '<span class="m-sub ' + plClass(pl) + '">' + fmtPct(plPct, { showPlus: true }) + "</span></div>" +
            '<div class="metric"><span class="m-label">年化報酬</span><span class="m-value ' + plClass(x) + '">' + fmtPct(x, { showPlus: true }) + "</span></div>" +
          "</div>" +
          '<span class="chev">' + (open ? "－" : "＋") + "</span>" +
        "</button>" +

        (open ? renderStockDetail(key, s, sh, cv, ni, invBar, valBar) : "") +
      "</article>"
    );
  }

  function holdingYears(s) {
    if (!s.transactions.length) return null;
    var first = s.transactions.reduce(function (m, t) { return t.date < m ? t.date : m; }, s.transactions[0].date);
    var end = currentShares(s) > 0.0000001
      ? today()
      : s.transactions.reduce(function (m, t) { return t.date > m ? t.date : m; }, s.transactions[0].date);
    return daysBetween(first, end) / 365;
  }

  function espp(s) {
    // 公提 = 公司提撥、自提 = 自己提撥（員工持股信託）
    // 只累計「提撥進去」的金額（負現金流），賣出不抵銷
    var out = { 公提: 0, 自提: 0 };
    s.transactions.forEach(function (t) {
      if (t.amount >= 0) return;
      if ((t.note || "").indexOf("公提") >= 0) out["公提"] -= t.amount;
      else if ((t.note || "").indexOf("自提") >= 0) out["自提"] -= t.amount;
    });
    return out;
  }

  function renderStockDetail(key, s, sh, cv, ni, invBar, valBar) {
    var rows = s.transactions.slice().sort(function (a, b) { return b.date < a.date ? -1 : (b.date > a.date ? 1 : 0); });
    var div = totalDividends(s);
    var pl = totalPL(s);
    var yrs = holdingYears(s);
    var plan = espp(s);
    var hasPlan = plan["公提"] !== 0 || plan["自提"] !== 0;
    return (
      '<div class="stockbody">' +
        '<div class="minibars">' +
          '<div class="minibar-row"><span>淨投入</span><div class="bar"><div class="bar-fill inv" style="width:' + invBar + '%"></div></div><b>' + fmtMoney(ni, s.currency) + "</b></div>" +
          '<div class="minibar-row"><span>目前市值</span><div class="bar"><div class="bar-fill val" style="width:' + valBar + '%"></div></div><b>' + fmtMoney(cv, s.currency) + "</b></div>" +
        "</div>" +

        '<div class="factgrid">' +
          fact("累計股息", fmtMoney(div, s.currency), div > 0 ? "gain" : "") +
          fact("累計損益", fmtMoney(pl, s.currency, { showPlus: true }), plClass(pl)) +
          fact("投資期間", yrs === null ? "—" : yrs.toFixed(2) + " 年", "") +
          fact("首筆交易", rows.length ? rows[rows.length - 1].date : "—", "") +
          (hasPlan ? fact("公司提撥", fmtMoney(plan["公提"], s.currency), "") : "") +
          (hasPlan ? fact("自行提撥", fmtMoney(plan["自提"], s.currency), "") : "") +
        "</div>" +

        '<div class="pricebar">' +
          (livePriceFor(s) !== null
            ? '<div class="liveprice"><span class="f-label">目前股價 <em>即時</em></span>' +
                "<b>" + fmtMoney(livePriceFor(s), s.currency) + "</b>" +
                '<span class="symnote">' + escapeHtml(s.symbol || "") + "</span></div>"
            : "") +
          "<label>" + (livePriceFor(s) !== null ? "備援股價" : "目前股價") + "（" + s.currency + "）" +
            '<input type="number" step="0.0001" class="price-input" data-key="' + escapeHtml(key) + '" value="' + (s.currentPrice === null || s.currentPrice === undefined ? "" : s.currentPrice) + '" placeholder="尚未設定">' +
          "</label>" +
          '<span class="shareinfo">持有 ' + fmtShares(sh) + " 股</span>" +
          '<button class="btn btn-danger btn-sm" data-delstock="' + escapeHtml(key) + '" type="button">刪除個股</button>' +
        "</div>" +

        '<div class="txhead">' +
          "<h4>交易紀錄（" + rows.length + " 筆）</h4>" +
          '<button class="btn btn-primary btn-sm" data-addtx="' + escapeHtml(key) + '" type="button">＋ 新增交易</button>' +
        "</div>" +

        (ui.addingTxFor === key ? renderTxForm(key) : "") +

        '<div class="txtable-wrap"><table class="txtable"><thead><tr>' +
          "<th>日期</th><th>類型</th><th>金額</th><th>股數異動</th><th>銀行</th><th></th>" +
        "</tr></thead><tbody>" +
        rows.map(function (t) { return renderTxRow(key, t); }).join("") +
        "</tbody></table></div>" +
      "</div>"
    );
  }

  function fact(label, value, cls) {
    return '<div class="fact"><span class="f-label">' + label + '</span><span class="f-value ' + (cls || "") + '">' + value + "</span></div>";
  }

  function renderTxForm(key) {
    var s = state.stocks[key];
    return (
      '<form class="txform" data-txform="' + escapeHtml(key) + '">' +
        '<label>日期<input type="date" name="date" value="' + today() + '" required></label>' +
        '<label>類型<select name="kind"><option value="trade">買賣（股票）</option><option value="dividend">股息</option></select></label>' +
        '<label>金額（' + s.currency + '，買進為負、賣出／股息為正）<input type="number" step="0.01" name="amount" required></label>' +
        '<label>股數異動（買進為正、賣出為負，股息填 0）<input type="number" step="0.000001" name="shares" value="0" required></label>' +
        '<label>銀行／備註（選填）<input type="text" name="bank"></label>' +
        '<div class="form-actions"><button type="submit" class="btn btn-primary btn-sm">儲存</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-canceltx="' + escapeHtml(key) + '">取消</button></div>' +
      "</form>"
    );
  }

  function renderTxRow(key, t) {
    var kindLabel = t.kind === "dividend" ? "股息" : (t.amount < 0 ? "買進" : "賣出");
    var kindClass = t.kind === "dividend" ? "tag-div" : (t.amount < 0 ? "tag-buy" : "tag-sell");
    var note = t.note || "";
    if (note.indexOf("公提") >= 0) kindLabel += "·公提";
    else if (note.indexOf("自提") >= 0) kindLabel += "·自提";
    var s = state.stocks[key];
    return (
      "<tr>" +
        "<td>" + fmtDate(t.date) + "</td>" +
        '<td><span class="tag ' + kindClass + '">' + kindLabel + "</span></td>" +
        '<td class="num">' + fmtMoney(t.amount, s.currency, { showPlus: true }) + "</td>" +
        '<td class="num">' + (t.shares ? fmtShares(t.shares) : "—") + "</td>" +
        "<td>" + escapeHtml(t.bank || "—") + "</td>" +
        '<td><button class="rowdel" data-deltx="' + t.id + '" data-key="' + escapeHtml(key) + '" type="button" aria-label="刪除">✕</button></td>' +
      "</tr>"
    );
  }

  /* ---------- event handling ---------- */
  function attachHandlers() {
    var app = document.getElementById("app");

    var reloadBtn = document.getElementById("btn-reload-db");
    if (reloadBtn) reloadBtn.addEventListener("click", function () {
      loadFromDb(false).then(function () { return loadQuotes(); });
    });

    app.querySelectorAll("[data-sort]").forEach(function (b) {
      b.addEventListener("click", function () { ui.sort = b.getAttribute("data-sort"); render(); });
    });

    var refreshBtn = document.getElementById("btn-refresh-quotes");
    if (refreshBtn) refreshBtn.addEventListener("click", refreshQuotes);

    app.querySelectorAll("[data-market]").forEach(function (b) {
      b.addEventListener("click", function () {
        ui.market = b.getAttribute("data-market");
        ui.openKey = null;
        render();
      });
    });

    var addStockBtn = document.getElementById("btn-add-stock");
    if (addStockBtn) addStockBtn.addEventListener("click", function () {
      ui.addingStockOpen = !ui.addingStockOpen; render();
    });
    var cancelAdd = document.getElementById("btn-cancel-add-stock");
    if (cancelAdd) cancelAdd.addEventListener("click", function () { ui.addingStockOpen = false; render(); });
    var addForm = document.getElementById("form-add-stock");
    if (addForm) addForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var fd = new FormData(addForm);
      var display = (fd.get("display") || "").toString().trim();
      var currency = fd.get("currency");
      if (!display) return;
      var symbol = (fd.get("symbol") || "").toString().trim();
      var market = currency === "USD" ? "美股" : "台股";
      var key = display;
      if (state.stocks[key]) key = display + "-" + uid("s");
      mutate(
        "insert into klfan_stocks (key,display,market,currency,symbol) values (" +
          sq(key) + "," + sq(display) + "," + sq(market) + "," + sq(currency) + "," + sq(symbol) +
        ") returning key",
        function () {
          state.stocks[key] = {
            display: display, market: market, currency: currency,
            symbol: symbol, currentPrice: null, transactions: []
          };
          ui.addingStockOpen = false;
          ui.openKey = key;
        }
      );
    });

    app.querySelectorAll("[data-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-toggle");
        ui.openKey = ui.openKey === k ? null : k;
        ui.addingTxFor = null;
        render();
      });
    });

    app.querySelectorAll(".price-input").forEach(function (inp) {
      inp.addEventListener("change", function () {
        var k = inp.getAttribute("data-key");
        var v = parseFloat(inp.value);
        var val = isNaN(v) ? null : v;
        mutate(
          "update klfan_stocks set manual_price=" + (val === null ? "null" : snum(val)) +
            " where key=" + sq(k) + " returning key",
          function () { state.stocks[k].currentPrice = val; }
        );
      });
    });

    app.querySelectorAll("[data-delstock]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-delstock");
        if (!confirm("確定要刪除「" + state.stocks[k].display + "」及其所有交易紀錄嗎？")) return;
        mutate(
          "delete from klfan_stocks where key=" + sq(k) + " returning key",
          function () { delete state.stocks[k]; ui.openKey = null; }
        );
      });
    });

    app.querySelectorAll("[data-addtx]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-addtx");
        ui.addingTxFor = ui.addingTxFor === k ? null : k;
        render();
      });
    });
    app.querySelectorAll("[data-canceltx]").forEach(function (b) {
      b.addEventListener("click", function () { ui.addingTxFor = null; render(); });
    });

    app.querySelectorAll("[data-txform]").forEach(function (f) {
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var k = f.getAttribute("data-txform");
        var fd = new FormData(f);
        var kind = fd.get("kind");
        var amount = parseFloat(fd.get("amount"));
        var shares = parseFloat(fd.get("shares") || "0");
        var date = fd.get("date");
        var bank = (fd.get("bank") || "").toString().trim();
        if (isNaN(amount) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return;
        var sh = isNaN(shares) ? 0 : shares;
        var note = kind === "dividend" ? "股息" : "股票";
        mutate(
          "insert into klfan_transactions (stock_key,tx_date,amount,shares,bank,kind,note) values (" +
            sq(k) + "," + sdate(date) + "," + snum(amount) + "," + snum(sh) + "," +
            sq(bank) + "," + sq(kind === "dividend" ? "dividend" : "trade") + "," + sq(note) +
          ") returning id",
          function (rows) {
            var newId = rows && rows[0] ? rows[0].id : Date.now();
            state.stocks[k].transactions.push({
              id: newId, date: date, amount: amount, shares: sh,
              bank: bank, kind: kind, note: note
            });
            ui.addingTxFor = null;
          }
        );
      });
    });

    app.querySelectorAll("[data-deltx]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = parseInt(b.getAttribute("data-deltx"), 10);
        var k = b.getAttribute("data-key");
        if (!isFinite(id)) return;
        mutate(
          "delete from klfan_transactions where id=" + snum(id) + " returning id",
          function () {
            state.stocks[k].transactions = state.stocks[k].transactions.filter(function (t) { return t.id !== id; });
          }
        );
      });
    });
  }

  /* ---------- init ---------- */
  function init() {
    // Postgres is the store of record. The page ships with no data at all —
    // it renders a loading shell, then fills from the database.
    render();
    connect();
  }

  init();
})();
