import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, timingSafeEqual } from "crypto";
import { readStats } from "../lib/usage";

// Password gate for the /admin dashboard. The password lives in the ADMIN_PASSWORD
// env var (a Vercel secret) — never in the client. This is a lightweight gate, not a
// full auth system, which is all a single-class internal dashboard needs.

const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > windowMs) { hits.set(ip, { n: 1, t: now }); return false; }
  h.n++;
  return h.n > max;
}

// Constant-time compare via fixed-length hashes (avoids length/timing leaks).
function passwordOK(input: string): boolean {
  const secret = process.env.ADMIN_PASSWORD || "";
  if (!secret) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

async function readJson(req: VercelRequest): Promise<any> {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate-limited" });

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: "not-configured" });
  }

  const body = await readJson(req);
  if (!passwordOK(String(body?.password ?? ""))) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const stats = await readStats();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(stats);
  } catch (err) {
    console.error("admin-stats:", err);
    return res.status(500).json({ error: "server-error" });
  }
}
