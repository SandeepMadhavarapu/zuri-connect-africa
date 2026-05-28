import { useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function firstDay(y, m) { return new Date(y, m, 1).getDay(); }

export default function ScheduleCalendar({ schedules }) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [selectedDay, setSelectedDay] = useState(null);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
    setSelectedDay(null);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
    setSelectedDay(null);
  };

  const days = daysInMonth(viewYear, viewMonth);
  const offset = firstDay(viewYear, viewMonth);
  const monthLabel = new Date(viewYear, viewMonth).toLocaleString('default', { month: 'long', year: 'numeric' });

  // Build a map: day → schedules due
  const scheduleMap = {};
  schedules.filter(s => !s.paused).forEach(s => {
    const dom = s.dayOfMonth;
    if (dom >= 1 && dom <= days) {
      scheduleMap[dom] = scheduleMap[dom] || [];
      scheduleMap[dom].push(s);
    }
  });

  const today = now.getDate();
  const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();

  const selectedSchedules = selectedDay ? (scheduleMap[selectedDay] || []) : [];

  return (
    <div>
      {/* Month navigator */}
      <div className="glass-card rounded-2xl p-4 mb-4">
        <div className="flex items-center justify-between mb-4">
          <button onClick={prevMonth} className="w-8 h-8 rounded-xl surface2 flex items-center justify-center">
            <ChevronLeft size={16} className="text-muted-foreground" />
          </button>
          <p className="text-sm font-bold text-foreground font-grotesk">{monthLabel}</p>
          <button onClick={nextMonth} className="w-8 h-8 rounded-xl surface2 flex items-center justify-center">
            <ChevronRight size={16} className="text-muted-foreground" />
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
            <p key={d} className="text-center text-[10px] text-muted-foreground font-semibold py-1">{d}</p>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7 gap-y-1">
          {Array.from({ length: offset }).map((_, i) => <div key={`e${i}`} />)}
          {Array.from({ length: days }).map((_, i) => {
            const day = i + 1;
            const hasSched = !!scheduleMap[day];
            const isToday = isCurrentMonth && day === today;
            const isSelected = selectedDay === day;
            const isPast = isCurrentMonth && day < today;
            const dots = (scheduleMap[day] || []).slice(0, 3);

            return (
              <button
                key={day}
                onClick={() => setSelectedDay(isSelected ? null : day)}
                className={`relative flex flex-col items-center py-1 rounded-xl transition-all ${
                  isSelected ? 'bg-primary' : isToday ? 'bg-primary/15' : 'hover:bg-muted/30'
                } ${isPast ? 'opacity-40' : ''}`}
              >
                <span className={`text-xs font-semibold ${
                  isSelected ? 'text-black' : isToday ? 'text-primary' : 'text-foreground'
                }`}>{day}</span>
                <div className="flex gap-0.5 mt-0.5 h-2 items-center">
                  {dots.map((s, di) => (
                    <div key={di} className="w-1 h-1 rounded-full"
                      style={{ background: isSelected ? '#000' : s.color }} />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Day detail */}
      {selectedDay && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            {monthLabel.split(' ')[0]} {selectedDay}
          </p>
          {selectedSchedules.length === 0 ? (
            <div className="glass-card rounded-2xl py-8 text-center">
              <p className="text-sm text-muted-foreground">No payments scheduled</p>
            </div>
          ) : (
            <div className="space-y-2">
              {selectedSchedules.map(s => (
                <div key={s.id} className="glass-card rounded-2xl px-4 py-3.5 flex items-center gap-3"
                  style={{ borderLeft: `3px solid ${s.color}` }}>
                  <span className="text-2xl">{s.emoji}</span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-foreground">{s.name}</p>
                    <p className="text-xs text-muted-foreground">Paybill {s.paybill} · Acc {s.account}</p>
                  </div>
                  <p className="font-grotesk font-bold text-sm text-foreground">KSh {s.amount.toLocaleString()}</p>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}

      {/* Legend */}
      <div className="mt-4 flex flex-wrap gap-2">
        {schedules.filter(s => !s.paused).map(s => (
          <div key={s.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <div className="w-2 h-2 rounded-full" style={{ background: s.color }} />
            {s.name}
          </div>
        ))}
      </div>
    </div>
  );
}