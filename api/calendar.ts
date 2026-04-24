// api/calendar.ts — Vercel serverless function
// Yahoo Finance quoteSummary for earnings/dividend dates.
// Supports same YAHOO_PROXY_URL fallback as prices.ts.
//
// Yahoo's quoteSummary endpoint requires a cookie + crumb handshake. We first
// try a plain request; if Yahoo rejects it (401/403/429), we fetch a cookie
// from fc.yahoo.com, exchange it for a crumb at /v1/test/getcrumb, and retry
// with the crumb query param + Cookie header. The crumb is cached in-memory
// for 30 minutes so repeated calls within the same serverless instance don't
// re-handshake.
import type { VercelRequest, VercelResponse } from "@vercel/node";

type CalendarEvent = {
  ticker: string;
  date: string;
  type: "earnings" | "ex_dividend" | "dividend";
  label: string;
  estimate?: boolean;
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

async function getCrumbAndCookie(): Promise<
  { crumb: string; cookie: string } | null
> {
  if (cachedCreds && cachedCreds.expires > Date.now()) {
    return { crumb: cachedCreds.crumb, cookie: cachedCreds.cookie };
  }

  try {
    const cookieRes = await fetch("https://fc.yahoo.com/", {
      headers: baseHeaders(),
      redirect: "manual",
    });

    const rawSetCookie =
      (cookieRes.headers as any).getSetCookie?.() ??
      cookieRes.headers.get("set-cookie");
    const cookieLines: string[] = Array.isArray(rawSetCookie)
      ? rawSetCookie
      : typeof rawSetCookie === "string"
        ? rawSetCookie.split(/,(?=[^;]+=)/)
        : [];

    const cookie = cookieLines
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");

    if (!cookie) return null;

    const crumbRes = await fetch(
      "https://query1.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: { ...baseHeaders(), Cookie: cookie },
      }
    );

    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 64) return null;

    cachedCreds = {
      crumb,
      cookie,
      expires: Date.now() + 30 * 60 * 1000,
    };
    return { crumb, cookie };
  } catch {
    return null;
  }
}

async function fetchQuoteSummary(
  ticker: string,
  creds: { crumb: string; cookie: string } | null
): Promise<any | null> {
  const proxyBase = process.env.YAHOO_PROXY_URL;
  const yahooHost = "query1.finance.yahoo.com";
  const modules = "calendarEvents,summaryDetail";
  const crumbParam = creds ? `&crumb=${encodeURIComponent(creds.crumb)}` : "";
  const yahooPath = `/v10/finance/quoteSummary/${encodeURIComponent(
    ticker
  )}?modules=${modules}${crumbParam}`;

  const yahooUrl = `https://${yahooHost}${yahooPath}`;
  const url = proxyBase
    ? `${proxyBase.replace(/\/$/, "")}/?url=${encodeURIComponent(yahooUrl)}`
    : yahooUrl;

  const headers = baseHeaders();
  if (creds) headers.Cookie = creds.cookie;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return { _status: res.status };
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCalendar(ticker: string): Promise<CalendarEvent[]> {
  let data = await fetchQuoteSummary(ticker, null);

  if (!data || data._status === 401 || data._status === 403 || data._status === 429) {
    const creds = await getCrumbAndCookie();
    if (creds) {
      data = await fetchQuoteSummary(ticker, creds);
    }
  }

  if (!data || data._status) return [];

  const result = data?.quoteSummary?.result?.[0];
  if (!result) return [];

  const events: CalendarEvent[] = [];
  const cal = result.calendarEvents;
  if (!cal) return [];

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

  return events;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const tickersParam = req.query.tickers;
    const tickersStr = Array.isArray(tickersParam) ? tickersParam[0] : tickersParam;

    if (!tickersStr) {
      res.status(400).json({ error: "Missing 'tickers' query parameter" });
      return;
    }

    const tickers = String(tickersStr)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const results = await Promise.all(tickers.map(fetchCalendar));
    const allEvents: CalendarEvent[] = results.flat();

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

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
    res.status(200).json({
      events,
      noData,
      proxied: !!process.env.YAHOO_PROXY_URL,
      updatedAt: new Date().toISOString(),
    });
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
