// api/hello.ts — diagnostic endpoint
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    runtime: "vercel-node",
    timestamp: new Date().toISOString(),
    message: "If you can read this, your api/ folder is deployed correctly.",
  });
}
