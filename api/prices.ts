// api/prices.ts — Vercel serverless function
// Mirrors the Netlify implementation that works reliably, plus:
//   - More realistic browser headers (matches what a browser actually sends)
//   - Host rotation (query1 → query2 on failure)
//   - Optional proxy support: if YAHOO_PROXY_URL is set, all Yahoo requests
//     route through it (use a Cloudflare Worker — see worker.js in repo root).
//
// If Yahoo blocks Vercel's IPs with 429, set YAHOO_PROXY_URL in Vercel env vars
// to a Cloudflare Worker URL that forwards requests.
import type { VercelRequest, VercelResponse } from "@vercel/node";

type FetchResult = { price: number | null; status: number; error?: string };

async function fetchPriceFromYahoo(
  ticker: string,
  host: string
): Promise<FetchResult> {
  const proxyBase = process.env.YAHOO_PROXY_URL;
  const yahooPath = `/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=1d&range=1d`;

  // If a proxy is configured, route through it. The Worker expects the Yahoo
  // host+path appended after its base URL.
  const url = proxyBase
    ? `${proxyBase.replace(/\/$/, "")}/${host.replace(/^https?:\/\//, "")}${yahooPath}`
    : `${host}${yahooPath}`;

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept:
      "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://finance.yahoo.com/",
    Origin: "https://finance.yahoo.com",
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });

    if (!res.ok) {
      return {
        price: null,
        status: res.status,
        error: `HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as any;

    if (data?.chart?.error || !data?.chart?.result?.length) {
      return {
        price: null,
        status: 200,
        error: "No data returned",
      };
    }

    const result = data.chart.result[0];
    const closeArr = result.indicators?.quote?.[0]?.close;
    const fallback = Array.isArray(closeArr)
      ? closeArr.filter((v: number | null) => v !== null).pop()
      : undefined;
    const price = result.meta?.regularMarketPrice ?? fallback;

    if (price === null || price === undefined || isNaN(price)) {
      return { price: null, status: 200, error: "Invalid price" };
    }

    return { price: Math.round(price * 100) / 100, status: 200 };
  } catch (err) {
    return {
      price: null,
      status: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrice(
  ticker: string
): Promise<{ ticker: string; price: number | null; error?: string }> {
  const hosts = [
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com",
  ];

  let lastError = "";
  for (const host of hosts) {
    const r = await fetchPriceFromYahoo(ticker, host);
    if (r.price !== null) return { ticker, price: r.price };
    lastError = r.error || `HTTP ${r.status}`;
    // If we got a 429 on query1, still try query2 (different edge)
  }

  return { ticker, price: null, error: lastError };
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
      proxied: !!process.env.YAHOO_PROXY_URL,
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
