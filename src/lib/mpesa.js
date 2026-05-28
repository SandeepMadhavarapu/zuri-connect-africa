// Simulated M-Pesa integration layer
// Manages transaction history, wallet metadata, phone, pin, linked status ONLY.
// Balances are NEVER stored here — derive them from lib/ledger.js deriveBalance()

const STORAGE_KEY = 'mpesa_wallet';

const DEFAULT_STATE = {
  linked: false,
  phone: '',
  pin: '',
  transactions: [],
};

function load() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { ...DEFAULT_STATE };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

// sessionStorage: clears on tab close for security. Production would use server-side balance derivation.
function save(state) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event('mpesa_updated'));
}

export function getWallet() { return load(); }

export function isLinked() { return load().linked; }

export function linkWallet(phone) {
  const state = load();
  state.linked = true;
  state.phone = phone;
  // pin intentionally not stored
  save(state);
}

export function unlinkWallet() {
  save({ ...DEFAULT_STATE, linked: false });
}

export function getTransactions(limit = 50) {
  return load().transactions.slice(0, limit);
}

/**
 * Append transfer history only. Does NOT mutate balances.
 * Call only after server-confirmed pending_payments status from initiateAndWaitForPayment().
 */
export function recordLedgerTransfer({ ref, toName, toPhone, amount, fee, note }) {
  const state = load();
  state.transactions.unshift({
    id: ref,
    type: 'send',
    name: toName,
    phone: toPhone,
    amount: -amount,
    fee,
    date: new Date().toISOString(),
    status: 'completed',
    note: note || '',
  });
  save(state);
  return { success: true, ref };
}

/**
 * Append debit transaction history only. Does NOT mutate balances.
 * Call only after server-confirmed pending_payments status from initiateAndWaitForPayment().
 */
export function recordLedgerDebit({ ref, name, phone, amount, fee, note, type }) {
  const state = load();
  state.transactions.unshift({
    id: ref,
    type: type || 'send',
    name,
    phone: phone || '',
    amount: -amount,
    fee: fee || 0,
    date: new Date().toISOString(),
    status: 'completed',
    note: note || '',
  });
  save(state);
  return { success: true, ref };
}

/**
 * Append credit transaction history only. Does NOT mutate balances.
 * Call only after server-confirmed pending_payments status from initiateAndWaitForPayment().
 */
export function recordLedgerCredit({ ref, fromName, fromPhone, amount, note, type }) {
  const state = load();
  state.transactions.unshift({
    id: ref,
    type: type || 'receive',
    name: fromName || '',
    phone: fromPhone || '',
    amount: amount,
    fee: 0,
    date: new Date().toISOString(),
    status: 'completed',
    note: note || '',
  });
  save(state);
  return { success: true, ref };
}

export function receiveSimulated(fromName, amount) {
  const randBytes = new Uint8Array(4);
  crypto.getRandomValues(randBytes);
  const ref = 'PLK' + Array.from(randBytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, 7);
  return recordLedgerCredit({ ref, fromName, fromPhone: '', amount, note: '', type: 'receive' });
}

export function formatDate(iso) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  if (diff < 172800) return 'Yesterday, ' + d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}
