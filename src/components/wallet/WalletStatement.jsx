import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowUpRight, ArrowDownLeft, Phone, Wifi, Zap, CreditCard, Search
} from 'lucide-react';
import { formatDate } from '../../lib/mpesa';

const typeConfig = {
  send:    { icon: ArrowUpRight, color: 'text-red-400',    bg: 'bg-red-400/10',    label: 'Sent' },
  receive: { icon: ArrowDownLeft, color: 'text-primary',   bg: 'bg-primary/10',    label: 'Received' },
  airtime: { icon: Phone,        color: 'text-yellow-400', bg: 'bg-yellow-400/10', label: 'Airtime' },
  bundle:  { icon: Wifi,         color: 'text-purple-400', bg: 'bg-purple-400/10', label: 'Bundle' },
  fuliza:  { icon: Zap,          color: 'text-orange-400', bg: 'bg-orange-400/10', label: 'Fuliza' },
  paybill: { icon: CreditCard,   color: 'text-blue-400',   bg: 'bg-blue-400/10',   label: 'Paybill' },
};

const FILTERS = ['All', 'Sent', 'Received', 'Paybill', 'Airtime'];

export default function WalletStatement({ transactions }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');

  const list = transactions.filter(tx => {
    const cfg = typeConfig[tx.type];
    const matchFilter = filter === 'All' || cfg?.label === filter;
    const matchSearch = tx.name.toLowerCase().includes(search.toLowerCase()) || tx.id.includes(search);
    return matchFilter && matchSearch;
  });

  const totalIn  = list.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalOut = list.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);

  return (
    <div>
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="glass-card rounded-2xl p-3">
          <p className="text-[10px] text-muted-foreground">Total In</p>
          <p className="font-grotesk font-bold text-base text-primary mt-0.5">+{totalIn.toLocaleString()}</p>
        </div>
        <div className="glass-card rounded-2xl p-3">
          <p className="text-[10px] text-muted-foreground">Total Out</p>
          <p className="font-grotesk font-bold text-base text-red-400 mt-0.5">-{totalOut.toLocaleString()}</p>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 glass-card rounded-xl px-3 py-2.5 mb-2">
        <Search size={13} className="text-muted-foreground shrink-0" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search transactions…"
          className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none" />
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 mb-3" style={{ scrollbarWidth: 'none' }}>
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`shrink-0 px-3 py-1.5 rounded-xl text-[11px] font-semibold transition-all ${
              filter === f ? 'bg-primary text-black' : 'surface2 text-muted-foreground border border-border/50'
            }`}>{f}</button>
        ))}
      </div>

      {/* Transaction list */}
      <div className="glass-card rounded-2xl overflow-hidden">
        {list.map((tx, i) => {
          const cfg = typeConfig[tx.type] || typeConfig.send;
          const Icon = cfg.icon;
          return (
            <motion.div key={tx.id}
              initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.025 }}
              className={`flex items-center gap-3 px-4 py-3.5 ${i < list.length - 1 ? 'border-b border-border/40' : ''}`}
            >
              <div className={`w-9 h-9 rounded-2xl ${cfg.bg} flex items-center justify-center shrink-0`}>
                <Icon size={15} className={cfg.color} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground truncate">{tx.name}</p>
                <p className="text-[10px] text-muted-foreground">{formatDate(tx.date)}</p>
                {tx.note && <p className="text-[10px] text-primary mt-0.5">"{tx.note}"</p>}
              </div>
              <div className="text-right shrink-0">
                <p className={`font-grotesk font-semibold text-xs ${tx.amount > 0 ? 'text-primary' : 'text-foreground'}`}>
                  {tx.amount > 0 ? '+' : ''}KSh {Math.abs(tx.amount).toLocaleString()}
                </p>
                {tx.fee > 0 && <p className="text-[9px] text-muted-foreground">Fee: {tx.fee}</p>}
              </div>
            </motion.div>
          );
        })}
        {list.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-xs text-muted-foreground">No transactions found</p>
          </div>
        )}
      </div>
    </div>
  );
}