import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@deepgram/sdk";
import { trackVerify } from "../lib/usage";

// Raw audio body — no JSON body parsing.
export const config = { api: { bodyParser: false } };

const MAX_BYTES = 1 * 1024 * 1024;   // "Say it" recordings are ~4s — 1MB is plenty
// Isolated words (no sentence context) get low ASR confidence even when said correctly,
// so this bar is deliberately lenient — the real protection is the transcription itself
// (saying "walkt" wrong still transcribes as a different word).
const PASS_CONFIDENCE = 0.45;

const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string, max = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > windowMs) { hits.set(ip, { n: 1, t: now }); return false; }
  h.n++;
  return h.n > max;
}

async function readBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const clean = (s: string) => s.toLowerCase().replace(/[^a-z']/g, "");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "server-error" });

  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate-limited" });

  // Two modes: ?word= verifies a single word; ?sentence= verifies a whole sentence.
  const target = clean(String(req.query.word ?? ""));
  const sentenceTarget = String(req.query.sentence ?? "")
    .split(/\s+/).map(clean).filter(Boolean);
  if (!target && !sentenceTarget.length) return res.status(400).json({ error: "server-error" });

  try {
    const audio = await readBody(req);
    if (audio.length < 1500) return res.status(400).json({ error: "too-short" });
    if (audio.length > MAX_BYTES) return res.status(413).json({ error: "too-long" });

    const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audio, {
      model: "nova-3",
      language: "en",
      punctuate: false,
    });
    if (error) {
      console.error("deepgram:", error);
      return res.status(502).json({ error: "server-error" });
    }

    const alt = result?.results?.channels?.[0]?.alternatives?.[0];
    const words = alt?.words ?? [];
    const heard = words.map((w) => clean(w.word)).filter(Boolean).join(" ");

    let pass: boolean;
    let heardButUnclear = false;
    if (sentenceTarget.length) {
      // Sentence mode: ≥80% of the target words recognized, in approximate order
      // (sequential matching tolerates recognizer insertions between words).
      const heardTokens = words.map((w) => clean(w.word)).filter(Boolean);
      let i = 0, matched = 0;
      for (const t of sentenceTarget) {
        const at = heardTokens.indexOf(t, i);
        if (at !== -1) { matched++; i = at + 1; }
      }
      pass = matched / sentenceTarget.length >= 0.8;
    } else {
      // Word mode: the exact target word was heard, confidently. Deepgram transcribes what
      // was actually said, so minimal pairs (three/tree, ship/sheep) are naturally protected.
      const hit = words.find((w) => clean(w.word) === target);
      pass = !!hit && hit.confidence >= PASS_CONFIDENCE;
      // The right word WAS heard, just not clearly — never tell the user
      // 'we heard "walked", try again' about the very word we asked for.
      heardButUnclear = !pass && !!hit;
    }

    const feedback = pass
      ? ""
      : heardButUnclear
        ? "Almost! We heard it, but not clearly — say it once more"
        : heard
          ? `We heard "${heard}" — try once more`
          : "We didn't catch it — try again";

    await trackVerify({ seconds: result?.metadata?.duration ?? 0, pass });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ pass, heard, feedback });
  } catch (err) {
    console.error("verify:", err);
    return res.status(500).json({ error: "server-error" });
  }
}
