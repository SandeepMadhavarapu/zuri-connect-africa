// Shared data store for budget features

export const CATEGORIES = [
  { key: 'transport',  label: 'Transport',   color: '#2196F3', emoji: '🚗' },
  { key: 'food',       label: 'Food',         color: '#FF7043', emoji: '🍔' },
  { key: 'utilities',  label: 'Utilities',    color: '#00C853', emoji: '💡' },
  { key: 'airtime',    label: 'Airtime/Data', color: '#AB47BC', emoji: '📶' },
  { key: 'transfers',  label: 'Transfers',    color: '#FFB300', emoji: '💸' },
  { key: 'shopping',   label: 'Shopping',     color: '#EC407A', emoji: '🛍️' },
  { key: 'savings',    label: 'Savings',      color: '#26C6DA', emoji: '🏦' },
  { key: 'other',      label: 'Other',        color: '#78909C', emoji: '📦' },
];

// Simulated AI-categorised transactions for May 2026
export const TRANSACTIONS = [
  { id: 1,  category: 'transfers',  name: 'John Kamau',       amount: 1200,  date: '2026-05-07' },
  { id: 2,  category: 'food',       name: 'Naivas Supermarket',amount: 2340, date: '2026-05-06' },
  { id: 3,  category: 'airtime',    name: 'Airtime Purchase',  amount: 100,  date: '2026-05-06' },
  { id: 4,  category: 'airtime',    name: 'Daily Bundle 1GB',  amount: 49,   date: '2026-05-05' },
  { id: 5,  category: 'utilities',  name: 'Kenya Power',       amount: 1500, date: '2026-05-04' },
  { id: 6,  category: 'transfers',  name: 'Peter Mwangi',      amount: 500,  date: '2026-05-04' },
  { id: 7,  category: 'airtime',    name: 'Monthly 15GB',      amount: 999,  date: '2026-05-01' },
  { id: 8,  category: 'utilities',  name: 'Nairobi Water',     amount: 800,  date: '2026-04-28' },
  { id: 9,  category: 'transport',  name: 'Bolt Ride',         amount: 450,  date: '2026-05-07' },
  { id: 10, category: 'transport',  name: 'Bolt Ride',         amount: 320,  date: '2026-05-05' },
  { id: 11, category: 'transport',  name: 'Matatu – CBD',      amount: 80,   date: '2026-05-06' },
  { id: 12, category: 'food',       name: 'KFC Westgate',      amount: 890,  date: '2026-05-03' },
  { id: 13, category: 'food',       name: 'Java House',        amount: 650,  date: '2026-05-02' },
  { id: 14, category: 'shopping',   name: 'Zara Nairobi',      amount: 3200, date: '2026-05-01' },
  { id: 15, category: 'savings',    name: 'M-Shwari Deposit',  amount: 2000, date: '2026-05-01' },
];

// Default budget limits per category (KSh/month)
export const DEFAULT_LIMITS = {
  transport: 3000,
  food: 5000,
  utilities: 3500,
  airtime: 1500,
  transfers: 4000,
  shopping: 3000,
  savings: 5000,
  other: 1000,
};

// Monthly trend data (last 6 months)
export const MONTHLY_TREND = [
  { month: 'Dec', transport: 2100, food: 4200, utilities: 2800, airtime: 1100, transfers: 3200, shopping: 1500, savings: 2000 },
  { month: 'Jan', transport: 2800, food: 4800, utilities: 3200, airtime: 1300, transfers: 2900, shopping: 2200, savings: 2000 },
  { month: 'Feb', transport: 2400, food: 4400, utilities: 2900, airtime: 1200, transfers: 3500, shopping: 1800, savings: 3000 },
  { month: 'Mar', transport: 3100, food: 5100, utilities: 3300, airtime: 1400, transfers: 4100, shopping: 2800, savings: 2500 },
  { month: 'Apr', transport: 2700, food: 4900, utilities: 3100, airtime: 1100, transfers: 3800, shopping: 3500, savings: 2000 },
  { month: 'May', transport: 850,  food: 3880, utilities: 2300, airtime: 1148, transfers: 1700, shopping: 3200, savings: 2000 },
];

export function getCategorySpend() {
  return TRANSACTIONS.reduce((acc, tx) => {
    acc[tx.category] = (acc[tx.category] || 0) + tx.amount;
    return acc;
  }, {});
}