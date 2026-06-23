/**
 * create-contribution-cycle Edge Function + create_contribution_cycle RPC —
 * structural assertions.
 *
 * The Edge Function runs under Deno and the RPC is SQL; neither can be imported
 * in Vitest/Node. These tests read the source as text and assert that auth is
 * required, the caller is authorized (active chair/treasurer), input validation
 * is wired, KES→cents conversion happens at the edge, the RPC is called with the
 * authenticated user, the one-open-cycle invariant and atomic obligation
 * generation are present, and the grant/atomicity model is correct. Pattern
 * mirrors tests/unit/create-chama-group.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FN_PATH = resolve(
  process.cwd(),
  'supabase/functions/create-contribution-cycle/index.ts',
);
const SQL_PATH = resolve(
  process.cwd(),
  'supabase/migrations/20260619130000_create_contribution_cycle.sql',
);
const src = readFileSync(FN_PATH, 'utf8');
const sql = readFileSync(SQL_PATH, 'utf8');
// Executable SQL only — strip `--` line comments. The migration documents the
// auth.uid()-vs-passed-param decision in comments, so the "no auth.uid()" check
// must run against code, not prose.
const sqlCode = sql.replace(/--[^\n]*/g, '');

// ── CORS and method guard ──────────────────────────────────────────────────

describe('create-contribution-cycle: CORS and method guard', () => {
  it('returns null response for OPTIONS preflight with corsHeaders', () => {
    expect(src).toMatch(/req\.method.*OPTIONS.*corsHeaders|OPTIONS.*new Response.*null.*corsHeaders/s);
  });

  it('rejects non-POST with 405 METHOD_NOT_ALLOWED', () => {
    expect(src).toContain('METHOD_NOT_ALLOWED');
    expect(src).toContain('405');
  });

  it('CORS origin is set from APP_ORIGIN env var, never a wildcard *', () => {
    expect(src).toContain('APP_ORIGIN');
    expect(src).not.toMatch(/['"]Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/);
  });
});

// ── JWT authentication ──────────────────────────────────────────────────────

describe('create-contribution-cycle: JWT authentication', () => {
  it('extracts JWT from Authorization: Bearer header', () => {
    expect(src).toContain('Authorization');
    expect(src).toMatch(/Bearer/i);
  });

  it('calls supabaseAdmin.auth.getUser(jwt)', () => {
    expect(src).toContain('auth.getUser(jwt)');
  });

  it('returns 401 MISSING_AUTHORIZATION when no JWT is present', () => {
    expect(src).toContain('MISSING_AUTHORIZATION');
    expect(src).toMatch(/MISSING_AUTHORIZATION.*401|401.*MISSING_AUTHORIZATION/s);
  });

  it('returns 401 INVALID_TOKEN when JWT is invalid', () => {
    expect(src).toContain('INVALID_TOKEN');
    expect(src).toMatch(/INVALID_TOKEN.*401|401.*INVALID_TOKEN/s);
  });

  it('uses SUPABASE_SERVICE_ROLE_KEY (service_role client), not anon key', () => {
    expect(src).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(src).not.toContain('SUPABASE_ANON_KEY');
  });

  it('derives created_by from the verified token, never from the body', () => {
    expect(src).toMatch(/authUserId\s*=\s*userRes\.user\.id/);
    expect(src).not.toMatch(/p_user_id:\s*body\./);
    expect(src).not.toMatch(/created_by:\s*body\./);
  });
});

// ── Authorization ───────────────────────────────────────────────────────────

describe('create-contribution-cycle: authorization', () => {
  it('queries chama_members scoped to group + authenticated user + active status', () => {
    const idx = src.indexOf("from('chama_members')");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/\.eq\(\s*['"]group_id['"]\s*,\s*groupId\s*\)/);
    expect(block).toMatch(/\.eq\(\s*['"]user_id['"]\s*,\s*authUserId\s*\)/);
    expect(block).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]active['"]\s*\)/);
  });

  it('only chair or treasurer may open a cycle', () => {
    expect(src).toMatch(/AUTHORIZED_ROLES\s*=\s*new Set\(\[\s*['"]chair['"]\s*,\s*['"]treasurer['"]\s*\]\)/);
  });

  it('rejects a non-chair/treasurer with 403 NOT_AUTHORIZED', () => {
    expect(src).toContain('NOT_AUTHORIZED');
    expect(src).toMatch(/NOT_AUTHORIZED.*403|403.*NOT_AUTHORIZED/s);
  });
});

// ── Input validation ────────────────────────────────────────────────────────

describe('create-contribution-cycle: input validation', () => {
  it('returns 400 GROUP_ID_REQUIRED when group_id is missing', () => {
    expect(src).toContain('GROUP_ID_REQUIRED');
    expect(src).toMatch(/GROUP_ID_REQUIRED.*400|400.*GROUP_ID_REQUIRED/s);
  });

  it('name is trimmed and bounded 3..80, else 400 NAME_INVALID', () => {
    expect(src).toMatch(/NAME_MIN\s*=\s*3/);
    expect(src).toMatch(/NAME_MAX\s*=\s*80/);
    expect(src).toContain('NAME_INVALID');
    expect(src).toMatch(/NAME_INVALID.*400|400.*NAME_INVALID/s);
    expect(src).toMatch(/body\.name.*\.trim\(\)/);
  });

  it('returns 400 AMOUNT_INVALID for non-positive / absurd amounts', () => {
    expect(src).toContain('AMOUNT_INVALID');
    expect(src).toMatch(/AMOUNT_INVALID.*400|400.*AMOUNT_INVALID/s);
    expect(src).toMatch(/MAX_AMOUNT_CENTS\s*=\s*100_?000_?000/);
  });

  it('converts amount_kes to integer cents at the edge (Math.round * 100)', () => {
    expect(src).toMatch(/Math\.round\(\s*kes\s*\*\s*100\s*\)/);
  });

  it('due_date must be a valid future date, else 400 DUE_DATE_INVALID', () => {
    expect(src).toContain('DUE_DATE_INVALID');
    expect(src).toMatch(/DUE_DATE_INVALID.*400|400.*DUE_DATE_INVALID/s);
    expect(src).toMatch(/dueMs\s*<=\s*Date\.now\(\)|Date\.now\(\).*dueMs/s);
  });

  it('grace_days is optional, defaults 3, and bounded 0..30', () => {
    expect(src).toMatch(/DEFAULT_GRACE_DAYS\s*=\s*3/);
    expect(src).toMatch(/MAX_GRACE_DAYS\s*=\s*30/);
    expect(src).toContain('GRACE_DAYS_INVALID');
    expect(src).toMatch(/GRACE_DAYS_INVALID.*400|400.*GRACE_DAYS_INVALID/s);
  });

  it('returns 400 INVALID_JSON when the body is not valid JSON', () => {
    expect(src).toContain('INVALID_JSON');
    expect(src).toMatch(/INVALID_JSON.*400|400.*INVALID_JSON/s);
  });
});

// ── RPC invocation ──────────────────────────────────────────────────────────

describe('create-contribution-cycle: atomic RPC invocation', () => {
  it('calls the create_contribution_cycle RPC (not raw multi-insert)', () => {
    expect(src).toMatch(/\.rpc\(\s*['"]create_contribution_cycle['"]/);
    expect(src).not.toMatch(/\.from\(\s*['"]chama_obligations['"]\s*\)\.insert/);
  });

  it('passes the authenticated user id as p_user_id', () => {
    expect(src).toMatch(/p_user_id:\s*authUserId/);
  });

  it('passes validated name, amount_cents, due_at, and grace_days to the RPC', () => {
    expect(src).toMatch(/p_group_id:\s*groupId/);
    expect(src).toMatch(/p_name:\s*name/);
    expect(src).toMatch(/p_amount_cents:\s*amountCents/);
    expect(src).toMatch(/p_due_at:\s*dueAtIso/);
    expect(src).toMatch(/p_grace_days:\s*graceDays/);
  });
});

// ── RPC error-string → HTTP-status mapping ──────────────────────────────────

describe('create-contribution-cycle: RPC error mapping', () => {
  it('maps OPEN_CYCLE_EXISTS to 409', () => {
    expect(src).toMatch(/OPEN_CYCLE_EXISTS:\s*409/);
  });

  it('maps CYCLE_NAME_EXISTS to 409', () => {
    expect(src).toMatch(/CYCLE_NAME_EXISTS:\s*409/);
  });

  it('maps NO_ACTIVE_MEMBERS to 422', () => {
    expect(src).toMatch(/NO_ACTIVE_MEMBERS:\s*422/);
  });

  it('maps GROUP_NOT_FOUND to 404', () => {
    expect(src).toMatch(/GROUP_NOT_FOUND:\s*404/);
  });

  it('maps GROUP_NOT_ACTIVE to 409', () => {
    expect(src).toMatch(/GROUP_NOT_ACTIVE:\s*409/);
  });

  it('maps AMOUNT_INVALID to 400', () => {
    expect(src).toMatch(/AMOUNT_INVALID:\s*400/);
  });

  it('falls back to 500 CYCLE_CREATE_FAILED for unmapped RPC errors', () => {
    expect(src).toContain('CYCLE_CREATE_FAILED');
    expect(src).toMatch(/CYCLE_CREATE_FAILED.*500|500.*CYCLE_CREATE_FAILED/s);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe('create-contribution-cycle: rate limiting', () => {
  it('uses the atomic check_rate_limit RPC with a 1-hour (3600s) window', () => {
    expect(src).toMatch(/checkRateLimit\([^)]*\b3600\b[^)]*\)/);
  });

  it('enforces a limit of 10 cycles per user per hour', () => {
    expect(src).toMatch(/checkRateLimit\([^)]*,\s*10\s*,\s*3600\b/);
  });

  it('returns 429 RATE_LIMITED at or above the limit', () => {
    expect(src).toContain('RATE_LIMITED');
    expect(src).toMatch(/RATE_LIMITED.*429|429.*RATE_LIMITED/s);
  });

  it('rate-limit uses a per-user bucket keyed on authUserId with a distinct endpoint', () => {
    expect(src).toMatch(
      /checkRateLimit\(\s*supabaseAdmin\s*,\s*authUserId\s*,\s*['"]user['"]\s*,\s*['"]chama_cycle_create['"]/,
    );
  });
});

// ── Success response ────────────────────────────────────────────────────────

describe('create-contribution-cycle: success response', () => {
  it('returns ok:true with the created cycle fields and obligation_count', () => {
    expect(src).toMatch(/ok:\s*true/);
    expect(src).toMatch(/obligation_count:/);
    const idx = src.indexOf('cycle: {');
    const block = src.slice(idx, idx + 400);
    expect(block).toContain('id:');
    expect(block).toContain('group_id:');
    expect(block).toContain('name:');
    expect(block).toContain('amount_cents:');
    expect(block).toContain('currency:');
    expect(block).toContain('due_at:');
    expect(block).toContain('status:');
  });
});

// ── Shared helper imports / boundary ─────────────────────────────────────────

describe('create-contribution-cycle: shared imports and boundaries', () => {
  it('imports requireFunctionEnv and serviceNotConfiguredResponse from _shared/function-env.ts', () => {
    expect(src).toContain('requireFunctionEnv');
    expect(src).toContain('serviceNotConfiguredResponse');
    expect(src).toContain("from '../_shared/function-env.ts'");
  });

  it('does NOT import from other Edge Function directories', () => {
    expect(src).not.toMatch(/from\s+['"].*(chama-contribute|create-chama-group|initiate-payment|webhook-handler|reconciliation-job)['"]/);
  });

  it('money/treasury logic lives in supabase/functions, not src/', () => {
    const normalizedPath = FN_PATH.replace(/\\/g, '/');
    expect(normalizedPath).toContain('supabase/functions/create-contribution-cycle');
    expect(normalizedPath).not.toMatch(/\/src\//);
  });
});

// ── RPC migration — structural assertions ────────────────────────────────────

describe('create_contribution_cycle migration — structural assertions', () => {
  it('function is SECURITY DEFINER with fixed search_path', () => {
    expect(sql).toMatch(/SECURITY\s+DEFINER/i);
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public/i);
  });

  it('takes the caller id as a parameter (p_user_id) — does not rely on auth.uid()', () => {
    expect(sql).toMatch(/p_user_id\s+UUID/i);
    expect(sqlCode).not.toMatch(/auth\.uid\(\)/);
  });

  it('guards against NULL user id and group id', () => {
    expect(sql).toMatch(/p_user_id\s+IS\s+NULL/i);
    expect(sql).toMatch(/p_group_id\s+IS\s+NULL/i);
    expect(sql).toMatch(/USER_ID_REQUIRED/);
    expect(sql).toMatch(/GROUP_ID_REQUIRED/);
  });

  it('validates the group exists and is active', () => {
    expect(sql).toMatch(/GROUP_NOT_FOUND/);
    expect(sql).toMatch(/GROUP_NOT_ACTIVE/);
    expect(sqlCode).toMatch(/status\s*<>\s*'active'/);
  });

  it('enforces ONE OPEN CYCLE MAX in-RPC via an EXISTS guard (OPEN_CYCLE_EXISTS)', () => {
    expect(sql).toMatch(/OPEN_CYCLE_EXISTS/);
    const idx = sqlCode.indexOf('OPEN_CYCLE_EXISTS');
    const block = sqlCode.slice(Math.max(0, idx - 400), idx + 40);
    expect(block).toMatch(/EXISTS\s*\(/i);
    expect(block).toMatch(/chama_contribution_cycles/);
    expect(block).toMatch(/status\s*=\s*'open'/);
  });

  it('checks amount > 0 with a clean AMOUNT_INVALID error', () => {
    expect(sql).toMatch(/AMOUNT_INVALID/);
    expect(sqlCode).toMatch(/p_amount_cents\s*<=\s*0/);
  });

  it('maps the UNIQUE(group_id, name) collision to CYCLE_NAME_EXISTS', () => {
    expect(sql).toMatch(/CYCLE_NAME_EXISTS/);
    expect(sqlCode).toMatch(/WHEN\s+unique_violation\s+THEN[\s\S]*?CYCLE_NAME_EXISTS/i);
  });

  it('inserts the cycle with status open and created_by = p_user_id', () => {
    expect(sql).toMatch(/INSERT\s+INTO\s+public\.chama_contribution_cycles/i);
    expect(sqlCode).toMatch(/'open'/);
    const idx = sql.indexOf('INSERT INTO public.chama_contribution_cycles');
    const block = sql.slice(idx, idx + 400);
    expect(block).toMatch(/p_user_id/);
  });

  it('generates obligations via a single INSERT...SELECT over active members', () => {
    expect(sql).toMatch(/INSERT\s+INTO\s+public\.chama_obligations/i);
    const idx = sql.indexOf('INSERT INTO public.chama_obligations');
    const block = sql.slice(idx, idx + 400);
    expect(block).toMatch(/SELECT/i);
    expect(block).toMatch(/chama_members/);
    expect(block).toMatch(/m\.status\s*=\s*'active'/);
    expect(block).toMatch(/'due'/);
  });

  it('counts inserted obligations and rejects zero active members', () => {
    expect(sql).toMatch(/GET\s+DIAGNOSTICS\s+v_oblig_count\s*=\s*ROW_COUNT/i);
    expect(sql).toMatch(/NO_ACTIVE_MEMBERS/);
    expect(sqlCode).toMatch(/v_oblig_count\s*=\s*0/);
  });

  it('cycle insert and obligation generation are one function body (atomic, no standalone COMMIT)', () => {
    const cycleIdx = sql.indexOf('INSERT INTO public.chama_contribution_cycles');
    const obligIdx = sql.indexOf('INSERT INTO public.chama_obligations');
    expect(cycleIdx).toBeGreaterThan(0);
    expect(obligIdx).toBeGreaterThan(cycleIdx);
    expect(sqlCode).not.toMatch(/\bCOMMIT\b/i);
  });

  it('returns the new cycle as JSONB with obligation_count', () => {
    expect(sql).toMatch(/RETURNS\s+JSONB/i);
    const idx = sql.indexOf('jsonb_build_object');
    const block = sql.slice(idx, idx + 600);
    expect(block).toContain("'id'");
    expect(block).toContain("'group_id'");
    expect(block).toContain("'name'");
    expect(block).toContain("'amount_cents'");
    expect(block).toContain("'status'");
    expect(block).toContain("'obligation_count'");
  });

  it('REVOKEs execute from PUBLIC, anon, and authenticated', () => {
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION.*FROM\s+PUBLIC/is);
    expect(sql).toMatch(/REVOKE\s+EXECUTE\s+ON\s+FUNCTION.*FROM\s+anon,\s*authenticated/is);
  });

  it('GRANTs execute to service_role only (not authenticated)', () => {
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION.*TO\s+service_role/is);
    expect(sql).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION.*TO[^;]*authenticated/is);
  });
});
