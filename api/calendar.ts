// api/calendar.ts — Vercel serverless function
// Earnings, ex-dividend, and dividend payment dates from FMP /stable/ endpoints.
//
// Uses per-symbol endpoints that work on the free tier:
//   /stable/dividends?symbol=X   — ex-dividend + payment dates
//   /stable/earnings?symbol=X    — past + upcoming earnings dates
//
// If a specific ticker isn't covered (common for TSXV small-caps), it's
// reported in `noData` and users can add manual events via CUSTOM_EVENTS.
import type { VercelRequest, VercelResponse } from "@vercel/node";

type CalendarEvent = {
  ticker: string;
  date: string; // yyyy-mm-dd
  type: "earnings" | "ex_dividend" | "dividend";
  label: string;
  estimate?: boolean;
};

const PAST_DAYS = 60;
const FUTURE_DAYS_DIV = 120;
const FUTURE_DAYS_EARN = 180;

function windowISO(pastDays: number, futureDays: number) {
  const now = new Date();
  const past = new Date(now);
  past.setDate(now.getDate() - pastDays);
  const future = new Date(now);
  future.setDate(now.getDate() + futureDays);
  return {
    pastISO: past.toISOString().split("T")[0],
    futureISO: future.toISOString().split("T")[0],
  };
}

async function fetchDividends(
  ticker: string,
  apiKey: string
): Promise<CalendarEvent[]> {
  const url = `https://financialmodelingprep.com/stable/dividends?symbol=${encodeURIComponent(
    ticker
  )}&apikey=${encodeURIComponent(apiKey)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];

    const data = (await res.json()) as Array<{
      symbol?: string;
      date?: string; // ex-dividend date in FMP
      paymentDate?: string;
      recordDate?: string;
      declarationDate?: string;
    }>;
    if (!Array.isArray(data)) return [];

    const { pastISO, futureISO } = windowISO(PAST_DAYS, FUTURE_DAYS_DIV);
    const events: CalendarEvent[] = [];

    for (const row of data) {
      if (row.date && row.date >= pastISO && row.date <= futureISO) {
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
        row.paymentDate <= futureISO
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

async function fetchEarnings(
  ticker: string,
  apiKey: string
): Promise<CalendarEvent[]> {
  const url = `https://financialmodelingprep.com/stable/earnings?symbol=${encodeURIComponent(
    ticker
  )}&apikey=${encodeURIComponent(apiKey)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];

    const data = (await res.json()) as Array<{
      symbol?: string;
      date?: string;
    }>;
    if (!Array.isArray(data)) return [];

    const { pastISO, futureISO } = windowISO(PAST_DAYS, FUTURE_DAYS_EARN);
    const events: CalendarEvent[] = [];

    for (const row of data) {
      if (row.date && row.date >= pastISO && row.date <= futureISO) {
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

    const results = await Promise.all(
      tickers.map(async (ticker) => {
        const [divs, earnings] = await Promise.all([
          fetchDividends(ticker, apiKey),
          fetchEarnings(ticker, apiKey),
        ]);
        return [...divs, ...earnings];
      })
    );

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
      source: "fmp-stable",
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
