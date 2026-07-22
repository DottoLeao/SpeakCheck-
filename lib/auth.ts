// Session auth for SpeakCheck — framework-free HMAC tokens.
// Auth as a whole is enabled by the presence of GOOGLE_CLIENT_ID; until it is
// set, the app runs open (authRequired() === false) and nothing changes.
import { createHmac, timingSafeEqual } from "crypto";
import type { VercelRequest } from "@vercel/node";

const SECRET = process.env.AUTH_SECRET || "";

export type SessionUser = { sub: string; email: string; name: string; pic: string; exp: number };

export const authRequired = (): boolean => Boolean(process.env.GOOGLE_CLIENT_ID && SECRET);

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function signSession(u: { sub: string; email: string; name: string; pic: string }, days = 30): string {
  const payload: SessionUser = { ...u, exp: Date.now() + days * 86400000 };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", SECRET).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string): SessionUser | null {
  if (!SECRET || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = fromB64url(token.slice(dot + 1));
  const expect = createHmac("sha256", SECRET).update(body).digest();
  if (sig.length !== expect.length || !timingSafeEqual(sig, expect)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as SessionUser;
    if (!payload.sub || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getUser(req: VercelRequest): SessionUser | null {
  const h = String(req.headers.authorization ?? "");
  if (!h.startsWith("Bearer ")) return null;
  return verifySession(h.slice(7).trim());
}
