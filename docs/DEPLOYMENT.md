# Deployment guide — Zuri Connect Africa

This SPA is a static Vite build. Runtime configuration is embedded at **build time** via `VITE_*` variables.

## Environments

| Environment | `VITE_APP_ENV` | Notes |
|-------------|----------------|-------|
| Local | `local` | Optional secrets; relaxed validation |
| Development | `development` | Shared dev project |
| Staging | `staging` | Strict secrets, mirrors prod |
| Production | `production` | Strict secrets, observability on |

## Vercel (frontend)

1. Connect the GitHub repository.
2. Framework preset: **Vite**.
3. Build command: `npm run build`
4. Output directory: `dist`
5. Add environment variables in the Vercel dashboard (Production / Preview):
   - `VITE_APP_ENV`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - Optional: `VITE_API_BASE_URL`, `VITE_STRICT_ENV=true` for preview branches that must behave like prod.

Redeploy after changing env vars. Rollback: use Vercel **Deployments → Promote** a previous deployment.

## Supabase

1. Create separate projects (or schemas) for staging and production.
2. Apply migrations from `supabase/migrations` (see repo root Supabase docs if present).
3. Configure Auth redirect URLs for each deployed domain (`https://app.example.com`, etc.).
4. Edge Functions: deploy from `supabase/functions` with secrets (`WEBHOOK_HMAC_SECRET`, payment keys) via Supabase CLI or dashboard — never embed service keys in the SPA.

## Docker / nginx / Railway / Fly.io

Build with real `VITE_*` args so the bundle talks to the correct Supabase project:

```bash
docker build \
  --build-arg VITE_APP_ENV=production \
  --build-arg VITE_STRICT_ENV=true \
  --build-arg VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
  --build-arg VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY \
  -t zuri-connect-africa:prod .
```

Railway/Fly: use the same Dockerfile or a static site buildpack; set env vars in the platform UI and run `npm run build`, then serve `dist` with the provided `nginx.conf` or platform CDN.

### Rollback (container)

Keep immutable image tags (`:20250509-1430`). Roll back by redeploying the previous digest.

## Branch protection (GitHub)

Recommended rules for `main`:

- Require pull request reviews (1+).
- Require status checks: **CI / pipeline**, **Security / npm-audit**.
- Require branches to be up to date before merging.
- Include administrators (optional).

## Secrets

- Never commit `.env` files with real keys.
- Use GitHub Actions **Secrets** for deploy workflows.
- Enable **Secret scanning** and **Dependabot alerts** in repository settings.

## Health

Container includes an nginx `GET /` health expectation. Extend with synthetic checks against `/auth` or a lightweight JSON probe if you add API routes on the edge.
