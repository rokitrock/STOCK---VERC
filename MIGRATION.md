# Migrating from Netlify to Vercel + New Calendar Integration

## What changed

### File structure
```
BEFORE (Netlify)                 AFTER (Vercel)
──────────────────               ──────────────────
netlify.toml              →      vercel.json
netlify/functions/
  prices.mts              →      api/prices.ts
  reality-check.mts       →      api/reality-check.ts
                                 api/calendar.ts       ← NEW
index.html                →      index.html           ← UPDATED
package.json              →      package.json         ← UPDATED
                                 tsconfig.json        ← NEW
```

### Code changes
- **Function signature**: Netlify's `export default async (req: Request) =>` became Vercel's `export default async function handler(req: Request): Promise<Response>`. Both use the same Web standard `Request`/`Response` API — no logic changes needed.
- **Routing**: Netlify used `export const config: Config = { path: "/api/prices" }`. Vercel routes automatically based on file path (`api/prices.ts` → `/api/prices`), so no explicit config needed.
- **Cache headers**: Added `s-maxage` cache headers on both endpoints so the Vercel edge caches responses briefly, reducing latency + Yahoo load.

---

## Migration steps

### 1. Replace files
Drop all files from this bundle into your project root, overwriting existing files. Then **delete** the old Netlify artifacts:

```bash
rm netlify.toml
rm -rf netlify/
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set environment variable
Your `reality-check` endpoint needs `OPENAI_API_KEY`. In Vercel:

**Option A — via dashboard** (recommended for production):
1. Go to your project → Settings → Environment Variables
2. Add `OPENAI_API_KEY` with your key
3. Apply to: Production, Preview, Development

**Option B — via CLI** (for local dev):
```bash
vercel env add OPENAI_API_KEY
```
Or create a local `.env.local` file (gitignored):
```
OPENAI_API_KEY=sk-...
```

### 4. Test locally
```bash
npx vercel dev
```
Site runs at `http://localhost:3000`. Test:
- Homepage loads
- Click **Update Prices** → prices refresh
- Click **Research Calendar** → modal opens, events load
- Click a lagging card → open reality check → hit Refresh

### 5. Deploy
First time:
```bash
npx vercel
```
Follow the prompts (link to existing Vercel project or create new). Subsequent deploys:
```bash
npx vercel --prod
```

Or connect your GitHub repo in the Vercel dashboard — every push to `main` deploys automatically.

### 6. Update DNS (if using custom domain)
1. Vercel → Project → Settings → Domains → add your domain
2. Copy the CNAME/A records Vercel gives you
3. Update at your DNS provider (replacing the Netlify records)
4. Remove the domain from Netlify after DNS propagates

---

## The new calendar integration

### How it works
The **Research Calendar** button (next to Update Prices) opens a full-screen modal that:

1. Calls `/api/calendar?tickers=TNZ.TO,HUT,...` on first open
2. The endpoint hits Yahoo Finance's `quoteSummary` module for each ticker in parallel
3. Returns earnings dates, ex-dividend dates, and dividend payment dates
4. The UI renders a month grid with color-coded event pills + a "Next 90 Days" list below
5. Clicking any event jumps to that ticker's card and highlights it

### Event types
| Mark | Type | Source |
|------|------|--------|
| **E** | Earnings | Yahoo (live) |
| **X** | Ex-Dividend | Yahoo (live) |
| **D** | Dividend Paid | Yahoo (live) |
| **C** | Custom / Catalyst | Your `CUSTOM_EVENTS` in `index.html` |

### Yahoo's coverage gaps
Yahoo's `quoteSummary` endpoint has decent coverage for US large/mid caps but is **patchy for TSXV and small-cap Canadian names** (NILI.V, DEFN.V, AFM.V may return no data). The UI handles this gracefully — tickers with no live data appear in a "No live calendar data" note at the bottom of the modal.

To fill these gaps, add entries to `CUSTOM_EVENTS` in `index.html` (around line 300):

```js
const CUSTOM_EVENTS = [
  { ticker: "DEFN.V", date: "2026-06-30", label: "DFS expected (H1 2026)" },
  { ticker: "FTG.TO", date: "2026-06-30", label: "Hyderabad facility online" },
  { ticker: "NILI.V", date: "2026-12-15", label: "PFS target completion" },
  { ticker: "TNZ.TO", date: "2026-05-31", label: "NOBV acquisition close (est.)" },
];
```

Custom events appear on the calendar in purple with a **C** mark, alongside the live data.

### If Yahoo's calendar endpoint gets blocked
Yahoo occasionally requires a cookie + crumb handshake for `quoteSummary`. The endpoint in `api/calendar.ts` handles this automatically — it first tries a plain request, then falls back to obtaining a crumb if that fails. The crumb is cached for 30 minutes server-side.

If you need more reliability, swap in a paid provider (Finnhub has a free tier with 60 req/min covering earnings calendars) by replacing the `fetchCalendar` function in `api/calendar.ts` — the UI contract stays the same.

---

## Adding more coverage
When you add a new ticker to `REPORTS` in `index.html`, calendar events for that ticker will automatically appear on the next calendar open — no extra configuration needed.

---

## Environment variables summary

| Variable | Required for | Where to set |
|----------|--------------|--------------|
| `OPENAI_API_KEY` | `/api/reality-check` | Vercel dashboard |

No API key needed for `/api/prices` or `/api/calendar` — both use Yahoo Finance's public endpoints.
