// api/reality-check.ts — Vercel Function
// Uses OpenAI to surface current risks/concerns for a given ticker.
// Requires OPENAI_API_KEY environment variable set in Vercel dashboard.

import OpenAI from "openai";

const openai = new OpenAI();

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ticker = url.searchParams.get("ticker");

  if (!ticker) {
    return Response.json(
      { error: "Missing 'ticker' query parameter" },
      { status: 400 }
    );
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You are a concise equity research analyst. Given a stock ticker, provide 3-4 brief bullet points about current risks, concerns, or reasons the stock may be underperforming. Focus on recent market conditions, sector headwinds, or company-specific issues. Each bullet should be one sentence. Return ONLY a JSON object with a 'bullets' array of strings.",
        },
        {
          role: "user",
          content: `What are the current risks and concerns for ${ticker}? Provide 3-4 brief bullet points as a JSON object like {"bullets": ["point 1", "point 2", "point 3"]}.`,
        },
      ],
    });

    const text = completion.choices[0]?.message?.content || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return Response.json({ bullets: parsed.bullets || [] });
    }

    return Response.json({ bullets: [] });
  } catch (err) {
    console.error("Reality check error:", err);
    return Response.json({
      bullets: ["Unable to fetch latest market insights. Please try again later."],
    });
  }
}
