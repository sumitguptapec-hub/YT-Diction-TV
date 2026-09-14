// Summarizes a video's captions in groups of ~5 lines using an LLM, giving
// each pacing-sized chunk a short summary with a timestamp to jump to.
// YouTube's own AI-generated summaries have no public API and aren't built
// to accept a prompt from an outside site at all, so this calls a real LLM
// directly instead -- using the same caption text already fetched for
// subtitles, not YouTube's internal feature.
//
// Gemini (Google AI Studio's free-tier API, not full enterprise Vertex AI --
// that needs a GCP billing account + service-account auth, the same
// friction this is meant to avoid) is tried first since it costs nothing.
// Falls back to Claude if a GEMINI_API_KEY isn't configured but an
// ANTHROPIC_API_KEY is, so either setup works without code changes.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash"; // free-tier eligible; bump this if Google retires it later
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST required" });
    return;
  }
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set on this deployment (see README)" });
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
    const text = GEMINI_API_KEY ? await callGemini(prompt) : await callClaude(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const summaries = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    res.status(200).json({ summaries });
  } catch (err) {
    res.status(502).json({ error: String(err?.message ?? err) });
  }
}

async function callGemini(prompt) {
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude API failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? "[]";
}
