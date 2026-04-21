// api/hello.ts — diagnostic endpoint
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    runtime: "vercel-node",
    node: process.version,
    timestamp: new Date().toISOString(),
    fmpKeyConfigured: !!process.env.FMP_API_KEY,
    openaiKeyConfigured: !!process.env.OPENAI_API_KEY,
    message: "API is deployed correctly.",
  });
}
