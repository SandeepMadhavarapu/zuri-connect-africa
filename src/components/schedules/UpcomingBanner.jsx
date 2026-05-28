import { motion } from 'framer-motion';
import { AlertTriangle, Clock } from 'lucide-react';

function daysUntil(dateStr) {
  const now = new Date(); now.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d - now) / 86400000);
}

export default function UpcomingBanner({ schedules }) {
  const active = schedules.filter(s => !s.paused);
  const due = active.filter(s => daysUntil(s.nextDate) <= 0);
  const soon = active.filter(s => { const d = daysUntil(s.nextDate); return d > 0 && d <= 3; });
  const totalDue = active.reduce((sum, s) => {
    const d = daysUntil(s.nextDate);
    return d <= 7 ? sum + s.amount : sum;
  }, 0);

  return (
    <div className="space-y-3 mb-4">
      {/* Summary card */}
      <div className="glass-card rounded-2xl p-4" style={{ borderColor: 'rgba(0,200,83,0.15)' }}>
        <p className="text-xs text-muted-foreground mb-1">Due in next 7 days</p>
        <p className="font-grotesk font-bold text-2xl text-foreground">KSh {totalDue.toLocaleString()}</p>
        <div className="flex items-center gap-4 mt-3">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-red-400" />
            <span className="text-xs text-muted-foreground">{due.length} due today</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-yellow-400" />
            <span className="text-xs text-muted-foreground">{soon.length} due soon</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-primary" />
            <span className="text-xs text-muted-foreground">{active.length} active</span>
          </div>
        </div>
      </div>

      {/* Alert banners */}
      {due.map(s => (
        <motion.div key={s.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
          className="flex items-center gap-3 bg-red-400/8 border border-red-400/20 rounded-2xl px-4 py-3">
          <AlertTriangle size={15} className="text-red-400 shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-red-400">{s.name} — Payment Due Today</p>
            <p className="text-[11px] text-muted-foreground">KSh {s.amount.toLocaleString()} · Paybill {s.paybill}</p>
          </div>
          <span className="text-[10px] bg-red-400/20 text-red-400 px-2 py-0.5 rounded-full font-semibold">NOW</span>
        </motion.div>
      ))}
      {soon.map(s => (
        <motion.div key={s.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
          className="flex items-center gap-3 bg-yellow-400/8 border border-yellow-400/20 rounded-2xl px-4 py-3">
          <Clock size={15} className="text-yellow-400 shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-yellow-400">{s.name} — Due in {daysUntil(s.nextDate)} day{daysUntil(s.nextDate) > 1 ? 's' : ''}</p>
            <p className="text-[11px] text-muted-foreground">KSh {s.amount.toLocaleString()} · Paybill {s.paybill}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}