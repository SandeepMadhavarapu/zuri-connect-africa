/**
 * create-chama-group Edge Function + create_chama_group RPC — structural assertions
 *
 * The Edge Function runs under Deno and the RPC is SQL; neither can be imported
 * in Vitest/Node. These tests read the source as text and assert that auth is
 * required, input validation is wired, defaults are applied, the RPC is called
 * with the authenticated user, the creator is added as chair/active, and the
 * grant/atomicity model is correct. Pattern mirrors
 * tests/unit/chama-contribute.test.js and tests/unit/settle-chama-contribution.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FN_PATH = resolve(
  process.cwd(),
  'supabase/functions/create-chama-group/index.ts',
);
const SQL_PATH = resolve(
  process.cwd(),
  'supabase/migrations/20260619120000_create_chama_group.sql',
);
const src = readFileSync(FN_PATH, 'utf8');
const sql = readFileSync(SQL_PATH, 'utf8');
// Executable SQL only — strip `--` line comments. The migration documents the
// auth.uid()-vs-passed-param decision in comments, so the "no auth.uid()" check
// must run against code, not prose.
const sqlCode = sql.replace(/--[^\n]*/g, '');

// ── CORS and method guard ──────────────────────────────────────────────────

describe('create-chama-group: CORS and method guard', () => {
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

describe('create-chama-group: JWT authentication', () => {
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

  it('derives created_by/first member from the verified token, never from the body', () => {
    // authUserId comes from getUser; it must be what is passed to the RPC.
    expect(src).toMatch(/authUserId\s*=\s*userRes\.user\.id/);
    expect(src).not.toMatch(/p_user_id:\s*body\./);
    expect(src).not.toMatch(/created_by:\s*body\./);
  });
});

// ── Input validation ────────────────────────────────────────────────────────

describe('create-chama-group: input validation', () => {
  it('name is trimmed before validation', () => {
    expect(src).toMatch(/String\(body\.name\s*\?\?\s*['"]['"]\)\.trim\(\)|body\.name.*\.trim\(\)/);
  });

  it('returns 400 NAME_REQUIRED when name is empty/whitespace', () => {
    expect(src).toContain('NAME_REQUIRED');
    expect(src).toMatch(/NAME_REQUIRED.*400|400.*NAME_REQUIRED/s);
  });

  it('enforces the 3..80 char bound mirroring the DB CHECK', () => {
    expect(src).toMatch(/NAME_MIN\s*=\s*3/);
    expect(src).toMatch(/NAME_MAX\s*=\s*80/);
    expect(src).toContain('NAME_INVALID');
    expect(src).toMatch(/name\.length\s*<\s*NAME_MIN.*name\.length\s*>\s*NAME_MAX/s);
  });

  it('returns 400 NAME_INVALID for too-short or too-long names', () => {
    expect(src).toMatch(/NAME_INVALID.*400|400.*NAME_INVALID/s);
  });

  it('description is optional, trimmed, and length-capped', () => {
    expect(src).toMatch(/DESC_MAX\s*=\s*500/);
    expect(src).toContain('DESCRIPTION_TOO_LONG');
    expect(src).toMatch(/desc\.length\s*>\s*DESC_MAX/);
  });

  it('empty/whitespace description becomes null (not stored as empty string)', () => {
    expect(src).toMatch(/description\s*=\s*desc\.length\s*>\s*0\s*\?\s*desc\s*:\s*null/);
  });

  it('currency defaults to KES', () => {
    expect(src).toMatch(/let\s+currency\s*=\s*['"]KES['"]/);
  });

  it('currency must be a short currency code (rejects arbitrary long strings)', () => {
    expect(src).toContain('CURRENCY_INVALID');
    expect(src).toMatch(/CURRENCY_MAX\s*=\s*8/);
    expect(src).toMatch(/\[A-Z\]\{3,8\}/);
  });

  it('returns 400 INVALID_JSON when the body is not valid JSON', () => {
    expect(src).toContain('INVALID_JSON');
    expect(src).toMatch(/INVALID_JSON.*400|400.*INVALID_JSON/s);
  });
});

// ── RPC invocation ──────────────────────────────────────────────────────────

describe('create-chama-group: atomic RPC invocation', () => {
  it('calls the create_chama_group RPC (not raw multi-insert)', () => {
    expect(src).toMatch(/\.rpc\(\s*['"]create_chama_group['"]/);
    // Must not attempt two separate non-atomic table inserts.
    expect(src).not.toMatch(/\.from\(\s*['"]chama_members['"]\s*\)\.insert/);
  });

  it('passes the authenticated user id as p_user_id', () => {
    expect(src).toMatch(/p_user_id:\s*authUserId/);
  });

  it('passes validated name, description, and currency to the RPC', () => {
    expect(src).toMatch(/p_name:\s*name/);
    expect(src).toMatch(/p_description:\s*description/);
    expect(src).toMatch(/p_currency:\s*currency/);
  });

  it('returns 500 GROUP_CREATE_FAILED when the RPC errors', () => {
    expect(src).toContain('GROUP_CREATE_FAILED');
    expect(src).toMatch(/GROUP_CREATE_FAILED.*500|500.*GROUP_CREATE_FAILED/s);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe('create-chama-group: rate limiting', () => {
  it('uses the atomic check_rate_limit RPC with a 1-hour (3600s) window', () => {
    expect(src).toMatch(/checkRateLimit\([^)]*\b3600\b[^)]*\)/);
  });

  it('enforces a limit of 5 groups per user per hour', () => {
    expect(src).toMatch(/checkRateLimit\([^)]*,\s*5\s*,\s*3600\b/);
  });

  it('returns 429 RATE_LIMITED at or above the limit', () => {
    expect(src).toContain('RATE_LIMITED');
    expect(src).toMatch(/RATE_LIMITED.*429|429.*RATE_LIMITED/s);
  });

  it('rate-limit uses a per-user bucket keyed on authUserId with a distinct endpoint', () => {
    expect(src).toMatch(
      /checkRateLimit\(\s*supabaseAdmin\s*,\s*authUserId\s*,\s*['"]user['"]\s*,\s*['"]chama_group_create['"]/,
    );
  });
});

// ── Success response ────────────────────────────────────────────────────────

describe('create-chama-group: success response', () => {
  it('returns ok:true with the created group fields', () => {
    expect(src).toMatch(/ok:\s*true/);
    const idx = src.indexOf('group: {');
    const block = src.slice(idx, idx + 300);
    expect(block).toContain('id:');
    expect(block).toContain('name:');
    expect(block).toContain('description:');
    expect(block).toContain('currency:');
    expect(block).toContain('status:');
    expect(block).toContain('created_at:');
  });
});

// ── Shared helper imports / boundary ─────────────────────────────────────────

describe('create-chama-group: shared imports and boundaries', () => {
  it('imports requireFunctionEnv and serviceNotConfiguredResponse from _shared/function-env.ts', () => {
    expect(src).toContain('requireFunctionEnv');
    expect(src).toContain('serviceNotConfiguredResponse');
    expect(src).toContain("from '../_shared/function-env.ts'");
  });

  it('does NOT import from other Edge Function directories', () => {
    expect(src).not.toMatch(/from\s+['"].*(chama-contribute|initiate-payment|webhook-handler|reconciliation-job)['"]/);
  });

  it('money/treasury logic lives in supabase/functions, not src/', () => {
    const normalizedPath = FN_PATH.replace(/\\/g, '/');
    expect(normalizedPath).toContain('supabase/functions/create-chama-group');
    expect(normalizedPath).not.toMatch(/\/src\//);
  });
});

// ── RPC migration — structural assertions ────────────────────────────────────

describe('create_chama_group migration — structural assertions', () => {
  it('function is SECURITY DEFINER with fixed search_path', () => {
    expect(sql).toMatch(/SECURITY\s+DEFINER/i);
    expect(sql).toMatch(/SET\s+search_path\s*=\s*public/i);
  });

  it('takes the caller id as a parameter (p_user_id) — does not rely on auth.uid()', () => {
    expect(sql).toMatch(/p_user_id\s+UUID/i);
    expect(sqlCode).not.toMatch(/auth\.uid\(\)/);
  });

  it('guards against a NULL user id', () => {
    expect(sql).toMatch(/p_user_id\s+IS\s+NULL/i);
    expect(sql).toMatch(/RAISE\s+EXCEPTION/i);
  });

  it('inserts the group with created_by = p_user_id', () => {
    expect(sql).toMatch(/INSERT\s+INTO\s+public\.chama_groups[\s\S]*?created_by/im);
    expect(sql).toMatch(/VALUES\s*\([\s\S]*?p_user_id/im);
  });

  it('inserts the creator as a member with role chair and status active', () => {
    expect(sql).toMatch(/INSERT\s+INTO\s+public\.chama_members/i);
    expect(sql).toMatch(/'chair'/);
    expect(sql).toMatch(/'active'/);
  });

  it('member insert references the new group id and the same user', () => {
    const idx = sql.indexOf('INSERT INTO public.chama_members');
    const block = sql.slice(idx, idx + 300);
    expect(block).toMatch(/gr\.id/);
    expect(block).toMatch(/p_user_id/);
  });

  it('both inserts are in one function body (implicit transaction = atomic)', () => {
    // Single BEGIN...END body containing both INSERT statements.
    const groupIdx = sql.indexOf('INSERT INTO public.chama_groups');
    const memberIdx = sql.indexOf('INSERT INTO public.chama_members');
    expect(groupIdx).toBeGreaterThan(0);
    expect(memberIdx).toBeGreaterThan(groupIdx);
  });

  it('currency falls back to KES when null/empty', () => {
    expect(sql).toMatch(/COALESCE\(\s*NULLIF\(p_currency,\s*''\),\s*'KES'\)/);
  });

  it('returns the new group as JSONB with the expected fields', () => {
    expect(sql).toMatch(/RETURNS\s+JSONB/i);
    const idx = sql.indexOf('jsonb_build_object');
    const block = sql.slice(idx, idx + 400);
    expect(block).toContain("'id'");
    expect(block).toContain("'name'");
    expect(block).toContain("'description'");
    expect(block).toContain("'currency'");
    expect(block).toContain("'status'");
    expect(block).toContain("'created_at'");
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
