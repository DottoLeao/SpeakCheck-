import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@deepgram/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { trackAnalyze } from "../lib/usage";

// We read the raw audio body ourselves — no JSON body parsing.
export const config = { api: { bodyParser: false } };

const MAX_BYTES = 4 * 1024 * 1024; // Vercel request body limit is 4.5MB
const LOW_CONFIDENCE = 0.85;       // below this, a word is flagged as a pronunciation suspect
const MODEL = "claude-haiku-4-5";  // swap for "claude-opus-4-8" for higher quality analysis

/* ---------- learner settings (allowlisted from query params) ---------- */
const ACCENTS: Record<string, string> = {
  au: "Australian English",
  uk: "British English",
  us: "American English",
};
const TIP_LANGS = new Set([
  "English", "Portuguese", "Spanish", "Japanese", "Korean",
  "French", "German", "Italian", "Chinese", "Thai",
]);

/* Function words whose ASR confidence is noise, not a pronunciation signal. */
const STOP_WORDS = new Set([
  "a", "an", "in", "on", "at", "to", "of", "is", "it", "am", "and", "or",
  "the", "but", "as", "by", "be", "do", "so", "up", "we", "he", "me", "my",
  "no", "if", "us", "uh", "um", "oh",
]);

/* ---------- best-effort per-instance rate limit ---------- */
const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string, max = 20, windowMs = 60_000): boolean {
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

/* ---------- structured output schema (shape guaranteed by the API) ---------- */
const ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["transcript", "cards", "corrected", "corrected_translation", "praise", "next_sentence"],
  properties: {
    transcript: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["word", "status", "card_id"],
        properties: {
          word: { type: "string" },
          status: { type: "string", enum: ["ok", "flag"] },
          card_id: { type: "string" }, // "" when status is "ok"
        },
      },
    },
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "word", "type", "tip", "practice", "focus"],
        properties: {
          id: { type: "string" },
          word: { type: "string" },
          type: { type: "string", enum: ["pronunciation", "grammar", "vocabulary"] },
          tip: { type: "string" },
          practice: { type: "boolean" },
          focus: { type: "string" }, // exact substring of `word` where the error is; "" = whole word
        },
      },
    },
    corrected: { type: "string" },
    corrected_translation: { type: "string" }, // meaning of `corrected` in tip_language; "" when English
    praise: { type: "string" },
    next_sentence: { type: "string" }, // new practice sentence targeting this learner's weaknesses; "" when clean
  },
} as const;

const SYSTEM_PROMPT = `You are the analysis engine of SpeakCheck, a friendly English coaching app for language learners at a school in Australia.

You receive JSON: {"words": [{"word": "...", "confidence": 0.0-1.0}, ...], "accent": "...", "tip_language": "..."}. "words" is the output of a speech recognizer, in spoken order; words with confidence below ${LOW_CONFIDENCE} are marked pronunciation suspects. "accent" is the English variety the learner is being taught. "tip_language" is the language the learner reads most comfortably.

Produce an analysis with:

1. "transcript": echo EVERY input word, in the SAME order, spelled EXACTLY as given. Set status "flag" and a card_id for words with an issue; otherwise status "ok" and card_id "". If the same issue covers several words (e.g. a grammar issue spanning "go to beach"), flag each word with the SAME card_id.

2. "cards": one per distinct issue, most important first. Cover EVERY issue you find — do not cap the list.
   - type "pronunciation": create one card for EVERY word listed as a low-confidence suspect (same word twice = one card). practice=true. "word" is the single word to practise. If the word ends in a sound learners often swallow (-ed, -s/-es, -th, -ng, consonant clusters), name the ending explicitly in the tip (e.g. "the '-ed' ending — say 'workt'", "finish the '-ng': /ɪŋ/").
   - type "grammar": wrong tense, missing article, agreement, word order. practice=false. "word" is a short label of the issue (e.g. "past tense", "article 'the'").
   - type "vocabulary": an unnatural word choice where a clearly better word exists. practice=false. "word" is the better word.
   - "tip": ONE short, encouraging, plain-language sentence. For pronunciation, describe the mouth/sound (e.g. "'th' — tongue between the teeth, not 't' or 's'."). For grammar/vocabulary, say what to use instead and why, briefly.
   - "focus": for pronunciation cards, the EXACT part of "word" where the error most likely is — the letters of the sound learners of English typically get wrong in that word (the "ed" of "worked", the "th" of "think", the "i" of "ship"). It MUST be a literal substring of "word". Use "" when the whole word is the problem, and always "" for grammar/vocabulary cards.
   - "id": "c1", "c2", ... in order.

3. "corrected": the natural, grammatically correct version of what the speaker meant. If the sentence is already natural, repeat it as-is. Also produce "corrected_translation": the meaning of "corrected" translated into tip_language, natural and concise — so a learner who doesn't read English understands what they are practising. "" when tip_language is English or when "corrected" is "".

4. "praise": one short, specific positive sentence about something the speaker did well ("" only if the input is a single word or gibberish).

5. "next_sentence": one NEW short English practice sentence (8-14 words) that deliberately exercises this learner's weakest sounds and mistakes from this attempt — reuse the tricky sounds (e.g. flagged "th" → include think/weather/three), not the same sentence. Always plain English regardless of tip_language. "" when there were no issues to practise.

Rules: do not invent words that are not in the input. Do not flag proper nouns, filler words ("uh", "um") or casual-but-correct speech. When in doubt, don't flag. Empty cards array is a valid, good outcome.

Judge pronunciation against the learner's "accent" variety — NEVER flag a pronunciation that is correct in that variety (e.g. non-rhotic "rather" /ˈrɑːðə/ is correct in Australian and British English). Tips should teach the sounds of that variety.

NEVER create pronunciation cards for one- or two-letter words or basic function words (a, an, in, on, at, to, of, is, it, and, or, the, but) — recognizer confidence on these is noise, not a pronunciation signal.

Write every "tip" and "praise" FULLY in the learner's "tip_language" — grammar terms included (e.g. Portuguese: "a terminação '-ed'", never "the '-ed' ending"). Only IPA symbols (/t/, /θ/) and quoted English example words ('walkt', 'think') stay as-is. Keep "word", "focus" and "corrected" in English — they are the study material. When tip_language is English, everything is in English.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "server-error" });

  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate-limited" });

  // Learner settings from the client (allowlisted — anything unknown falls back to defaults).
  const accent = ACCENTS[String(req.query.accent ?? "au").toLowerCase()] ?? ACCENTS.au;
  const langQ = String(req.query.lang ?? "English");
  const tipLang = TIP_LANGS.has(langQ) ? langQ : "English";

  try {
    const audio = await readBody(req);
    if (audio.length < 2000) return res.status(400).json({ error: "too-short" });
    if (audio.length > MAX_BYTES) return res.status(413).json({ error: "too-long" });

    /* ---------- 1. ASR: Deepgram ---------- */
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audio, {
      model: "nova-3",
      language: "en",
      punctuate: false,
      filler_words: true,
    });
    if (error) {
      console.error("deepgram:", error);
      return res.status(502).json({ error: "server-error" });
    }

    const alt = result?.results?.channels?.[0]?.alternatives?.[0];
    // Full per-word data (confidence + timings) — timings power the client's
    // "play your own voice" slices and the word-by-word report.
    const dgWords = (alt?.words ?? []).map((w) => ({
      word: w.word.toLowerCase(),
      confidence: Math.round(w.confidence * 100) / 100,
      start: Math.round(w.start * 100) / 100,
      end: Math.round(w.end * 100) / 100,
    }));
    if (!dgWords.length) return res.status(422).json({ error: "no-speech" });
    // The LLM only needs word + confidence — keep timings out of the prompt.
    const words = dgWords.map(({ word, confidence }) => ({ word, confidence }));

    /* ---------- 2. LLM: Claude with structured output ---------- */
    const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from env
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2500,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT, // stable/frozen → cacheable prefix
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: { format: { type: "json_schema", schema: ANALYZE_SCHEMA } },
      messages: [{ role: "user", content: JSON.stringify({ words, accent, tip_language: tipLang }) }],
    });

    const text = msg.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      console.error("no text block in response, stop_reason:", msg.stop_reason);
      return res.status(502).json({ error: "server-error" });
    }
    const analysis = JSON.parse(text.text);

    // Light sanity check: transcript must echo the recognizer's words.
    if (!Array.isArray(analysis.transcript) || analysis.transcript.length === 0) {
      return res.status(502).json({ error: "server-error" });
    }
    if (Array.isArray(analysis.cards)) {
      // Guardrail: drop pronunciation cards for tiny function words (ASR noise, not signal),
      // and un-flag their transcript entries so the UI stays consistent.
      const dropped = new Set<string>();
      analysis.cards = analysis.cards.filter((c: any) => {
        const w = String(c.word ?? "").toLowerCase();
        const noise = c.type === "pronunciation" && (w.length <= 2 || STOP_WORDS.has(w));
        if (noise) dropped.add(c.id);
        return !noise;
      });
      if (dropped.size && Array.isArray(analysis.transcript)) {
        for (const t of analysis.transcript) {
          if (dropped.has(t.card_id)) { t.status = "ok"; t.card_id = ""; }
        }
      }

      // `focus` must be a literal substring of `word` — the client highlights it inside the word.
      for (const c of analysis.cards) {
        if (typeof c.focus !== "string" || !c.word?.toLowerCase().includes(c.focus.toLowerCase())) {
          c.focus = "";
        }
      }
    }

    // Record usage for the /admin dashboard (no-op if KV isn't configured; never blocks the result).
    const u = msg.usage as any;
    await trackAnalyze({
      seconds: result?.metadata?.duration ?? 0,
      inTok: u?.input_tokens ?? 0,
      outTok: u?.output_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheCreate: u?.cache_creation_input_tokens ?? 0,
    });

    res.setHeader("Cache-Control", "no-store");
    // Attach the raw recognizer words (confidence + timings) alongside the LLM analysis.
    return res.status(200).json({ ...analysis, words: dgWords });
  } catch (err) {
    console.error("analyze:", err);
    trackAnalyze({ error: true }).catch(() => {});
    return res.status(500).json({ error: "server-error" });
  }
}
