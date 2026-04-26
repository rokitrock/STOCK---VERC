// api/calendar.ts — read endpoint for the catalyst calendar.
//
// Returns the calendar produced by /api/calendar-refresh from Vercel Blob
// storage. The refresh job runs weekly via Vercel Cron and is the only
// writer; this endpoint is read-only and tolerates the blob being missing
// (returns an empty calendar with a message).
//
// The `tickers` query parameter is accepted for backwards compatibility but
// is now used only to filter the stored calendar — the canonical coverage
// list lives in api/_coverage.ts and is set by the refresh job.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list } from "@vercel/blob";
import { COVERAGE } from "./_coverage.js";

type CalendarEvent = {
  ticker: string;
  date: string;
  type: "earnings" | "ex_dividend" | "dividend" | "custom";
  label: string;
  estimate: boolean;
  confidence?: "high" | "medium" | "low";
  source?: string;
};

type CalendarFile = {
  events: CalendarEvent[];
  updatedAt: string;
  perTicker?: Record<string, { ok: boolean; eventCount: number; error?: string }>;
};

const BLOB_KEY = "calendar.json";

async function loadCalendar(): Promise<CalendarFile | null> {
  try {
    const { blobs } = await list({ prefix: BLOB_KEY, limit: 1 });
    if (blobs.length === 0) return null;
    const res = await fetch(blobs[0].url);
    if (!res.ok) return null;
    return (await res.json()) as CalendarFile;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const tickersParam = req.query.tickers;
    const tickersStr = Array.isArray(tickersParam) ? tickersParam[0] : tickersParam;

    const requested = tickersStr
      ? String(tickersStr)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : COVERAGE.map((c) => c.ticker);

    const file = await loadCalendar();

    if (!file) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        events: [],
        noData: requested,
        updatedAt: null,
        message:
          "Calendar has not been populated yet. Hit /api/calendar-refresh?token=<CRON_SECRET> to bootstrap.",
      });
      return;
    }

    const wanted = new Set(requested);
    const events = file.events.filter((e) => wanted.has(e.ticker));

    const withData = new Set(events.map((e) => e.ticker));
    const noData = requested.filter((t) => !withData.has(t));

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      events,
      noData,
      updatedAt: file.updatedAt,
      perTicker: file.perTicker,
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
