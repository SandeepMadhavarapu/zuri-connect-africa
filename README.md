# Zuri Connect Africa

> A production-oriented M-PESA-style mobile money platform — server-authoritative payments, a cryptographically tamper-evident ledger, biometric authentication, graph-based fraud detection, and multi-provider AI orchestration.

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?logo=supabase&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-Vitest%20%2B%20Playwright-green)
![License](https://img.shields.io/badge/License-MIT-blue)
![CI](https://github.com/SandeepMadhavarapu/zuri-connect-africa/actions/workflows/ci.yml/badge.svg)

---

## About

Zuri Connect Africa is a Safaricom/M-PESA-style mobile money platform I built to go deep on production-grade fintech engineering — the parts that are hard to get right when real money moves: an immutable ledger, idempotent payments, fraud detection, and secure authentication.

It spans a React + TypeScript frontend and a Supabase backend of **14 Edge Functions** and **30+ versioned SQL migrations**, covering M-PESA payment initiation, Daraja webhook handling, settlement recovery, biometric auth, fraud analysis, and admin reconciliation.

> **Status:** Active development. The architecture follows production patterns, but the platform is **not deployed to move real money** — it runs against placeholder/staging credentials.

---

## Key Features

### Payments & Ledger
- **Server-authoritative payments** across 14 Supabase Edge Functions — STK Push initiation, Daraja webhook validation, settlement recovery, admin reconciliation
- **Immutable double-entry ledger** with **SHA-256 hash-chained entries** for tamper detection
- **Idempotency keys** and **atomic Postgres RPC posting** to prevent double-charges and duplicate webhook processing
- **Local-first durability** with non-blocking server sync — survives flaky mobile connectivity
- **Replay-safe reconciliation engine** for automated ledger-discrepancy recovery

### Authentication & Security
- **WebAuthn (FIDO2) biometric auth** — Face ID, Touch ID, Windows Hello, Android fingerprint
- **Adaptive device-trust scoring** with **transaction step-up** for high-risk operations
- **Voice verification** via the Web Audio API (MFCC-style features, cosine-similarity matching, replay-attack detection)
- **Hardened OTPs** — SHA-256 hashing, expiry enforcement, rate-limited attempt locking
- **Content Security Policy** pins AI traffic to the server router so provider keys never reach the browser

### Fraud Detection
- **Graph-based fraud engine** tracking 8 entity types (device, phone, recipient, merchant, IP, transaction, auth failure, scam report)
- **Propagated risk scoring** across entity relationships, with velocity-window signals and adaptive escalation
- **Automated mule-account detection** via graph traversal

### Policy Engine
- Configurable policy engine architecturally comparable to **OPA** and **AWS Cedar** — registry, schemas, conditions, evaluator, audit logging, dry-run simulation, and live metrics

### AI Orchestration
- **Multi-provider routing** across OpenAI, Anthropic, and Google Gemini through a Supabase Edge Function
- **Per-provider circuit breakers** with automatic failover, language detection, conversational memory, and safety filters

### Observability & Quality
- Distributed tracing (correlation IDs, span tracking, startup watchdog)
- **Vitest** unit + integration tests and **Playwright** E2E smoke tests
- Dockerized **nginx** delivery with security headers and rate limiting

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 18 · TypeScript · Vite · Tailwind CSS · Radix UI · React Query |
| **Backend** | Supabase (Postgres + Edge Functions + RLS) · Node.js |
| **Auth** | WebAuthn (FIDO2) · Supabase Auth · OTP |
| **Payments** | M-PESA / Daraja REST API · Africa's Talking |
| **AI** | OpenAI · Anthropic · Google Gemini |
| **Testing** | Vitest · Playwright |
| **Deployment** | Docker · nginx · Vercel |

---

## Getting Started

### Prerequisites
- Node.js 20+
- npm 10+

### Quick start
```bash
npm install
cp .env.local.example .env.local
# Add only browser-safe Vite values: Supabase URL and anon key
npm run dev
```

### Environment files

| File | Purpose |
|------|---------|
| `.env.local` | Local developer overrides (gitignored) |
| `.env.local.example` | Template for local |
| `.env.development.example` | Development defaults |
| `.env.staging.example` | Staging cluster |
| `.env.production.example` | Production cluster |

Set `VITE_APP_ENV` to `local`, `development`, `staging`, or `production`. In staging/production (or when `VITE_STRICT_ENV=true`), the Supabase URL and anon key are required at startup.

> **Secrets:** Only values prefixed with `VITE_` are bundled into the browser. Never put service-role keys, Daraja credentials, AI provider keys, OTP secrets, or webhook secrets in any client env file. Store those as Supabase Edge Function secrets:

```bash
supabase secrets set OPENAI_API_KEY=...
supabase secrets set ANTHROPIC_API_KEY=...
supabase secrets set GEMINI_API_KEY=...
supabase secrets set DARAJA_CONSUMER_KEY=...
supabase secrets set DARAJA_CONSUMER_SECRET=...
supabase secrets set DARAJA_PASSKEY=...
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
```

The browser CSP intentionally blocks direct connections to OpenAI, Anthropic, Gemini, and Africa's Talking — all AI traffic routes through the Supabase `ai-router` Edge Function.

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite dev server |
| `npm run build` | Production bundle |
| `npm run preview` | Preview production build |
| `npm run lint` / `npm run typecheck` | Quality gates |
| `npm run test` | Vitest (unit + integration) |
| `npm run test:e2e` | Playwright smoke tests |
| `npm run validate:env` | Env validation for CI/Docker |

---

## Project Structure

The frontend lives in `src/` — with `api/` (typed API client layer), `backend/` (server-side domain logic for fraud, the OPA/Cedar-style policy engine, reconciliation, and Daraja webhook handling with a dead-letter queue), `lib/` (core libraries including the multi-provider AI orchestrator, observability, and the voice-verification engine), `services/` (auth, ledger, payment, and fraud service layers), `pages/` (application screens), and `components/` (reusable UI).

The backend lives in `supabase/` — with `functions/` (14 Edge Functions) and `migrations/` (30+ versioned SQL migrations).

---

## Docker

```bash
docker compose build --build-arg VITE_SUPABASE_URL=... --build-arg VITE_SUPABASE_ANON_KEY=...
docker compose up -d
```

Images serve static assets via `nginx.conf` (rate limits and security headers). CSP lives in deployment headers (`nginx.conf` / `vercel.json`), not `index.html`.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Vercel, Supabase, Railway/Fly.io, rollback, and branch protection.

---

## CI/CD

Every push and pull request to `main` runs a [GitHub Actions workflow](.github/workflows/ci.yml) that:
- Installs dependencies with `npm ci`
- Runs ESLint
- Runs the Vitest unit + integration suite
- Builds the production bundle

A green check on `main` means lint, tests, and build all pass in a clean environment.

---

## License

MIT

---

**Built by [Sandeep Madhavarapu](https://github.com/SandeepMadhavarapu)** — CS @ George Mason University
