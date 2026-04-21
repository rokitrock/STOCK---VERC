// api/prices.ts — Vercel serverless function
// Fetches current prices from Financial Modeling Prep using the modern
// /stable/batch-quote endpoint (legacy /api/v3/ endpoints return 403 for
// accounts created after Aug 31, 2025).
import type { VercelRequest, VercelResponse } from "@vercel/node";

type FmpQuote = {
  symbol: string;
  price: number | null;
  name?: string;
};

async function fetchPricesFromFMP(
  tickers: string[],
  apiKey: string
): Promise<{
  prices: Record<string, number | null>;
  errors: Record<string, string>;
}> {
  const prices: Record<string, number | null> = Object.fromEntries(
    tickers.map((t) => [t, null as number | null])
  );
  const errors: Record<string, string> = {};

  // FMP stable batch endpoint: symbols as comma-separated query param
  const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${encodeURIComponent(
    tickers.join(",")
  )}&apikey=${encodeURIComponent(apiKey)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      // Read body to expose actual FMP error message (e.g. "Legacy Endpoint", "Limit Reach")
      const bodyText = await res.text().catch(() => "");
      const snippet = bodyText.slice(0, 150).replace(/\s+/g, " ").trim();
      const errMsg = `FMP HTTP ${res.status}${snippet ? " — " + snippet : ""}`;
      for (const t of tickers) errors[t] = errMsg;
      return { prices, errors };
    }

    const data = (await res.json()) as FmpQuote[] | { "Error Message"?: string };

    if (!Array.isArray(data)) {
      const errMsg =
        (data as any)?.["Error Message"] || "FMP returned non-array response";
      for (const t of tickers) errors[t] = errMsg;
      return { prices, errors };
    }

    const bySymbol = new Map<string, FmpQuote>();
    for (const q of data) {
      if (q?.symbol) bySymbol.set(q.symbol.toUpperCase(), q);
    }

    for (const t of tickers) {
      const q = bySymbol.get(t.toUpperCase());
      if (q && typeof q.price === "number" && !isNaN(q.price)) {
        prices[t] = Math.round(q.price * 100) / 100;
      } else {
        errors[t] = "Not found in FMP response";
      }
    }

    return { prices, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    for (const t of tickers) errors[t] = `FMP fetch failed: ${msg}`;
    return { prices, errors };
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

    const { prices, errors } = await fetchPricesFromFMP(tickers, apiKey);

    const cleanErrors: Record<string, string> = {};
    for (const [k, v] of Object.entries(errors)) {
      if (prices[k] === null && v) cleanErrors[k] = v;
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      prices,
      errors: Object.keys(cleanErrors).length > 0 ? cleanErrors : undefined,
      source: "fmp-stable",
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
