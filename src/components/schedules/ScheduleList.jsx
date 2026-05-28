import { motion, AnimatePresence } from 'framer-motion';
import { Pause, Play, Trash2, Calendar } from 'lucide-react';

function daysUntil(dateStr) {
  const now = new Date(); now.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d - now) / 86400000);
}

function DueBadge({ days }) {
  if (days <= 0) return <span className="text-[10px] bg-red-400/20 text-red-400 px-2 py-0.5 rounded-full font-semibold">Due today</span>;
  if (days <= 3) return <span className="text-[10px] bg-yellow-400/15 text-yellow-400 px-2 py-0.5 rounded-full font-semibold">In {days}d</span>;
  return <span className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full">{days}d</span>;
}

export default function ScheduleList({ schedules, onDelete, onTogglePause, filter }) {
  const list = filter === 'upcoming'
    ? schedules.filter(s => !s.paused && daysUntil(s.nextDate) <= 30).sort((a,b) => daysUntil(a.nextDate) - daysUntil(b.nextDate))
    : [...schedules].sort((a,b) => daysUntil(a.nextDate) - daysUntil(b.nextDate));

  if (list.length === 0) return (
    <div className="glass-card rounded-2xl py-12 text-center">
      <p className="text-sm text-muted-foreground">No standing orders yet</p>
    </div>
  );

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <AnimatePresence>
        {list.map((s, i) => {
          const days = daysUntil(s.nextDate);
          return (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ delay: i * 0.04 }}
              className={`px-4 py-4 ${i < list.length - 1 ? 'border-b border-border/40' : ''} ${s.paused ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-xl shrink-0"
                  style={{ background: `${s.color}18` }}>
                  {s.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-foreground">{s.name}</p>
                    {s.paused && <span className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full">Paused</span>}
                    <DueBadge days={days} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                    <Calendar size={10} />
                    Day {s.dayOfMonth} every month · Paybill {s.paybill}
                  </p>
                </div>
                <p className="font-grotesk font-bold text-sm text-foreground shrink-0">
                  KSh {s.amount.toLocaleString()}
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-2 mt-3 pl-13">
                <button
                  onClick={() => onTogglePause(s.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface2 border border-border/50 text-xs font-semibold text-muted-foreground"
                >
                  {s.paused ? <Play size={11} /> : <Pause size={11} />}
                  {s.paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  onClick={() => onDelete(s.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-400/10 border border-red-400/20 text-xs font-semibold text-red-400"
                >
                  <Trash2 size={11} /> Delete
                </button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}