// api/prices.ts — Vercel serverless function
// Fetches prices from Yahoo Finance with cookie+crumb auth fallback.
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Module-level cache for Yahoo auth (warm invocations reuse)
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      return { price: null, status: res.status, reason: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as any;
    const result = data?.chart?.result?.[0];
    if (!result) return { price: null, status: 200, reason: "no chart result" };

    const closeArr = result.indicators?.quote?.[0]?.close;
    const fallback =
      Array.isArray(closeArr)
        ? closeArr.filter((v: number | null) => v !== null).pop()
        : undefined;
    const price = result.meta?.regularMarketPrice ?? fallback;

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
    let r = await tryFetch(ticker, host, false);
    if (r.price !== null) return { ticker, price: r.price };
    attempts.push(`${host.replace("https://","")} no-auth: ${r.reason}`);

    if (r.status === 401 || r.status === 403) {
      r = await tryFetch(ticker, host, true);
      if (r.price !== null) return { ticker, price: r.price };
      attempts.push(`${host.replace("https://","")} auth: ${r.reason}`);
    }
  }
  return { ticker, price: null, error: attempts.join(" | ") };
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

    if (tickers.length === 0) {
      res.status(400).json({ error: "No valid tickers" });
      return;
    }

    const results = await Promise.all(tickers.map(fetchPrice));

    const prices: Record<string, number | null> = {};
    const errors: Record<string, string> = {};
    for (const r of results) {
      prices[r.ticker] = r.price;
      if (r.error) errors[r.ticker] = r.error;
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      prices,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("prices handler crashed:", err);
    res.status(500).json({
      error: "Handler crashed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
