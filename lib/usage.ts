// Durable usage counters for the /admin dashboard.
// Backed by Vercel KV / Upstash Redis over its REST API (plain fetch — no client lib,
// serverless-friendly). If the env vars aren't set, every call is a graceful no-op,
// so the app keeps working with tracking simply disabled.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const usageEnabled = () => Boolean(KV_URL && KV_TOKEN);

/* ---------- usage limits (env-overridable; see README "Cost control") ---------- */
const envNum = (name: string, def: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};
export const LIMITS = {
  deviceAnalyzeDay: envNum("LIMIT_DEVICE_ANALYZE_DAY", 40),
  deviceVerifyDay: envNum("LIMIT_DEVICE_VERIFY_DAY", 80),
  deviceBurstMin: envNum("LIMIT_DEVICE_MIN", 8),
  globalAnalyzeDay: envNum("LIMIT_GLOBAL_ANALYZE_DAY", 600),
  globalVerifyDay: envNum("LIMIT_GLOBAL_VERIFY_DAY", 1200),
};

/* ---------- pricing (edit here if provider rates change) ---------- */
export const RATES = {
  deepgramPerMin: 0.0043,   // Deepgram Nova-3 pre-recorded, USD/minute
  claudeInPerMTok: 1.0,     // Claude Haiku 4.5 input, USD / 1M tokens
  claudeOutPerMTok: 5.0,    // Claude Haiku 4.5 output, USD / 1M tokens
  cacheReadMult: 0.1,       // cached input tokens bill at ~0.1x
  cacheWriteMult: 1.25,     // cache writes bill at ~1.25x
};

type Cmd = (string | number)[];

async function pipeline(cmds: Cmd[]): Promise<any[] | null> {
  if (!usageEnabled() || !cmds.length) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(`${KV_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    return (await r.json()) as any[];
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const day = () => new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD

/* ---------- durable quotas (per-device + global kill-switch) ----------
   Fixed windows: the bucket lives in the key NAME; EXPIRE is only garbage collection.
   Fail-open on KV trouble — the in-memory limiter in each handler still applies,
   and a Redis blip must never take the class down. */
export type QuotaResult = "ok" | "rate-limited" | "quota";

export async function checkQuota(
  kind: "analyze" | "verify",
  device: string,
  _ip: string
): Promise<QuotaResult> {
  if (!usageEnabled()) return "ok";
  const d = day();
  const minute = Math.floor(Date.now() / 60_000);
  const res = await pipeline([
    ["INCR", `q:m:${kind}:${device}:${minute}`],
    ["EXPIRE", `q:m:${kind}:${device}:${minute}`, 120],
    ["INCR", `q:d:${kind}:dev:${device}:${d}`],
    ["EXPIRE", `q:d:${kind}:dev:${device}:${d}`, 172800],
    ["INCR", `q:d:${kind}:all:${d}`],
    ["EXPIRE", `q:d:${kind}:all:${d}`, 172800],
  ]);
  if (!res) return "ok"; // KV unreachable → fail open

  const burst = Number(res[0]?.result ?? 0);
  const deviceDay = Number(res[2]?.result ?? 0);
  const globalDay = Number(res[4]?.result ?? 0);
  const devLimit = kind === "analyze" ? LIMITS.deviceAnalyzeDay : LIMITS.deviceVerifyDay;
  const allLimit = kind === "analyze" ? LIMITS.globalAnalyzeDay : LIMITS.globalVerifyDay;

  if (burst > LIMITS.deviceBurstMin) return "rate-limited";
  if (deviceDay > devLimit || globalDay > allLimit) return "quota";
  return "ok";
}

/* ---------- writers (await-able, never throw) ---------- */

/* ---------- user identity (Google sign-in) ---------- */

export async function recordLogin(
  u: { sub: string; email: string; name: string; pic: string },
  device?: string
): Promise<void> {
  const now = Date.now();
  const cmds: Cmd[] = [
    ["HSET", `sc:user:${u.sub}`, "email", u.email, "name", u.name, "pic", u.pic, "lastSeen", now],
    ["HSETNX", `sc:user:${u.sub}`, "firstSeen", now],
    ["SADD", "sc:users", u.sub],
  ];
  if (device) {
    cmds.push(["SADD", `sc:user:${u.sub}:devices`, device], ["SADD", "sc:devices", device]);
  }
  await pipeline(cmds);
}

/* Daily ranking is keyed by the request principal (user sub when signed in,
   device id otherwise); signed-in requests also keep the user↔device link fresh. */
const principalCmds = (d: string, principal?: string, sub?: string, device?: string): Cmd[] => {
  const cmds: Cmd[] = [];
  if (principal) {
    cmds.push(["ZINCRBY", `sc:day:${d}:dev`, 1, principal], ["EXPIRE", `sc:day:${d}:dev`, 1296000]); // 15d
  }
  if (sub) {
    cmds.push(["HSET", `sc:user:${sub}`, "lastSeen", Date.now()]);
    if (device) cmds.push(["SADD", `sc:user:${sub}:devices`, device], ["SADD", "sc:devices", device]);
  }
  return cmds;
};

export async function trackAnalyze(m: {
  seconds?: number;
  inTok?: number;
  outTok?: number;
  cacheRead?: number;
  cacheCreate?: number;
  principal?: string;
  sub?: string;
  device?: string;
  error?: boolean;
}): Promise<void> {
  if (m.error) {
    await pipeline([["INCR", "sc:analyze:err"]]);
    return;
  }
  const d = day();
  await pipeline([
    ["INCR", "sc:analyze:count"],
    ["INCRBYFLOAT", "sc:dg_sec", m.seconds || 0],
    ["INCRBY", "sc:in_tok", Math.round(m.inTok || 0)],
    ["INCRBY", "sc:out_tok", Math.round(m.outTok || 0)],
    ["INCRBY", "sc:cache_read", Math.round(m.cacheRead || 0)],
    ["INCRBY", "sc:cache_create", Math.round(m.cacheCreate || 0)],
    ["INCR", `sc:day:${d}:analyze`],
    ...principalCmds(d, m.principal, m.sub, m.device),
  ]);
}

export async function trackVerify(m: {
  seconds?: number;
  pass?: boolean;
  principal?: string;
  sub?: string;
  device?: string;
}): Promise<void> {
  const d = day();
  await pipeline([
    ["INCR", "sc:verify:count"],
    ["INCR", m.pass ? "sc:verify:pass" : "sc:verify:fail"],
    ["INCRBYFLOAT", "sc:dg_sec", m.seconds || 0],
    ["INCR", `sc:day:${d}:verify`],
    ...principalCmds(d, m.principal, m.sub, m.device),
  ]);
}

/* ---------- reader ---------- */

const N = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export type Stats = {
  configured: boolean;
  totals: {
    analyses: number;
    analyzeErrors: number;
    verifies: number;
    verifyPass: number;
    verifyFail: number;
    audioSeconds: number;
    inTokens: number;
    outTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
  cost: { deepgram: number; claude: number; total: number; perAnalysis: number };
  daily: { date: string; analyses: number; verifies: number }[];
  today: {
    analyses: number;
    verifies: number;
    limits: typeof LIMITS;
    topDevices: { id: string; count: number }[];
  };
  users: {
    total: number;
    devices: number;
    activeToday: number;
    top: { id: string; name: string; email: string; pic: string; count: number; devices: number; lastSeen: number }[];
  };
  rates: typeof RATES;
};

function lastDays(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

export async function readStats(): Promise<Stats> {
  const rates = RATES;
  const empty = (): Stats["totals"] => ({
    analyses: 0, analyzeErrors: 0, verifies: 0, verifyPass: 0, verifyFail: 0,
    audioSeconds: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
  });
  const emptyToday = (): Stats["today"] => ({ analyses: 0, verifies: 0, limits: LIMITS, topDevices: [] });
  const emptyUsers = (): Stats["users"] => ({ total: 0, devices: 0, activeToday: 0, top: [] });

  if (!usageEnabled()) {
    return {
      configured: false, totals: empty(),
      cost: { deepgram: 0, claude: 0, total: 0, perAnalysis: 0 },
      daily: lastDays(14).map((date) => ({ date, analyses: 0, verifies: 0 })),
      today: emptyToday(),
      users: emptyUsers(),
      rates,
    };
  }

  const days = lastDays(14);
  const d0 = day();
  const res = await pipeline([
    ["MGET", "sc:analyze:count", "sc:analyze:err", "sc:verify:count", "sc:verify:pass",
      "sc:verify:fail", "sc:dg_sec", "sc:in_tok", "sc:out_tok", "sc:cache_read", "sc:cache_create"],
    ...days.map((d) => ["MGET", `sc:day:${d}:analyze`, `sc:day:${d}:verify`]),
    ["GET", `q:d:analyze:all:${d0}`],
    ["GET", `q:d:verify:all:${d0}`],
    ["ZREVRANGE", `sc:day:${d0}:dev`, 0, 9, "WITHSCORES"],
    ["SCARD", "sc:users"],
    ["SCARD", "sc:devices"],
    ["ZCARD", `sc:day:${d0}:dev`],
  ]);

  if (!res) {
    return {
      configured: false, totals: empty(),
      cost: { deepgram: 0, claude: 0, total: 0, perAnalysis: 0 },
      daily: days.map((date) => ({ date, analyses: 0, verifies: 0 })),
      today: emptyToday(),
      users: emptyUsers(),
      rates,
    };
  }

  const g = (res[0]?.result ?? []) as any[];
  const totals: Stats["totals"] = {
    analyses: N(g[0]), analyzeErrors: N(g[1]), verifies: N(g[2]), verifyPass: N(g[3]),
    verifyFail: N(g[4]), audioSeconds: N(g[5]), inTokens: N(g[6]), outTokens: N(g[7]),
    cacheReadTokens: N(g[8]), cacheCreateTokens: N(g[9]),
  };

  const deepgram = (totals.audioSeconds / 60) * rates.deepgramPerMin;
  const claude =
    (totals.inTokens / 1e6) * rates.claudeInPerMTok +
    (totals.outTokens / 1e6) * rates.claudeOutPerMTok +
    (totals.cacheReadTokens / 1e6) * rates.claudeInPerMTok * rates.cacheReadMult +
    (totals.cacheCreateTokens / 1e6) * rates.claudeInPerMTok * rates.cacheWriteMult;
  const total = deepgram + claude;

  const daily = days.map((date, i) => {
    const r = (res[i + 1]?.result ?? []) as any[];
    return { date, analyses: N(r[0]), verifies: N(r[1]) };
  });

  // today: quota consumption + who is spending (ZREVRANGE WITHSCORES → flat [member, score, ...])
  const base = 1 + days.length;
  const zflat = (res[base + 2]?.result ?? []) as any[];
  const topDevices: { id: string; count: number }[] = [];
  for (let i = 0; i + 1 < zflat.length; i += 2) {
    topDevices.push({ id: String(zflat[i]), count: N(zflat[i + 1]) });
  }
  const today: Stats["today"] = {
    analyses: N(res[base]?.result),
    verifies: N(res[base + 1]?.result),
    limits: LIMITS,
    topDevices,
  };

  // join today's top principals with their Google profiles (2nd pipeline)
  const users: Stats["users"] = {
    total: N(res[base + 3]?.result),
    devices: N(res[base + 4]?.result),
    activeToday: N(res[base + 5]?.result),
    top: [],
  };
  if (topDevices.length) {
    // Ranking ids carry the quota principal ("u:{sub}" for signed-in users);
    // profile keys are stored under the bare sub — strip the prefix to join.
    const subOf = (id: string) => (id.startsWith("u:") ? id.slice(2) : id);
    const prof = await pipeline(
      topDevices.flatMap((t) => [
        ["HGETALL", `sc:user:${subOf(t.id)}`],
        ["SCARD", `sc:user:${subOf(t.id)}:devices`],
      ])
    );
    users.top = topDevices.map((t, i) => {
      const flat = (prof?.[i * 2]?.result ?? []) as any[];
      const h: Record<string, string> = {};
      for (let j = 0; j + 1 < flat.length; j += 2) h[String(flat[j])] = String(flat[j + 1]);
      return {
        id: t.id,
        name: h.name || "Anonymous device",
        email: h.email || "",
        pic: h.pic || "",
        count: t.count,
        devices: N(prof?.[i * 2 + 1]?.result),
        lastSeen: N(h.lastSeen),
      };
    });
  }

  return {
    configured: true,
    totals,
    cost: { deepgram, claude, total, perAnalysis: totals.analyses ? total / totals.analyses : 0 },
    daily,
    today,
    users,
    rates,
  };
}
