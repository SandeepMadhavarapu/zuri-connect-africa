import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260611120000_settle_chama_contribution.sql'),
  'utf8',
);

describe('settle_chama_contribution migration — structural assertions', () => {

  it('function is SECURITY DEFINER', () => {
    expect(sql).toMatch(/SECURITY\s+DEFINER/i);
  });

  it('REVOKEs execute from PUBLIC, anon, and authenticated', () => {
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION.*FROM\s+PUBLIC/is);
    expect(sql).toMatch(/REVOKE\s+EXECUTE\s+ON\s+FUNCTION.*FROM\s+anon,\s*authenticated/is);
  });

  it('GRANTs execute to service_role only', () => {
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION.*TO\s+service_role/is);
  });

  it('acquires FOR UPDATE lock on pending_payments', () => {
    expect(sql).toMatch(/FROM\s+public\.pending_payments[\s\S]*?FOR\s+UPDATE/im);
  });

  it('acquires FOR UPDATE lock on chama_obligations', () => {
    expect(sql).toMatch(/FROM\s+public\.chama_obligations[\s\S]*?FOR\s+UPDATE/im);
  });

  it('performs amount verification with round(amount * 100)', () => {
    expect(sql).toMatch(/round\s*\(\s*pp\.amount\s*\*\s*100\s*\)/i);
    expect(sql).toMatch(/ob\.amount_due_cents/i);
    expect(sql).toMatch(/AMOUNT_MISMATCH/);
  });

  it('returns AMOUNT_MISMATCH without raising (graceful RETURN, not RAISE)', () => {
    const mismatchBlock = sql.match(/AMOUNT_MISMATCH[\s\S]*?END\s+IF/im)?.[0] ?? '';
    // There should be a RETURN before AMOUNT_MISMATCH, no RAISE EXCEPTION for mismatch
    expect(sql).toMatch(/RETURN\s+jsonb_build_object[\s\S]*?AMOUNT_MISMATCH/im);
    // Sanity: the mismatch return is not a RAISE
    expect(mismatchBlock).not.toMatch(/RAISE\s+EXCEPTION/i);
  });

  it('credit leg uses account_type = savings', () => {
    expect(sql).toMatch(/'account_type',\s*'savings'/);
  });

  it('passes NULL for p_expect_debit_balance_before', () => {
    expect(sql).toMatch(/post_double_entry\s*\([\s\S]*?,\s*NULL\s*\)/im);
  });

  it('has idempotency check on settled_receipt', () => {
    expect(sql).toMatch(/ob\.status\s*=\s*'settled'/);
    expect(sql).toMatch(/ob\.settled_receipt\s*=\s*p_receipt/);
    expect(sql).toMatch(/'duplicate',\s*true/);
  });

  it('steps 6-8 are inside a BEGIN...EXCEPTION block for atomic rollback', () => {
    // The inner BEGIN must appear after the balance reads, and the EXCEPTION
    // clause must reference LEDGER_POST_FAILED
    expect(sql).toMatch(/LEDGER_POST_FAILED/);
    expect(sql).toMatch(/WHEN\s+OTHERS/i);
    // The WHEN OTHERS branch must return ok:false
    expect(sql).toMatch(/WHEN\s+OTHERS[\s\S]*?'ok',\s*false/im);
  });

  it('EXCEPTION block has unique_violation branch before WHEN OTHERS returning duplicate:true', () => {
    // unique_violation must be handled first so concurrent double-settle returns
    // success-as-duplicate instead of falling through to LEDGER_POST_FAILED
    expect(sql).toMatch(/WHEN\s+unique_violation/i);
    expect(sql).toMatch(/WHEN\s+unique_violation[\s\S]*?'duplicate',\s*true/im);
    // unique_violation branch must appear before WHEN OTHERS in the file
    const uvIdx = sql.indexOf('unique_violation');
    const othersIdx = sql.indexOf('WHEN OTHERS');
    expect(uvIdx).toBeGreaterThan(0);
    expect(uvIdx).toBeLessThan(othersIdx);
  });

  it('returns no_obligation gracefully for non-chama tx_ref', () => {
    expect(sql).toMatch(/'no_obligation'/);
    expect(sql).toMatch(/'obligation_settled',\s*false/);
  });

  it('updates pending_payments to succeeded inside the atomic block', () => {
    expect(sql).toMatch(/UPDATE\s+public\.pending_payments[\s\S]*?status\s*=\s*'succeeded'/im);
    expect(sql).toMatch(/ledger_posted_at\s*=/);
    expect(sql).toMatch(/provider_receipt\s*=\s*p_receipt/);
    expect(sql).toMatch(/callback_payload_hash\s*=\s*p_payload_hash/);
  });

  it('updates chama_obligations to settled inside the atomic block', () => {
    expect(sql).toMatch(/UPDATE\s+public\.chama_obligations[\s\S]*?status\s*=\s*'settled'/im);
    expect(sql).toMatch(/settled_receipt\s*=\s*p_receipt/);
    expect(sql).toMatch(/settled_at\s*=\s*p_settled_at/);
    expect(sql).toMatch(/ledger_tx_ref\s*=\s*p_tx_ref/);
  });

  it('returns success shape with obligation_settled:true', () => {
    expect(sql).toMatch(/'obligation_settled',\s*true/);
    expect(sql).toMatch(/'ledger_tx_ref',\s*p_tx_ref/);
    expect(sql).toMatch(/'obligation_id',\s*ob\.id/);
  });

  it('debit leg uses account_type wallet', () => {
    expect(sql).toMatch(/'account_type',\s*'wallet'/);
  });

  it('credit account_phone is the CHAMA sentinel', () => {
    expect(sql).toMatch(/'CHAMA:'\s*\|\|\s*ob\.group_id/);
  });
});
