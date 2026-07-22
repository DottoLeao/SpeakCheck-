import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authRequired } from "../lib/auth";

// Public app config — lets the frontend configure itself from env vars,
// so the Google Client ID is never hardcoded in the HTML.
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    authRequired: authRequired(),
  });
}
