// api/reality-check.ts — Vercel serverless function
// Uses OpenAI to surface current risks/concerns for a given ticker.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const tickerParam = req.query.ticker;
    const ticker = Array.isArray(tickerParam) ? tickerParam[0] : tickerParam;

    if (!ticker) {
      res.status(400).json({ error: "Missing 'ticker' query parameter" });
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({
        error: "OPENAI_API_KEY not configured",
        bullets: ["Server configuration issue — missing API key."],
      });
      return;
    }

    const openai = new OpenAI();

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
      res.status(200).json({ bullets: parsed.bullets || [] });
      return;
    }

    res.status(200).json({ bullets: [] });
  } catch (err) {
    console.error("Reality check error:", err);
    res.status(200).json({
      bullets: [
        `Unable to fetch insights: ${err instanceof Error ? err.message : "unknown error"}`,
      ],
    });
  }
}
