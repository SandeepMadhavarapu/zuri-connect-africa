import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, Plus, Bell, Repeat, Info } from 'lucide-react';
import ScheduleCalendar from '../components/schedules/ScheduleCalendar';
import ScheduleList from '../components/schedules/ScheduleList';
import AddScheduleModal from '../components/schedules/AddScheduleModal';
import UpcomingBanner from '../components/schedules/UpcomingBanner';

const TABS = [
  { key: 'upcoming', label: 'Upcoming', icon: Bell },
  { key: 'calendar', label: 'Calendar', icon: Calendar },
  { key: 'all', label: 'All Orders', icon: Repeat },
];

export default function Schedules() {
  const [activeTab, setActiveTab] = useState('upcoming');
  const [showAdd, setShowAdd] = useState(false);
  const [schedules, setSchedules] = useState(DEFAULT_SCHEDULES);

  const addSchedule = (s) => setSchedules(prev => [{ ...s, id: Date.now() }, ...prev]);
  const deleteSchedule = (id) => setSchedules(prev => prev.filter(s => s.id !== id));
  const togglePause = (id) => setSchedules(prev => prev.map(s => s.id === id ? { ...s, paused: !s.paused } : s));

  return (
    <div className="px-4 py-4 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-foreground font-grotesk">Standing Orders</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {schedules.filter(s => !s.paused).length} schedule{schedules.filter(s => !s.paused).length === 1 ? '' : 's'} saved on this device
          </p>
        </div>
        <motion.button
          whileTap={{ scale: 0.93 }}
          onClick={() => setShowAdd(true)}
          aria-label="Add new schedule"
          className="w-10 h-10 rounded-2xl gradient-green flex items-center justify-center glow-green-sm"
        >
          <Plus size={20} className="text-black" />
        </motion.button>
      </div>

      {/* Single subtle preview banner — schedules live on this device; no
          automatic payments are executed. When a schedule is due the user must
          tap it to enter the server-side payment flow (biometric/PIN step-up
          applies). Honest copy retained per the prepitch invariant. */}
      <div
        className="glass-card rounded-xl px-3 py-2 mb-4 flex items-start gap-2"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Standing orders preview — saved on this device. No automatic payments are executed; tap a schedule to start a secure payment flow.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1.5 mb-5 glass-card rounded-2xl p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeTab === key ? 'bg-primary text-black' : 'text-muted-foreground'
            }`}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'upcoming' && (
          <motion.div key="upcoming" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <UpcomingBanner schedules={schedules} />
            <ScheduleList schedules={schedules} onDelete={deleteSchedule} onTogglePause={togglePause} filter="upcoming" />
          </motion.div>
        )}
        {activeTab === 'calendar' && (
          <motion.div key="calendar" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <ScheduleCalendar schedules={schedules} />
          </motion.div>
        )}
        {activeTab === 'all' && (
          <motion.div key="all" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <ScheduleList schedules={schedules} onDelete={deleteSchedule} onTogglePause={togglePause} filter="all" />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAdd && <AddScheduleModal onClose={() => setShowAdd(false)} onAdd={addSchedule} />}
      </AnimatePresence>
    </div>
  );
}

const today = new Date();
const d = (offset) => {
  const dt = new Date(today);
  dt.setDate(today.getDate() + offset);
  return dt.toISOString().split('T')[0];
};

const DEFAULT_SCHEDULES = [
  { id: 1, name: 'Kenya Power', category: 'utilities', amount: 1500, frequency: 'monthly', dayOfMonth: 5, nextDate: d(0), paused: false, paybill: '888880', account: '12345678', color: '#00C853', emoji: '💡' },
  { id: 2, name: 'Rent – Kilimani Apt', category: 'rent', amount: 28000, frequency: 'monthly', dayOfMonth: 1, nextDate: d(2), paused: false, paybill: '000000', account: 'RENT001', color: '#2196F3', emoji: '🏠' },
  { id: 3, name: 'Nairobi Water', category: 'utilities', amount: 800, frequency: 'monthly', dayOfMonth: 10, nextDate: d(5), paused: false, paybill: '444400', account: '87654321', color: '#26C6DA', emoji: '💧' },
  { id: 4, name: 'DStv Subscription', category: 'subscription', amount: 1999, frequency: 'monthly', dayOfMonth: 15, nextDate: d(9), paused: false, paybill: '777300', account: '44556677', color: '#AB47BC', emoji: '📺' },
  { id: 5, name: 'Gym – Lifestyle Fit', category: 'subscription', amount: 3500, frequency: 'monthly', dayOfMonth: 20, nextDate: d(14), paused: true, paybill: '654321', account: 'GYM001', color: '#FF7043', emoji: '💪' },
];