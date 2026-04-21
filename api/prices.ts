// api/prices.ts — Vercel serverless function
// Fetches current prices from FMP's free-tier /stable/quote endpoint.
//
// Batch-quote is a paid endpoint, so we fire single-symbol quotes in parallel.
// 8 tickers = 8 API calls per refresh, well within the 250/day free budget.
import type { VercelRequest, VercelResponse } from "@vercel/node";

type FmpQuote = {
  symbol: string;
  price: number | null;
  name?: string;
};

type SingleResult = {
  ticker: string;
  price: number | null;
  error?: string;
};

async function fetchOnePrice(
  ticker: string,
  apiKey: string
): Promise<SingleResult> {
  const url = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(
    ticker
  )}&apikey=${encodeURIComponent(apiKey)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const snippet = bodyText.slice(0, 120).replace(/\s+/g, " ").trim();
      return {
        ticker,
        price: null,
        error: `FMP HTTP ${res.status}${snippet ? " — " + snippet : ""}`,
      };
    }

    const data = (await res.json()) as
      | FmpQuote[]
      | FmpQuote
      | { "Error Message"?: string };

    // FMP /stable/quote returns an array with one entry (or empty if unknown ticker)
    const quote: FmpQuote | undefined = Array.isArray(data)
      ? data[0]
      : (data as FmpQuote)?.symbol
      ? (data as FmpQuote)
      : undefined;

    if (!quote) {
      const errMsg =
        (data as any)?.["Error Message"] ||
        "Ticker not found or no data returned";
      return { ticker, price: null, error: errMsg };
    }

    if (typeof quote.price !== "number" || isNaN(quote.price)) {
      return { ticker, price: null, error: "Invalid price in response" };
    }

    return { ticker, price: Math.round(quote.price * 100) / 100 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return { ticker, price: null, error: `Fetch failed: ${msg}` };
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
      });
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

    // Parallel single-symbol fetches
    const results = await Promise.all(
      tickers.map((t) => fetchOnePrice(t, apiKey))
    );

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
      source: "fmp-stable-single",
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
