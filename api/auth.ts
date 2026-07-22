import type { VercelRequest, VercelResponse } from "@vercel/node";
import { OAuth2Client } from "google-auth-library";
import { signSession, authRequired } from "../lib/auth";
import { recordLogin } from "../lib/usage";

// Exchanges a Google ID token (from the Sign in with Google button) for our own
// HMAC session token, and records the user + device in KV for the admin view.

const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > windowMs) { hits.set(ip, { n: 1, t: now }); return false; }
  h.n++;
  return h.n > max;
}

const cleanDevice = (v: unknown) => String(v ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);

async function readJson(req: VercelRequest): Promise<any> {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!authRequired()) return res.status(400).json({ error: "auth-disabled" });

  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate-limited" });

  try {
    const body = await readJson(req);
    const credential = String(body?.credential ?? "");
    const device = cleanDevice(body?.device);
    if (!credential) return res.status(400).json({ error: "auth" });

    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p?.sub) return res.status(401).json({ error: "auth" });

    const email = (p.email || "").toLowerCase();

    // Optional allowlist (comma-separated emails). Empty/unset = anyone with a Google account.
    const allowed = (process.env.ALLOWED_EMAILS || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(email)) {
      return res.status(403).json({ error: "not-allowed" });
    }

    const user = { sub: p.sub, email, name: p.name || email || "Student", pic: p.picture || "" };
    await recordLogin(user, device);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      token: signSession(user),
      user: { name: user.name, email: user.email, pic: user.pic },
    });
  } catch (err) {
    console.error("auth:", err);
    return res.status(401).json({ error: "auth" });
  }
}
