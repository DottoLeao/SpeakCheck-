// Durable usage counters for the /admin dashboard.
// Backed by Vercel KV / Upstash Redis over its REST API (plain fetch — no client lib,
// serverless-friendly). If the env vars aren't set, every call is a graceful no-op,
// so the app keeps working with tracking simply disabled.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const usageEnabled = () => Boolean(KV_URL && KV_TOKEN);

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

/* ---------- writers (await-able, never throw) ---------- */

export async function trackAnalyze(m: {
  seconds?: number;
  inTok?: number;
  outTok?: number;
  cacheRead?: number;
  cacheCreate?: number;
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
  ]);
}

export async function trackVerify(m: { seconds?: number; pass?: boolean }): Promise<void> {
  const d = day();
  await pipeline([
    ["INCR", "sc:verify:count"],
    ["INCR", m.pass ? "sc:verify:pass" : "sc:verify:fail"],
    ["INCRBYFLOAT", "sc:dg_sec", m.seconds || 0],
    ["INCR", `sc:day:${d}:verify`],
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

  if (!usageEnabled()) {
    return {
      configured: false, totals: empty(),
      cost: { deepgram: 0, claude: 0, total: 0, perAnalysis: 0 },
      daily: lastDays(14).map((date) => ({ date, analyses: 0, verifies: 0 })),
      rates,
    };
  }

  const days = lastDays(14);
  const res = await pipeline([
    ["MGET", "sc:analyze:count", "sc:analyze:err", "sc:verify:count", "sc:verify:pass",
      "sc:verify:fail", "sc:dg_sec", "sc:in_tok", "sc:out_tok", "sc:cache_read", "sc:cache_create"],
    ...days.map((d) => ["MGET", `sc:day:${d}:analyze`, `sc:day:${d}:verify`]),
  ]);

  if (!res) {
    return {
      configured: false, totals: empty(),
      cost: { deepgram: 0, claude: 0, total: 0, perAnalysis: 0 },
      daily: days.map((date) => ({ date, analyses: 0, verifies: 0 })),
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

  return {
    configured: true,
    totals,
    cost: { deepgram, claude, total, perAnalysis: totals.analyses ? total / totals.analyses : 0 },
    daily,
    rates,
  };
}
