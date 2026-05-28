import { motion } from 'framer-motion';

export default function SafeTransactionCard({ 
  transaction, 
  icon: Icon, 
  iconColor, 
  iconBg,
  isLast = false,
  index = 0 
}) {
  if (!transaction || !Icon) {
    return (
      <div className="flex items-center gap-3 px-4 py-3.5 bg-white/3 rounded animate-pulse">
        <div className="w-9 h-9 rounded-2xl bg-white/10 shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-white/10 rounded w-24" />
          <div className="h-2 bg-white/10 rounded w-16" />
        </div>
      </div>
    );
  }
  
  const name = String(transaction.name || 'Transaction');
  const date = String(transaction.date || 'Unknown');
  const ref = String(transaction.ref || 'N/A');
  const amount = Math.max(0, Number(transaction.amount) || 0);
  const isIncoming = transaction.amount > 0;
  
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.03 }}
      className={`flex items-center gap-3 px-4 py-3.5 transition-all active:bg-muted/50 cursor-pointer ${
        !isLast ? 'border-b border-border/40' : ''
      }`}
    >
      <div className={`w-9 h-9 rounded-2xl ${iconBg} flex items-center justify-center shrink-0`}>
        <Icon size={16} className={iconColor} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{name}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{date}</p>
      </div>
      <div className="text-right shrink-0">
        <p className={`font-grotesk font-semibold text-sm ${isIncoming ? 'text-primary' : 'text-foreground'}`}>
          {isIncoming ? '+' : ''}KSh {amount.toLocaleString()}
        </p>
        <p className="text-[10px] text-muted-foreground">{ref}</p>
      </div>
    </motion.div>
  );
}