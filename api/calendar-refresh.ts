// api/calendar-refresh.ts — weekly cron + manual bootstrap endpoint.
//
// Researches upcoming catalysts for each ticker via Claude + web search,
// verifies last week's events against current information, and writes the
// consolidated calendar to Vercel Blob storage at calendar.json.
//
// Triggers:
//   - Vercel Cron: /api/calendar-refresh every Friday at 13:00 UTC.
//     Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically
//     if CRON_SECRET is set in env vars.
//   - Manual: GET /api/calendar-refresh?token=${CRON_SECRET}
//     Use this once after deploy to bootstrap calendar.json.
//
// Required env vars:
//   ANTHROPIC_API_KEY      — Claude API key
//   BLOB_READ_WRITE_TOKEN  — auto-set when Vercel Blob integration is added
//   CRON_SECRET            — shared secret for cron + manual auth
import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { put, list } from "@vercel/blob";
import { COVERAGE, type Coverage } from "./_coverage.js";

type CalendarEvent = {
  ticker: string;
  date: string;
  type: "earnings" | "ex_dividend" | "dividend" | "custom";
  label: string;
  estimate: boolean;
  confidence: "high" | "medium" | "low";
  source: string;
};

type CalendarFile = {
  events: CalendarEvent[];
  updatedAt: string;
  perTicker: Record<
    string,
    { ok: boolean; eventCount: number; error?: string }
  >;
};

const BLOB_KEY = "calendar.json";

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const auth = req.headers.authorization;
  if (auth === `Bearer ${secret}`) return true;

  const token = req.query.token;
  if (typeof token === "string" && token === secret) return true;

  return false;
}

async function loadPrevious(): Promise<CalendarEvent[]> {
  try {
    const { blobs } = await list({ prefix: BLOB_KEY, limit: 1 });
    if (blobs.length === 0) return [];
    const res = await fetch(blobs[0].url);
    if (!res.ok) return [];
    const data = (await res.json()) as CalendarFile;
    return Array.isArray(data?.events) ? data.events : [];
  } catch {
    return [];
  }
}

const SYSTEM_PROMPT = `You are a financial research assistant maintaining a forward-looking catalyst calendar for an equity research coverage list.

For each ticker, your job is to identify upcoming events with specific dates that an investor would want on their calendar:

1. Confirmed earnings release dates (next 1-2 quarters).
2. Ex-dividend dates and dividend payment dates.
3. Major company-specific catalysts: project milestones, regulatory decisions (PFS/DFS/PEA results, permit approvals), financing closings, M&A close dates, key conferences, AGMs, drilling result announcements, production start dates, etc.

Rules:
- Only report events with a specific date or a tight date window (≤ 7 days). Skip vague timing like "Q3 2026" or "second half of 2026".
- Skip events that have already passed (more than 5 days before today's date).
- Use web search to verify dates from primary sources: company press releases, investor relations pages, SEDAR/EDGAR filings, official earnings calendars (Yahoo Finance, Nasdaq, TMX). Avoid speculation from forums or unofficial blogs.
- Set "estimate": true if the date comes from analyst expectations or company guidance rather than a confirmed announcement.
- Set "confidence" to "high" only when you found the exact date in an official primary source within the last 90 days.
- The "source" field should be a short note (≤ 80 chars) like "Company Q3 release Apr 14" or "TMX dividend declaration Mar 22".

Verification of previous events:
If a list of previously-identified events is provided, treat them as hypotheses to verify. For each one:
- If a current source still confirms the date, re-include it (possibly with confidence revised).
- If you find the event has been postponed/canceled, omit it.
- If the event has already happened, omit it.
- If you can't find any current source confirming it, drop it (don't pad the calendar with stale assumptions).

After your research, call the submit_calendar_events tool exactly once with the final list. If you found nothing reliable, submit an empty array — that's an acceptable answer.`;

const submitTool = {
  name: "submit_calendar_events",
  description:
    "Submit the final verified list of upcoming catalyst events for this ticker. Call this exactly once after completing your research.",
  input_schema: {
    type: "object" as const,
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Event date in YYYY-MM-DD format.",
            },
            type: {
              type: "string",
              enum: ["earnings", "ex_dividend", "dividend", "custom"],
            },
            label: {
              type: "string",
              description:
                "Short human-readable label, e.g. 'Q3 Earnings', 'Ex-Dividend', 'NOBV acquisition close', 'PFS results expected'.",
            },
            estimate: {
              type: "boolean",
              description:
                "True if the date comes from analyst estimates or company guidance, false if from a confirmed announcement.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
            source: {
              type: "string",
              description:
                "Brief note on the primary source (≤ 80 chars). Example: 'Company Q3 release Apr 14'.",
            },
          },
          required: ["date", "type", "label", "estimate", "confidence", "source"],
        },
      },
    },
    required: ["events"],
  },
};

async function researchTicker(
  client: Anthropic,
  c: Coverage,
  previous: CalendarEvent[],
  todayISO: string
): Promise<{ events: CalendarEvent[]; error?: string }> {
  const prevForTicker = previous.filter((e) => e.ticker === c.ticker);

  const userPrompt = `Today's date: ${todayISO}

Ticker: ${c.ticker}
Exchange: ${c.exchange}
Company: ${c.company}
Sector: ${c.sector}

${
  prevForTicker.length > 0
    ? `Previously identified events for this ticker (verify each against current sources):
${prevForTicker
  .map(
    (e) =>
      `- ${e.date}: ${e.label} (${e.type}, est=${e.estimate}, prev. confidence=${e.confidence}, prev. source="${e.source}")`
  )
  .join("\n")}`
    : "No previous events on file for this ticker."
}

Research upcoming catalysts in the next 6 months. Verify any previous events. Then call submit_calendar_events with the consolidated list.`;

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20260209", name: "web_search" } as any,
        submitTool,
      ],
      messages: [{ role: "user", content: userPrompt }],
    });

    if (response.stop_reason === "pause_turn") {
      return {
        events: [],
        error: "research paused (server tool iteration limit)",
      };
    }
    if (response.stop_reason === "refusal") {
      return { events: [], error: "model refused" };
    }

    const submission = response.content.find(
      (b) => b.type === "tool_use" && b.name === "submit_calendar_events"
    );
    if (!submission || submission.type !== "tool_use") {
      return { events: [], error: "no submit_calendar_events tool call" };
    }

    const raw = submission.input as { events?: unknown };
    if (!Array.isArray(raw.events)) {
      return { events: [], error: "submission missing events array" };
    }

    const events: CalendarEvent[] = [];
    for (const ev of raw.events) {
      if (!ev || typeof ev !== "object") continue;
      const e = ev as Record<string, unknown>;
      if (
        typeof e.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(e.date) ||
        typeof e.label !== "string" ||
        typeof e.type !== "string" ||
        !["earnings", "ex_dividend", "dividend", "custom"].includes(e.type)
      ) {
        continue;
      }
      if (e.date < todayISO) continue;
      events.push({
        ticker: c.ticker,
        date: e.date,
        type: e.type as CalendarEvent["type"],
        label: e.label,
        estimate: e.estimate === true,
        confidence:
          e.confidence === "high" || e.confidence === "low" ? e.confidence : "medium",
        source: typeof e.source === "string" ? e.source : "",
      });
    }

    return { events };
  } catch (err) {
    return {
      events: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(500).json({ error: "Missing BLOB_READ_WRITE_TOKEN" });
    return;
  }

  const client = new Anthropic();
  const todayISO = new Date().toISOString().split("T")[0];
  const previous = await loadPrevious();

  const results = await Promise.all(
    COVERAGE.map((c) => researchTicker(client, c, previous, todayISO))
  );

  const allEvents: CalendarEvent[] = results.flatMap((r) => r.events);
  const seen = new Set<string>();
  const events = allEvents.filter((e) => {
    const key = `${e.ticker}|${e.date}|${e.type}|${e.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  events.sort((a, b) => a.date.localeCompare(b.date));

  const perTicker: CalendarFile["perTicker"] = {};
  COVERAGE.forEach((c, i) => {
    perTicker[c.ticker] = {
      ok: !results[i].error,
      eventCount: results[i].events.length,
      ...(results[i].error ? { error: results[i].error } : {}),
    };
  });

  const file: CalendarFile = {
    events,
    updatedAt: new Date().toISOString(),
    perTicker,
  };

  const blob = await put(BLOB_KEY, JSON.stringify(file, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });

  res.status(200).json({
    ok: true,
    eventCount: events.length,
    perTicker,
    blobUrl: blob.url,
    updatedAt: file.updatedAt,
  });
}
