# Integration tests

These tests run against **live infrastructure** (a deployed Supabase project and
its Edge Functions) over real HTTP. They are deliberately **excluded** from the
default `npm run test:ci` / `npm run prepitch` chain because they:

- require network access and live credentials, and
- can be slow or rate-limited.

They self-skip when the required environment variables are not provided, so a
bare `npm run test:integration` on an unconfigured machine passes (suites
skipped, env-contract checks green) rather than failing.

## How to run

```bash
npm run test:integration
```

This uses `vitest.integration.config.js`, which picks up only
`tests/integration/**/*.integration.test.js`.

> Note: the default test runner also matches files in this directory that end in
> `.test.js` (e.g. `supabase-staging.test.js`), so those still run under
> `test:ci` and self-skip when unconfigured. Only the `*.integration.test.js`
> suffix is reserved for the live-infra runner.

## Required environment variables

Set these in your shell or a local `.env` before running. Never commit real
keys.

### `admin-soc-readonly.integration.test.js`

| Variable | Required? | Purpose |
|---|---|---|
| `SUPABASE_URL` (or `VITE_SUPABASE_URL`) | yes | Project URL, `https://…` |
| `SUPABASE_ANON_KEY` (or `VITE_SUPABASE_ANON_KEY`) | yes | Public anon key |
| `SOC_TEST_ADMIN_JWT` | optional | JWT for `app_metadata.role=admin` |
| `SOC_TEST_AUDITOR_JWT` | optional | JWT for `…role=auditor` |
| `SOC_TEST_FRAUD_ANALYST_JWT` | optional | JWT for `…role=fraud_analyst` |
| `SOC_TEST_OPERATOR_JWT` | optional | JWT for `…role=operator` |
| `SOC_TEST_NONADMIN_JWT` | optional | JWT for a user with no admin role |
| `SOC_TEST_RATE_LIMIT` | optional | `1` to opt in to the heavy 61-request rate-limit test |

Each role-specific test skips when its JWT is absent. Test users with these
roles must already exist in the target project — they will be seeded in Phase 6
or via a one-time setup script.
