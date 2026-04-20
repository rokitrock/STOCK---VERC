// api/prices.ts — Vercel Function
// Fetches current prices from Yahoo Finance for a comma-separated list of tickers.

async function fetchPrice(
  ticker: string
): Promise<{ ticker: string; price: number | null; error?: string }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) {
      return { ticker, price: null, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return { ticker, price: null, error: "No data returned" };

    const price =
      result.meta?.regularMarketPrice ??
      result.indicators?.quote?.[0]?.close
        ?.filter((v: number | null) => v !== null)
        .pop();

    if (price === null || price === undefined || isNaN(price)) {
      return { ticker, price: null, error: "Invalid price data" };
    }

    return { ticker, price: Math.round(price * 100) / 100 };
  } catch (err) {
    return {
      ticker,
      price: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
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
