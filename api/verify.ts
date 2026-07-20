import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@deepgram/sdk";

// Raw audio body — no JSON body parsing.
export const config = { api: { bodyParser: false } };

const MAX_BYTES = 1 * 1024 * 1024;   // "Say it" recordings are ~4s — 1MB is plenty
const PASS_CONFIDENCE = 0.6;         // the target word must be heard with at least this confidence

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

  const target = clean(String(req.query.word ?? ""));
  if (!target) return res.status(400).json({ error: "server-error" });

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

    // Pass = the exact target word was heard, confidently. Deepgram transcribes what was
    // actually said, so minimal pairs (three/tree, ship/sheep) are naturally protected.
    const pass = words.some((w) => clean(w.word) === target && w.confidence >= PASS_CONFIDENCE);

    const feedback = pass
      ? ""
      : heard
        ? `We heard "${heard}" — try once more`
        : "We didn't catch it — try again";

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ pass, heard, feedback });
  } catch (err) {
    console.error("verify:", err);
    return res.status(500).json({ error: "server-error" });
  }
}
