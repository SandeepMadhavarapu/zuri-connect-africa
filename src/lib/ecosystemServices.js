/**
 * Zuri Connect Africa — Ecosystem Services Registry
 * Modular capability definitions for the super-app ecosystem.
 */

const FAVORITES_KEY = 'zuri_eco_favorites_v1';
const RECENT_KEY    = 'zuri_eco_recent_v1';

export const ECOSYSTEM_CATEGORIES = [
  'All',
  'Bills & Utilities',
  'School & SACCO',
  'Government Services',
  'Health Payments',
  'Transport Pilot',
  'Business & Merchant',
];

export const ECOSYSTEM_SERVICES = [
  // ── Bills & Utilities ─────────────────────────────────────────
  {
    id: 'kplc',
    title: 'KPLC Tokens',
    category: 'Bills & Utilities',
    icon: 'Zap',
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    description: 'KPLC token top-up · verified provider source required · meter number entered before payment · guided flow with wrong-number reporting.',
    status: 'payment_ready',
    aiEnabled: false,
  },
  {
    id: 'water',
    title: 'Water Bills',
    category: 'Bills & Utilities',
    icon: 'Droplets',
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    description: 'County water utility PayBill · verified provider source required · account number entered before payment · wrong-number reporting available.',
    status: 'payment_ready',
    aiEnabled: false,
  },
  {
    id: 'internet',
    title: 'Internet Bills',
    category: 'Bills & Utilities',
    icon: 'Wifi',
    color: 'text-violet-400',
    bg: 'bg-violet-400/10',
    description: 'Home internet PayBill directory · verified provider source required · subscriber number entered before payment · no unverified numbers shown as verified.',
    status: 'payment_ready',
    aiEnabled: false,
  },
  {
    id: 'dstv',
    title: 'DStv / GOtv',
    category: 'Bills & Utilities',
    icon: 'Tv',
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    description: 'DStv / GOtv PayBill · verified provider source required · smartcard number entered before payment · guided flow with wrong-number reporting.',
    status: 'payment_ready',
    aiEnabled: false,
  },

  // ── School & SACCO ────────────────────────────────────────────
  {
    id: 'school_fees',
    title: 'School Fees Directory',
    category: 'School & SACCO',
    icon: 'GraduationCap',
    color: 'text-primary',
    bg: 'bg-primary/10',
    description: 'School PayBill directory · verified provider source required · admission number entered before payment · guided flow with wrong-number reporting.',
    status: 'payment_ready',
    aiEnabled: false,
  },
  {
    id: 'sacco',
    title: 'SACCO Deposits',
    category: 'School & SACCO',
    icon: 'Landmark',
    color: 'text-primary',
    bg: 'bg-primary/10',
    description: 'SACCO / Chama PayBill directory · verified SACCO source required · member number entered before payment · wrong-number reporting available.',
    status: 'payment_ready',
    aiEnabled: false,
  },

  // ── Government Services ───────────────────────────────────────
  {
    id: 'nhif',
    title: 'NHIF / SHA',
    category: 'Government Services',
    icon: 'HeartPulse',
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    description: 'SHA/NHIF contribution flow prepared for official provider integration.',
    status: 'integration_ready',
    aiEnabled: false,
  },
  {
    id: 'ntsa',
    title: 'NTSA Payments',
    category: 'Government Services',
    icon: 'Car',
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    description: 'NTSA payment model prepared for official provider integration.',
    status: 'integration_ready',
    aiEnabled: false,
  },
  {
    id: 'kra',
    title: 'KRA iTax',
    category: 'Government Services',
    icon: 'FileText',
    color: 'text-primary',
    bg: 'bg-primary/10',
    description: 'KRA iTax workflow prepared for official provider integration.',
    status: 'integration_ready',
    aiEnabled: false,
  },
  {
    id: 'passport',
    title: 'Passport Tracker',
    category: 'Government Services',
    icon: 'BookMarked',
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    description: 'Passport status model prepared for official provider API integration.',
    status: 'integration_ready',
    aiEnabled: false,
  },

  // ── Health Payments ───────────────────────────────────────────
  {
    id: 'hospital',
    title: 'Hospital Bills',
    category: 'Health Payments',
    icon: 'Hospital',
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    description: 'Hospital PayBill directory · verified provider source required · patient / invoice reference entered before payment · wrong-number reporting available.',
    status: 'payment_ready',
    aiEnabled: false,
  },
  {
    id: 'bima',
    title: 'Bima Yangu',
    category: 'Health Payments',
    icon: 'ShieldCheck',
    color: 'text-primary',
    bg: 'bg-primary/10',
    description: 'Micro-insurance model prepared for regulated partner integration.',
    status: 'integration_ready',
    aiEnabled: false,
  },

  // ── Transport Pilot ───────────────────────────────────────────
  {
    id: 'matatu',
    title: 'Transit Pilot',
    category: 'Transport Pilot',
    icon: 'Bus',
    color: 'text-orange-400',
    bg: 'bg-orange-400/10',
    description: 'Matatu and PSV SACCO transit payment pilot — partner SACCO onboarding required.',
    status: 'pilot',
    aiEnabled: false,
  },
  {
    id: 'train',
    title: 'SGR Tickets',
    category: 'Transport Pilot',
    icon: 'Train',
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    description: 'SGR ticketing model prepared for official booking integration.',
    status: 'integration_ready',
    aiEnabled: false,
  },

  // ── Business & Merchant ───────────────────────────────────────
  {
    id: 'fuel',
    title: 'Merchant Till Directory',
    category: 'Business & Merchant',
    icon: 'Fuel',
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    description: 'Merchant Till directory · verified merchant source required · Till number confirmed at the counter before payment · no unverified numbers shown as verified · wrong-number reporting available.',
    status: 'directory',
    aiEnabled: false,
  },
  {
    id: 'sme_pay',
    title: 'SME Payments',
    category: 'Business & Merchant',
    icon: 'Building2',
    color: 'text-primary',
    bg: 'bg-primary/10',
    description: 'SME payment acceptance model prepared for merchant pilots.',
    status: 'pilot',
    aiEnabled: false,
  },
  {
    id: 'payroll',
    title: 'Payroll',
    category: 'Business & Merchant',
    icon: 'Users',
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    description: 'Payroll disbursement model prepared for official API integration.',
    status: 'integration_ready',
    aiEnabled: false,
  },
];

// ── AI Suggestions ────────────────────────────────────────────────────────────

export const AI_SERVICE_SUGGESTIONS = [
  {
    id: 'sug_school',
    text: 'Preview suggestion: pay School Fees via the verified PayBill directory — search your school and enter admission number.',
    serviceId: 'school_fees',
    icon: 'GraduationCap',
    color: 'text-primary',
    bg: 'bg-primary/10',
  },
  {
    id: 'sug_matatu',
    text: 'Preview suggestion from sample transport signals: explore Transit Pilot?',
    serviceId: 'matatu',
    icon: 'Bus',
    color: 'text-orange-400',
    bg: 'bg-orange-400/10',
  },
  {
    id: 'sug_nhif',
    text: 'Preview suggestion: SHA/NHIF flow needs official provider integration before payment.',
    serviceId: 'nhif',
    icon: 'HeartPulse',
    color: 'text-red-400',
    bg: 'bg-red-400/10',
  },
];

// ── Favorites persistence ─────────────────────────────────────────────────────

export function getFavorites() {
  try {
    const raw = sessionStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function toggleFavorite(serviceId) {
  const favs = getFavorites();
  const updated = favs.includes(serviceId)
    ? favs.filter(id => id !== serviceId)
    : [...favs, serviceId];
  try { sessionStorage.setItem(FAVORITES_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function getRecentServices() {
  try {
    const raw = sessionStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function recordServiceUsage(serviceId) {
  const recent = getRecentServices().filter(id => id !== serviceId);
  const updated = [serviceId, ...recent].slice(0, 6);
  try { sessionStorage.setItem(RECENT_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}
