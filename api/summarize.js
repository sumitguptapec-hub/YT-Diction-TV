// Summarizes a video's captions in groups of ~5 lines using Claude, giving
// each pacing-sized chunk a short summary with a timestamp to jump to.
// YouTube's own AI-generated summaries have no public API and aren't built
// to accept a prompt from an outside site at all, so this calls a real LLM
// directly instead -- using the same caption text already fetched for
// subtitles, not YouTube's internal feature.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001"; // cheap/fast -- plenty for a one-sentence-per-group summary

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST required" });
    return;
  }
  if (!ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY isn't set on this deployment (see README)" });
    return;
  }
  const groups = req.body?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    res.status(400).json({ error: "groups is required" });
    return;
  }

  const transcript = groups.map((g) => `[Group ${g.index}] ${g.text}`).join("\n");
  const prompt =
    "Here is a video transcript split into numbered groups of consecutive caption lines. " +
    "For each group, write ONE short summary sentence (under 15 words) capturing what's said in it. " +
    'Reply with ONLY a JSON array like [{"index":0,"summary":"..."},...], one entry per group, in order, no other text.\n\n' +
    transcript;

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      res.status(502).json({ error: `Claude API failed: ${claudeRes.status} ${errText}` });
      return;
    }
    const data = await claudeRes.json();
    const text = data.content?.[0]?.text ?? "[]";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const summaries = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    res.status(200).json({ summaries });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
