import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, Scale, Hash } from 'lucide-react';

export default function AuditMetrics({ entries, totalDebits, totalCredits, diff, balanced, loading }) {
  const metrics = [
    {
      label:  'Total Debits',
      value:  `KSh ${totalDebits.toLocaleString()}`,
      icon:   ArrowUpRight,
      color:  'text-red-400',
      bg:     'bg-red-400/8',
      border: 'border-red-400/12',
    },
    {
      label:  'Total Credits',
      value:  `KSh ${totalCredits.toLocaleString()}`,
      icon:   ArrowDownLeft,
      color:  'text-primary',
      bg:     'bg-primary/8',
      border: 'border-primary/12',
    },
    {
      label:  'Balance Diff',
      value:  diff === 0 ? 'Balanced' : `KSh ${diff.toLocaleString()}`,
      icon:   Scale,
      color:  balanced ? 'text-primary' : 'text-red-400',
      bg:     balanced ? 'bg-primary/8' : 'bg-red-400/8',
      border: balanced ? 'border-primary/12' : 'border-red-400/12',
    },
    {
      label:  'Entries',
      value:  entries.length.toString(),
      icon:   Hash,
      color:  'text-blue-400',
      bg:     'bg-blue-400/8',
      border: 'border-blue-400/12',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 mb-4">
      {metrics.map((m, i) => {
        const Icon = m.icon;
        return (
          <motion.div
            key={m.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className={`glass-card rounded-2xl p-3.5 border ${m.border}`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{m.label}</span>
              <div className={`w-6 h-6 rounded-lg ${m.bg} flex items-center justify-center`}>
                <Icon size={11} className={m.color} />
              </div>
            </div>
            <p className={`font-grotesk font-bold text-[15px] ${m.color} ${loading ? 'opacity-40' : ''}`}>
              {loading ? '—' : m.value}
            </p>
          </motion.div>
        );
      })}
    </div>
  );
}