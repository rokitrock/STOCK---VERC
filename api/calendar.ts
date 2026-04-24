// api/calendar.ts — Vercel serverless function
// Yahoo Finance quoteSummary for earnings/dividend dates.
// Supports same YAHOO_PROXY_URL fallback as prices.ts.
//
// Yahoo's quoteSummary endpoint requires a cookie + crumb handshake. We first
// try a plain request; if Yahoo rejects it (401/403/429), we fetch a cookie
// from fc.yahoo.com (with finance.yahoo.com as a fallback), exchange it for a
// crumb at /v1/test/getcrumb, and retry with the crumb query param + Cookie
// header. The crumb is cached in-memory for 30 minutes so repeated calls
// within the same serverless instance don't re-handshake.
//
// Append ?debug=1 to the query to surface per-ticker failure reasons
// (HTTP statuses and crumb state) in the response body. Useful when the
// calendar appears empty and you need to know whether Yahoo is blocking
// Vercel's IPs entirely vs. simply not having data for a ticker.
import type { VercelRequest, VercelResponse } from "@vercel/node";

type CalendarEvent = {
  ticker: string;
  date: string;
  type: "earnings" | "ex_dividend" | "dividend";
  label: string;
  estimate?: boolean;
};

type FetchOutcome = {
  status: number;
  bodySnippet?: string;
  error?: string;
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const baseHeaders = (): Record<string, string> => ({
  "User-Agent": USER_AGENT,
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://finance.yahoo.com/",
  Origin: "https://finance.yahoo.com",
});

let cachedCreds: { crumb: string; cookie: string; expires: number } | null = null;
let lastCrumbError: string | null = null;

function viaProxy(targetUrl: string): string {
  const proxyBase = process.env.YAHOO_PROXY_URL;
  return proxyBase
    ? `${proxyBase.replace(/\/$/, "")}/?url=${encodeURIComponent(targetUrl)}`
    : targetUrl;
}

function extractCookies(res: Response): string {
  const rawGetSetCookie = (res.headers as any).getSetCookie?.();
  const lines: string[] = Array.isArray(rawGetSetCookie) ? rawGetSetCookie : [];

  if (lines.length === 0) {
    const single = res.headers.get("set-cookie");
    if (single) {
      for (const part of single.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
        lines.push(part);
      }
    }
  }

  return lines
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function fetchCookieFrom(url: string): Promise<string> {
  try {
    const res = await fetch(viaProxy(url), {
      headers: baseHeaders(),
      redirect: "manual",
    });
    return extractCookies(res);
  } catch (err) {
    lastCrumbError = `cookie fetch ${url}: ${err instanceof Error ? err.message : String(err)}`;
    return "";
  }
}

async function getCrumbAndCookie(): Promise<
  { crumb: string; cookie: string } | null
> {
  if (cachedCreds && cachedCreds.expires > Date.now()) {
    return { crumb: cachedCreds.crumb, cookie: cachedCreds.cookie };
  }

  const cookieSources = [
    "https://fc.yahoo.com/",
    "https://finance.yahoo.com/quote/AAPL/",
    "https://login.yahoo.com/",
  ];

  let cookie = "";
  for (const src of cookieSources) {
    cookie = await fetchCookieFrom(src);
    if (cookie) break;
  }

  if (!cookie) {
    lastCrumbError = lastCrumbError || "no Set-Cookie from any Yahoo endpoint";
    return null;
  }

  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const crumbRes = await fetch(viaProxy(`https://${host}/v1/test/getcrumb`), {
        headers: { ...baseHeaders(), Cookie: cookie },
      });

      if (!crumbRes.ok) {
        lastCrumbError = `getcrumb ${host}: HTTP ${crumbRes.status}`;
        continue;
      }
      const crumb = (await crumbRes.text()).trim();
      if (!crumb || crumb.length > 64) {
        lastCrumbError = `getcrumb ${host}: empty/invalid crumb`;
        continue;
      }

      cachedCreds = {
        crumb,
        cookie,
        expires: Date.now() + 30 * 60 * 1000,
      };
      lastCrumbError = null;
      return { crumb, cookie };
    } catch (err) {
      lastCrumbError = `getcrumb ${host}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return null;
}

async function fetchQuoteSummary(
  ticker: string,
  creds: { crumb: string; cookie: string } | null
): Promise<{ data: any | null; outcome: FetchOutcome }> {
  const yahooHost = "query1.finance.yahoo.com";
  const modules = "calendarEvents,summaryDetail";
  const crumbParam = creds ? `&crumb=${encodeURIComponent(creds.crumb)}` : "";
  const yahooPath = `/v10/finance/quoteSummary/${encodeURIComponent(
    ticker
  )}?modules=${modules}${crumbParam}`;

  const yahooUrl = `https://${yahooHost}${yahooPath}`;
  const url = viaProxy(yahooUrl);

  const headers = baseHeaders();
  if (creds) headers.Cookie = creds.cookie;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      let snippet = "";
      try {
        snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim();
      } catch {}
      return { data: null, outcome: { status: res.status, bodySnippet: snippet } };
    }
    const data = await res.json();
    return { data, outcome: { status: res.status } };
  } catch (err) {
    return {
      data: null,
      outcome: {
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCalendar(
  ticker: string
): Promise<{ events: CalendarEvent[]; debug: Record<string, unknown> }> {
  const debug: Record<string, unknown> = {};

  let { data, outcome } = await fetchQuoteSummary(ticker, null);
  debug.plain = outcome;

  const needsCrumb =
    !data ||
    outcome.status === 401 ||
    outcome.status === 403 ||
    outcome.status === 429 ||
    outcome.status === 0;

  if (needsCrumb) {
    const creds = await getCrumbAndCookie();
    debug.crumbObtained = !!creds;
    if (!creds && lastCrumbError) debug.crumbError = lastCrumbError;
    if (creds) {
      const retry = await fetchQuoteSummary(ticker, creds);
      data = retry.data;
      debug.retry = retry.outcome;
    }
  }

  if (!data) return { events: [], debug };

  const result = data?.quoteSummary?.result?.[0];
  if (!result) {
    debug.reason = "no quoteSummary.result in response";
    return { events: [], debug };
  }

  const events: CalendarEvent[] = [];
  const cal = result.calendarEvents;
  if (!cal) {
    debug.reason = "no calendarEvents in result";
    return { events, debug };
  }

  const earningsDates = cal.earnings?.earningsDate;
  const isEstimate = cal.earnings?.isEarningsDateEstimate ?? false;
  if (Array.isArray(earningsDates) && earningsDates.length > 0) {
    for (const d of earningsDates) {
      const raw = typeof d === "object" ? d?.raw : d;
      if (!raw || typeof raw !== "number") continue;
      events.push({
        ticker,
        date: new Date(raw * 1000).toISOString().split("T")[0],
        type: "earnings",
        label: earningsDates.length > 1 ? "Earnings (est. window)" : "Earnings",
        estimate: isEstimate || earningsDates.length > 1,
      });
    }
  }

  const exDiv = cal.exDividendDate?.raw ?? cal.exDividendDate;
  if (typeof exDiv === "number" && exDiv > 0) {
    events.push({
      ticker,
      date: new Date(exDiv * 1000).toISOString().split("T")[0],
      type: "ex_dividend",
      label: "Ex-Dividend",
    });
  }

  const divPay = cal.dividendDate?.raw ?? cal.dividendDate;
  if (typeof divPay === "number" && divPay > 0) {
    events.push({
      ticker,
      date: new Date(divPay * 1000).toISOString().split("T")[0],
      type: "dividend",
      label: "Dividend Paid",
    });
  }

  return { events, debug };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const tickersParam = req.query.tickers;
    const tickersStr = Array.isArray(tickersParam) ? tickersParam[0] : tickersParam;
    const debugRequested = req.query.debug === "1" || req.query.debug === "true";

    if (!tickersStr) {
      res.status(400).json({ error: "Missing 'tickers' query parameter" });
      return;
    }

    const tickers = String(tickersStr)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const results = await Promise.all(tickers.map(fetchCalendar));
    const allEvents: CalendarEvent[] = results.flatMap((r) => r.events);

    const seen = new Set<string>();
    const events = allEvents.filter((e) => {
      const key = `${e.ticker}|${e.date}|${e.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    events.sort((a, b) => a.date.localeCompare(b.date));

    const withData = new Set(events.map((e) => e.ticker));
    const noData = tickers.filter((t) => !withData.has(t));

    const payload: Record<string, unknown> = {
      events,
      noData,
      proxied: !!process.env.YAHOO_PROXY_URL,
      updatedAt: new Date().toISOString(),
    };

    if (debugRequested) {
      const perTicker: Record<string, unknown> = {};
      tickers.forEach((t, i) => {
        perTicker[t] = results[i].debug;
      });
      payload.debug = perTicker;
    }

    if (noData.length === tickers.length) {
      res.setHeader("Cache-Control", "no-store");
    } else {
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
    }
    res.status(200).json(payload);
  } catch (err) {
    console.error("calendar handler crashed:", err);
    res.status(500).json({
      error: "Handler crashed",
      message: err instanceof Error ? err.message : String(err),
      events: [],
      noData: [],
    });
  }
}
