// api/prices.ts — Vercel Function
// Fetches current prices from Yahoo Finance with cookie+crumb auth fallback.
//
// Yahoo blocks plain requests from many datacenter IPs (Vercel included)
// with 401 Unauthorized. We try unauthenticated first (often works for chart
// endpoint), then fall back to cookie+crumb auth, then fall back to the
// query2.finance.yahoo.com host (different IP routing).

// ----- shared Yahoo auth (crumb cached 30 min in module memory) -----
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

// ----- price fetch with multi-strategy fallback -----
type PriceResult = { ticker: string; price: number | null; error?: string };

const HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

async function tryFetch(
  ticker: string,
  host: string,
  withAuth: boolean
): Promise<{ price: number | null; status: number; reason?: string }> {
  let url = `${host}/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=1d&range=1d`;
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json",
  };

  if (withAuth) {
    const auth = await getYahooAuth();
    if (auth) {
      url += `&crumb=${encodeURIComponent(auth.crumb)}`;
      headers.Cookie = auth.cookie;
    }
  }

  // 8 sec per-attempt cap so we never hit the 10s function timeout
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      return { price: null, status: res.status, reason: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      return { price: null, status: 200, reason: "no chart result" };
    }
    const price =
      result.meta?.regularMarketPrice ??
      result.indicators?.quote?.[0]?.close
        ?.filter((v: number | null) => v !== null)
        .pop();
    if (price === null || price === undefined || isNaN(price)) {
      return { price: null, status: 200, reason: "invalid price data" };
    }
    return { price: Math.round(price * 100) / 100, status: 200 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return { price: null, status: 0, reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrice(ticker: string): Promise<PriceResult> {
  const attempts: string[] = [];
  for (const host of HOSTS) {
    // 1) try without auth
    let r = await tryFetch(ticker, host, false);
    if (r.price !== null) return { ticker, price: r.price };
    attempts.push(`${host} no-auth: ${r.reason}`);

    // 2) if 401/403, try with cookie+crumb
    if (r.status === 401 || r.status === 403) {
      r = await tryFetch(ticker, host, true);
      if (r.price !== null) return { ticker, price: r.price };
      attempts.push(`${host} auth: ${r.reason}`);
    }
  }
  return { ticker, price: null, error: attempts.join(" | ") };
}

// ----- handler -----
export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tickersParam = url.searchParams.get("tickers");

  if (!tickersParam) {
    return Response.json(
      { error: "Missing 'tickers' query parameter" },
      { status: 400 }
    );
  }

  const tickers = tickersParam
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tickers.length === 0) {
    return Response.json({ error: "No valid tickers" }, { status: 400 });
  }

  const results = await Promise.all(tickers.map(fetchPrice));

  const prices: Record<string, number | null> = {};
  const errors: Record<string, string> = {};
  for (const r of results) {
    prices[r.ticker] = r.price;
    if (r.error) errors[r.ticker] = r.error;
  }

  return Response.json(
    {
      prices,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      updatedAt: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
      },
    }
  );
}
