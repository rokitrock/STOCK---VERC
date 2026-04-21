// api/calendar.ts — Vercel serverless function
// Earnings, ex-dividend, and dividend payment dates from Yahoo Finance.
import type { VercelRequest, VercelResponse } from "@vercel/node";

type CalendarEvent = {
  ticker: string;
  date: string;
  type: "earnings" | "ex_dividend" | "dividend";
  label: string;
  estimate?: boolean;
};

let cachedAuth: { cookie: string; crumb: string; expiresAt: number } | null = null;

async function getYahooAuth(): Promise<{ cookie: string; crumb: string } | null> {
  if (cachedAuth && cachedAuth.expiresAt > Date.now()) {
    return { cookie: cachedAuth.cookie, crumb: cachedAuth.crumb };
  }
  try {
    const cookieRes = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
    });
    const setCookie = cookieRes.headers.get("set-cookie") || "";
    if (!setCookie) return null;

    const crumbRes = await fetch(
      "https://query1.finance.yahoo.com/v1/test/getcrumb",
      { headers: { "User-Agent": "Mozilla/5.0", Cookie: setCookie } }
    );
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 50 || crumb.includes("<")) return null;

    cachedAuth = {
      cookie: setCookie,
      crumb,
      expiresAt: Date.now() + 30 * 60 * 1000,
    };
    return { cookie: setCookie, crumb };
  } catch {
    return null;
  }
}

async function fetchCalendar(ticker: string): Promise<CalendarEvent[]> {
  const tryRequest = async (withAuth: boolean): Promise<any> => {
    let url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=calendarEvents,summaryDetail`;
    const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0" };

    if (withAuth) {
      const auth = await getYahooAuth();
      if (auth) {
        url += `&crumb=${encodeURIComponent(auth.crumb)}`;
        headers.Cookie = auth.cookie;
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let data = await tryRequest(false);
    if (!data || data?.quoteSummary?.error) {
      data = await tryRequest(true);
    }

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

    const tickers = tickersStr
      .split(",")
      .map((t: string) => t.trim())
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
    const noData = tickers.filter((t: string) => !withData.has(t));

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
    res.status(200).json({
      events,
      noData,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("calendar handler crashed:", err);
    res.status(500).json({
      error: "Handler crashed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
