// api/calendar.ts — Vercel serverless function
// Earnings, ex-dividend, and dividend payment dates.
//
// Strategy:
//  1. Dividend data from FMP (/api/v3/historical-price-full/stock_dividend/{symbol})
//     — reliable on free tier, includes past + projected ex/pay dates.
//  2. Earnings data from Yahoo quoteSummary — less rate-limited than chart
//     endpoint, with cookie+crumb auth fallback.
//  3. If any source fails for a ticker, we gracefully return empty events
//     for that ticker rather than erroring the whole response.
import type { VercelRequest, VercelResponse } from "@vercel/node";

type CalendarEvent = {
  ticker: string;
  date: string; // yyyy-mm-dd
  type: "earnings" | "ex_dividend" | "dividend";
  label: string;
  estimate?: boolean;
};

// ---------- FMP dividends ----------
async function fetchDividendsFromFMP(
  ticker: string,
  apiKey: string
): Promise<CalendarEvent[]> {
  const url = `https://financialmodelingprep.com/api/v3/historical-price-full/stock_dividend/${encodeURIComponent(
    ticker
  )}?apikey=${encodeURIComponent(apiKey)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      historical?: Array<{
        date?: string;
        paymentDate?: string;
        recordDate?: string;
        declarationDate?: string;
      }>;
    };

    const events: CalendarEvent[] = [];
    const today = new Date().toISOString().split("T")[0];
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 120);
    const horizonISO = horizon.toISOString().split("T")[0];
    // Also pull recent history (past 60 days) so user can see recent events
    const past = new Date();
    past.setDate(past.getDate() - 60);
    const pastISO = past.toISOString().split("T")[0];

    for (const row of data.historical ?? []) {
      // `date` in FMP's dividend response = ex-dividend date
      if (row.date && row.date >= pastISO && row.date <= horizonISO) {
        events.push({
          ticker,
          date: row.date,
          type: "ex_dividend",
          label: "Ex-Dividend",
        });
      }
      if (
        row.paymentDate &&
        row.paymentDate >= pastISO &&
        row.paymentDate <= horizonISO
      ) {
        events.push({
          ticker,
          date: row.paymentDate,
          type: "dividend",
          label: "Dividend Paid",
        });
      }
    }

    return events;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------- FMP earnings calendar ----------
async function fetchEarningsFromFMP(
  ticker: string,
  apiKey: string
): Promise<CalendarEvent[]> {
  const url = `https://financialmodelingprep.com/api/v3/historical/earning_calendar/${encodeURIComponent(
    ticker
  )}?apikey=${encodeURIComponent(apiKey)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];

    const data = (await res.json()) as Array<{ date?: string; symbol?: string }>;
    if (!Array.isArray(data)) return [];

    const past = new Date();
    past.setDate(past.getDate() - 60);
    const pastISO = past.toISOString().split("T")[0];
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 180);
    const horizonISO = horizon.toISOString().split("T")[0];

    const events: CalendarEvent[] = [];
    for (const row of data) {
      if (row.date && row.date >= pastISO && row.date <= horizonISO) {
        events.push({
          ticker,
          date: row.date,
          type: "earnings",
          label: "Earnings",
        });
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------- handler ----------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const tickersParam = req.query.tickers;
    const tickersStr = Array.isArray(tickersParam) ? tickersParam[0] : tickersParam;

    if (!tickersStr) {
      res.status(400).json({ error: "Missing 'tickers' query parameter" });
      return;
    }

    const apiKey = process.env.FMP_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: "FMP_API_KEY environment variable not configured on Vercel.",
        events: [],
        noData: [],
      });
      return;
    }

    const tickers = String(tickersStr)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Fetch dividends + earnings for all tickers in parallel
    const results = await Promise.all(
      tickers.map(async (ticker) => {
        const [divs, earnings] = await Promise.all([
          fetchDividendsFromFMP(ticker, apiKey),
          fetchEarningsFromFMP(ticker, apiKey),
        ]);
        return [...divs, ...earnings];
      })
    );

    const allEvents: CalendarEvent[] = results.flat();

    // De-duplicate
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
      source: "fmp",
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
