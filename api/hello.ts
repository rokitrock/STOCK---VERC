// api/hello.ts — diagnostic endpoint
// If GET /api/hello returns JSON → Vercel IS deploying functions. The issue is in another file.
// If it returns 404 → Vercel is NOT deploying functions. See MIGRATION.md "Diagnostic" section.

export default function handler(): Response {
  return Response.json({
    ok: true,
    runtime: "vercel-node",
    timestamp: new Date().toISOString(),
    message: "If you can read this, your api/ folder is deployed correctly.",
  });
}
