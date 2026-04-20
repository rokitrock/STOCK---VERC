// api/calendar.ts — Vercel Function
// Fetches earnings dates, ex-dividend dates, and dividend payment dates
// from Yahoo Finance's quoteSummary endpoint for a list of tickers.
//
// No API key required. Yahoo may occasionally throttle; failures return
// empty arrays for affected tickers rather than erroring the whole response.

type CalendarEvent = {
  ticker: string;
  date: string; // ISO yyyy-mm-dd
  type: "earnings" | "ex_dividend" | "dividend";
  label: string;
  estimate?: boolean;
};

// Yahoo often requires a crumb/cookie for quoteSummary. We try without first
// (works in many cases server-side) and fall back to obtaining one if needed.
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
      {
        headers: { "User-Agent": "Mozilla/5.0", Cookie: setCookie },
      }
    );
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 50 || crumb.includes("<")) return null;

    cachedAuth = {
      cookie: setCookie,
      crumb,
      expiresAt: Date.now() + 30 * 60 * 1000, // cache 30 min
    };
    return { cookie: setCookie, crumb };
  } catch {
    return null;
  }
}

async function fetchCalendar(ticker: string): Promise<CalendarEvent[]> {
  const tryRequest = async (withAuth: boolean) => {
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

    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return res.json();
  };

  try {
    let data = await tryRequest(false);
    // If the plain request fails or returns an auth error, try with crumb
    if (!data || data?.quoteSummary?.error) {
      data = await tryRequest(true);
    }

    const result = data?.quoteSummary?.result?.[0];
    if (!result) return [];

    const events: CalendarEvent[] = [];
    const cal = result.calendarEvents;
    if (!cal) return [];

    // --- Earnings ---
    const earningsDates = cal.earnings?.earningsDate;
    const isEstimate = cal.earnings?.isEarningsDateEstimate ?? false;
    if (Array.isArray(earningsDates) && earningsDates.length > 0) {
      // Yahoo returns either a single confirmed date or a [start, end] range estimate
      for (const d of earningsDates) {
        const raw = typeof d === "object" ? d.raw : d;
        if (!raw) continue;
        events.push({
          ticker,
          date: new Date(raw * 1000).toISOString().split("T")[0],
          type: "earnings",
          label: earningsDates.length > 1 ? "Earnings (est. window)" : "Earnings",
          estimate: isEstimate || earningsDates.length > 1,
        });
      }
    }

    // --- Ex-Dividend ---
    const exDiv = cal.exDividendDate?.raw ?? cal.exDividendDate;
    if (typeof exDiv === "number" && exDiv > 0) {
      events.push({
        ticker,
        date: new Date(exDiv * 1000).toISOString().split("T")[0],
        type: "ex_dividend",
        label: "Ex-Dividend",
      });
    }

    // --- Dividend Payment ---
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

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tickersParam = url.searchParams.get("tickers");

  if (!tickersParam) {
    return Response.json(
      { error: "Missing 'tickers' query parameter" },
      { status: 400 }
    );
  }

  const tickers = tickersParam.split(",").map((t) => t.trim()).filter(Boolean);

  // Fetch calendars for all tickers in parallel
  const results = await Promise.all(tickers.map(fetchCalendar));
  const allEvents: CalendarEvent[] = results.flat();

  // De-duplicate (some endpoints return the same date in multiple modules)
  const seen = new Set<string>();
  const events = allEvents.filter((e) => {
    const key = `${e.ticker}|${e.date}|${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date ascending
  events.sort((a, b) => a.date.localeCompare(b.date));

  // Report which tickers had no data so the UI can note them
  const withData = new Set(events.map((e) => e.ticker));
  const noData = tickers.filter((t) => !withData.has(t));

  return Response.json(
    {
      events,
      noData,
      updatedAt: new Date().toISOString(),
    },
    {
      headers: {
        // Cache for 1 hour at edge — calendar data doesn't change minute-to-minute
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=7200",
      },
    }
  );
}
