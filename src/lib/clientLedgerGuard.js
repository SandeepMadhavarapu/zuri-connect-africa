export const CLIENT_LEDGER_FORBIDDEN_MESSAGE =
  'CLIENT_LEDGER_FORBIDDEN: Browser ledger writes are disabled. Use initiate-payment and wait for server-confirmed pending_payments status.';

export function isClientDemoLedgerAllowed() {
  return (
    import.meta.env.VITE_APP_ENV === 'local' &&
    import.meta.env.VITE_ALLOW_CLIENT_DEMO_CONTROLS === 'true' &&
    import.meta.env.VITE_STRICT_ENV !== 'true'
  );
}

export function assertClientLedgerPostingAllowed() {
  if (!isClientDemoLedgerAllowed()) {
    throw new Error(CLIENT_LEDGER_FORBIDDEN_MESSAGE);
  }
}

export function clientLedgerForbiddenResult() {
  return {
    ok: false,
    skipped: true,
    forbidden: true,
    error: 'CLIENT_LEDGER_FORBIDDEN',
    message: CLIENT_LEDGER_FORBIDDEN_MESSAGE,
  };
}
