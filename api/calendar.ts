// api/calendar.ts — Vercel serverless function
// Yahoo Finance quoteSummary for earnings/dividend dates.
// Supports same YAHOO_PROXY_URL fallback as prices.ts.
import type { VercelRequest, VercelResponse } from "@vercel/node";

type CalendarEvent = {
  ticker: string;
  date: string;
  type: "earnings" | "ex_dividend" | "dividend";
  label: string;
  estimate?: boolean;
};

async function fetchCalendar(ticker: string): Promise<CalendarEvent[]> {
  const proxyBase = process.env.YAHOO_PROXY_URL;
  const yahooHost = "query1.finance.yahoo.com";
  const yahooPath = `/v10/finance/quoteSummary/${encodeURIComponent(
    ticker
  )}?modules=calendarEvents,summaryDetail`;

  const url = proxyBase
    ? `${proxyBase.replace(/\/$/, "")}/${yahooHost}${yahooPath}`
    : `https://${yahooHost}${yahooPath}`;

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://finance.yahoo.com/",
    Origin: "https://finance.yahoo.com",
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return [];

    const data = (await res.json()) as any;
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
  } catch (err) {
    console.error(`Calendar fetch failed for ${ticker}:`, err);
    return [];
  } finally {
    clearTimeout(timer);
  }
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
