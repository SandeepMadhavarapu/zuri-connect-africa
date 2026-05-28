# Security Headers — Canonical Reference

> **SYNC REQUIREMENT**: `nginx.conf` and `vercel.json` must always ship identical
> security header values. This file is the single source of truth.
> See AUDIT.md §23.2 N8 (resolved Prompt 2.6).

When you change a header in one file, change it in the other immediately.
The table below is the canonical set. Both files have been verified to match
as of 2025-11-06.

## Canonical header values

| Header | Value | Notes |
|--------|-------|-------|
| `Content-Security-Policy` | `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https:; font-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-src 'self' https://*.supabase.co; worker-src 'self' blob:; upgrade-insecure-requests` | `frame-src` is required for Supabase iframe embeds; `unsafe-inline` for style only |
| `X-Frame-Options` | `DENY` | Redundant with `frame-ancestors 'none'` but kept for legacy browsers |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-sniffing attacks |
| `Referrer-Policy` | `no-referrer` | Strictest option; auth flows use URL params not Referer |
| `Permissions-Policy` | `accelerometer=(), camera=(), microphone=(self), geolocation=(self), payment=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)` | See policy notes below |
| `Cross-Origin-Opener-Policy` | `same-origin` | Required for WebAuthn popup isolation |
| `Cross-Origin-Resource-Policy` | `same-origin` | Blocks cross-origin resource reads |

### Permissions-Policy notes

| Feature | Value | Reason |
|---------|-------|--------|
| `accelerometer` | `()` | Not used; blocked |
| `camera` | `()` | Not used; blocked |
| `microphone` | `(self)` | Voice features in `src/lib/voice/*` require mic access from same origin |
| `geolocation` | `(self)` | Location-aware features; same-origin only |
| `payment` | `(self)` | Payment Request API for M-PESA flows; same-origin only |
| `publickey-credentials-get` | `(self)` | WebAuthn sign-in (verify-biometric Edge Function) |
| `publickey-credentials-create` | `(self)` | WebAuthn registration |

### HSTS (Strict-Transport-Security)

Not set in either config file. HSTS belongs at the TLS-termination layer
(load balancer / CDN), not in the application config. Vercel enforces HTTPS
automatically; self-hosted deployments should set HSTS at the ingress/LB level.

## Sync checklist

When editing either `nginx.conf` or `vercel.json`:

1. Identify the header you're changing.
2. Open the other file.
3. Apply the same logical value (syntax differs between nginx and JSON — compare values, not syntax).
4. Update the table above.
5. Run `npm run lint && npm run build && npm run test:ci && npm run prepitch`.
