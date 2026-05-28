# Zuri Connect Africa

Production-oriented React + Vite SPA with Supabase-backed auth, ledger, fraud, and settlement flows.

## Prerequisites

- Node.js 20+
- npm 10+

## Quick start

```bash
npm install
cp .env.local.example .env.local
# Add only browser-safe Vite values: Supabase URL and anon key
npm run dev
```

## Environment files

| File | Purpose |
|------|---------|
| `.env.local` | Local developer overrides (gitignored) |
| `.env.local.example` | Template for local |
| `.env.development.example` | Development defaults |
| `.env.staging.example` | Staging cluster |
| `.env.production.example` | Production cluster |

Set `VITE_APP_ENV` to `local`, `development`, `staging`, or `production`. In staging/production (or when `VITE_STRICT_ENV=true`), Supabase URL and anon key are required at startup.

Only values prefixed with `VITE_` are bundled into the browser. Do not put service-role keys, Daraja credentials, AI provider keys, OTP secrets, or webhook secrets in `.env.local` or any client env file. Store those with Supabase Edge Function secrets instead:

```bash
supabase secrets set OPENAI_API_KEY=...
supabase secrets set ANTHROPIC_API_KEY=...
supabase secrets set GEMINI_API_KEY=...
supabase secrets set DARAJA_CONSUMER_KEY=...
supabase secrets set DARAJA_CONSUMER_SECRET=...
supabase secrets set DARAJA_PASSKEY=...
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
```

Browser CSP intentionally blocks direct connections to OpenAI, Anthropic, Gemini, and Africa's Talking. AI traffic must go through the Supabase `ai-router` Edge Function.

CLI checks:

```bash
npm run validate:env
npm run validate:env:strict
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite dev server |
| `npm run build` | Production bundle |
| `npm run preview` | Preview production build |
| `npm run lint` / `npm run typecheck` | Quality gates |
| `npm run test` | Vitest (unit + integration) |
| `npm run test:e2e` | Playwright smoke |
| `npm run validate:env` | Env validation for CI/Docker |

## Docker

```bash
docker compose build --build-arg VITE_SUPABASE_URL=... --build-arg VITE_SUPABASE_ANON_KEY=...
docker compose up -d
```

Images serve static assets with `nginx.conf` (rate limits and security headers). Keep CSP in deployment headers (`nginx.conf` or `vercel.json`), not in `index.html`.

## Deployment docs

See `docs/DEPLOYMENT.md` for Vercel, Supabase, Railway/Fly.io, rollback, and branch protection.

## CI/CD

GitHub Actions workflows:

- `.github/workflows/ci.yml` — lint, typecheck, tests, build, Playwright
- `.github/workflows/security.yml` — `npm audit`
- `.github/workflows/deploy.yml` — manual workflow with strict env + artifact upload

Protect `main`: require these checks to pass before merge.
