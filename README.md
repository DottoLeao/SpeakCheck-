<div align="center">

# SpeakCheck — Pronunciation Lab

**An AI-powered speech coach for English learners.**

Speak freely and get instant, personalized feedback on pronunciation, grammar, and vocabulary — powered by a professional Speech-to-Text-to-Text pipeline: MediaRecorder → Deepgram ASR → Claude analysis → structured JSON → live UI.

<br>

[![Live Demo](https://img.shields.io/badge/Live_Demo-Try_it_now-66BC29?style=for-the-badge&logo=googlechrome&logoColor=white)](https://dottoleao.github.io/SpeakCheck-/)

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-3B53A4?style=for-the-badge&logo=css3&logoColor=white)
![Web Speech API](https://img.shields.io/badge/Web_Speech_API-Speech_to_Text-3B53A4?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-lightgrey?style=for-the-badge)

<br>

<img src="img.png" alt="SpeakCheck demo" width="420">

</div>

---

## Overview

SpeakCheck listens to you speak English and gives coaching feedback on three axes: **pronunciation** (via word-level confidence from a professional speech recognizer — a word transcribed with low confidence is a word your mouth distorted), **grammar**, and **vocabulary** (via LLM analysis). Each issue becomes a card: pronunciation cards are interactive (**hear** the native pronunciation, then **say it back** until you nail it), grammar/vocabulary cards explain the fix. You also get the natural, corrected version of your sentence.

The interface is themed after [Pacific English Study](https://pacificenglishschool.com/), a real language school on the Gold Coast, Australia — built as a white-label branding exercise using the school's official colours and identity.

## Key features

- **Free speech input** — no scripts to read; speak up to a minute and tap the mic to stop
- **Session score** — a 0–100 ring per attempt (mean word confidence minus grammar/vocabulary penalties) for instant progress feedback
- **Three feedback axes** — pronunciation (ASR confidence signal), grammar, and vocabulary (LLM), each with its own card style — one card for *every* issue found, no cap
- **Exact-error highlight** — the likely-wrong part of each word (the *-ed* of "worked", the *th* of "think") is highlighted inside the word, in the transcript and on the card. Honest caveat: the ASR signal is per-word, so the sub-word location is the LLM's linguistic inference about the low-confidence word — the same approximation established pronunciation apps use in practice
- **Natural version** — the corrected, natural phrasing of what you said, shown alongside the transcript
- **Hear / Say loop** — native TTS playback (normal and extra-slow 🐢), then per-word re-recording verified server-side (minimal pairs like *three*/*tree* are naturally protected: the recognizer transcribes what you actually said)
- **Glassmorphism UI** — frosted-glass surfaces over a brand-colored mesh gradient, light and dark, with a solid fallback for browsers without `backdrop-filter`
- **Word-by-word report** — every spoken word gets a confidence score chip (green/amber/red); note the signal is per-word, not per-phoneme — a swallowed ending shows up as low confidence on the whole word, and the coaching tip points at which part likely failed
- **"My voice" playback** — your recording is kept in the browser (never re-uploaded) and sliced by the recognizer's word timings, so you can replay exactly how *you* said a word and compare it with the native TTS
- **Progressive loader** — staged progress (upload → transcribe → coach) with skeleton cards while the analysis runs
- **Teacher-style corrections** — flagged words get a red wavy underline (plus a ⚠/✓ marker) that turns green when fixed
- **Light & dark mode**, **screen-reader accessible**, **micro-interactions** with `prefers-reduced-motion` support
- **Clear error feedback** — distinct messages for denied permission, silence, short/long recordings, network and server errors

## How it works

```
MediaRecorder (250ms chunks → Blob)
  → POST /api/analyze  ─→ Deepgram Nova-3 (words + confidence)
                       ─→ Claude (claude-haiku-4-5, structured JSON output)
  → JSON contract      ─→ transcript flags + cards + corrected sentence
  → POST /api/verify   ─→ Deepgram + exact-token match  (the "Say it" check)
```

| Layer | Choice | Why |
|---|---|---|
| Audio capture | **MediaRecorder API** | Consistent across browsers (webm/opus; mp4 on iOS Safari) — replaces the flaky `SpeechRecognition` |
| Speech-to-text | **Deepgram Nova-3** | Fast, accurate ASR with word-level confidence — the pronunciation signal |
| Analysis | **Claude Haiku 4.5** (structured outputs) | Grammar/vocabulary coaching with a guaranteed JSON schema — no parse errors |
| Backend | **Vercel serverless functions** (TypeScript) | Keys stay server-side; zero-ops deploys |
| Text-to-speech | **SpeechSynthesis API** (client) | Native voices, rate control, free |
| UI | **Vanilla HTML/CSS/JS** | Single file, no build step, instant load |
| Icons / Animation | **Lucide** + **Motion** (pinned CDN) | Micro-interactions, auto-disabled under `prefers-reduced-motion` |

## Running locally

```bash
git clone https://github.com/DottoLeao/SpeakCheck-.git
cd SpeakCheck-
npm install
npx vercel dev        # serves index.html + /api functions on localhost:3000
```

Set environment variables (locally in `.env.local` / on Vercel in Project Settings):

```
DEEPGRAM_API_KEY=...   # console.deepgram.com — generous free tier   (required)
ANTHROPIC_API_KEY=...  # console.anthropic.com                        (required)
ADMIN_PASSWORD=...      # gate for the /admin dashboard               (required for /admin)
```

> Microphone capture requires HTTPS or localhost. Deploying is `vercel --prod` (or connect the repo on vercel.com).

## Admin dashboard (`/admin`)

A password-gated page at **`/admin`** shows live API usage, estimated cost (Deepgram + Claude broken out), a 14-day activity chart, and an interactive **capacity & cost planner** — set your class size and usage profile to project the monthly cost and how many students a given budget supports. The password lives in the `ADMIN_PASSWORD` secret and is verified server-side (`/api/admin-stats`); it's never in the client. There's no user/login system — just the one gate.

**Live counters** are persisted in a KV store (Vercel KV / Upstash Redis). It's optional: without it the dashboard still shows the cost model and planner, just with zeroed counters. To enable it, in your Vercel project go to **Storage → Create Database → Upstash for Redis** (free tier) and redeploy — Vercel injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically, and [lib/usage.ts](lib/usage.ts) picks them up with no code change.

> Capacity at this scale: a 20-student class at moderate use (~8 analyses + 6 "say it" checks per student, twice a week) costs roughly **$6/month** total. The bottleneck is ongoing cost (cents), not concurrency; Deepgram's free credit alone covers many months. Adjust the planner's assumptions to fit your class.

## Google sign-in (access control)

The app supports **Sign in with Google**: students authenticate with their Google account, the mic is gated until they do, and quotas/stats become **per person** instead of per browser. The `/admin` page shows every signed-in user (name, e-mail, devices, last seen, requests today).

It auto-enables when configured — until then the app runs open. To turn it on (~5 min, one time):

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project (e.g. "SpeakCheck").
2. **APIs & Services → OAuth consent screen** → External → fill the app name → publish.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized JavaScript origins: `https://speakcheck.vercel.app` and `http://localhost:3000`.
4. Copy the **Client ID** (`....apps.googleusercontent.com`) → add it in Vercel as env `GOOGLE_CLIENT_ID` (Production + Development) → redeploy.

From that deploy on, the sign-in gate is enforced (server-side too — `/api/analyze` and `/api/verify` return 401 without a valid session). Sessions are HMAC-signed (`AUTH_SECRET`, 30 days).

**Optional allowlist**: set `ALLOWED_EMAILS=ana@gmail.com,leo@gmail.com` to restrict access to specific accounts; anyone else gets "not authorized". Leave unset to allow any Google account (default).

> iOS note: the installed PWA and Safari keep separate sessions — sign in once in each. The Google popup works in both.

## Cost control (4 layers)

No single student can drain the budget. Quota checks run **before** any Deepgram/Claude spend, keyed to an anonymous per-browser device id (not IP — the whole class shares the school's IP). All limits are enforced durably in KV and fail open if KV is down (the in-memory limiter still applies).

| Layer | Default | Env override |
|---|---|---|
| Per device / day | 40 analyses · 80 "say it" | `LIMIT_DEVICE_ANALYZE_DAY` · `LIMIT_DEVICE_VERIFY_DAY` |
| Per device / minute (burst) | 8 of each | `LIMIT_DEVICE_MIN` |
| Global / day (kill-switch) | 600 analyses · 1200 checks (worst day ≈ $3) | `LIMIT_GLOBAL_ANALYZE_DAY` · `LIMIT_GLOBAL_VERIFY_DAY` |
| Provider hard cap | — | Set a monthly spend limit at [console.anthropic.com](https://console.anthropic.com) → Settings → **Limits**. Deepgram is prepaid credit — a natural cap. |

Blocked requests return 429 (`rate-limited` / `quota`) with a friendly message in the app. The `/admin` dashboard shows today's consumption vs the caps and the **top 10 devices** by requests, so you can see exactly who is spending.

## Learning loop & PWA

- **Score delta**: record the same sentence again and the score ring shows **▲/▼ vs your last try** (detected automatically by transcript similarity — no button needed).
- **Try this next**: every analysis ends with a fresh sentence generated to exercise *your* weakest sounds; it also becomes the mic-card hint, closing the practice loop.
- **Say the corrected sentence**: the "Natural version" block has Hear it / Say it — the whole sentence is verified server-side (≥80% of its words recognized in order).
- **Installable PWA**: `manifest.json` + `sw.js` (HTML network-first so deploys land immediately; API never cached). On your phone: browser menu → *Add to Home Screen*. Note: on iOS, mic access inside an installed PWA needs iOS 16.4+ — if it fails, use it in Safari directly.

## Roadmap

- [x] Per-session score
- [x] Suggested next sentence targeting your weak sounds (ELSA-style guided loop)
- [ ] Practice history + daily streak via localStorage (no account needed)
- [ ] IPA transcription on pronunciation cards
- [ ] Spaced repetition of past mistakes; minimal-pair drills
- [ ] Custom word lists per class level (A1–C1)
- [ ] Sentence-level stress and rhythm feedback

## Author

**Lorenzo Leão Dotto** — Full Stack Developer & Data Scientist

[![Portfolio](https://img.shields.io/badge/Portfolio-lorenzodotto.com.br-3B53A4?style=flat-square&logo=googlechrome&logoColor=white)](https://lorenzodotto.com.br)
[![GitHub](https://img.shields.io/badge/GitHub-DottoLeao-181717?style=flat-square&logo=github)](https://github.com/DottoLeao)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Lorenzo_Dotto-0A66C2?style=flat-square&logo=linkedin)](https://linkedin.com/in/lorenzo-leão-dotto)

## License

Released under the [MIT License](LICENSE).
