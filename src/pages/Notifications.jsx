import { useState } from 'react';
import { motion } from 'framer-motion';
import { Shield, ArrowDownLeft, ArrowUpRight, Zap, Star, Wifi, Check, Info } from 'lucide-react';

const SEED_NOTIFICATIONS = [
  {
    id: 1,
    icon: ArrowDownLeft,
    color: 'text-primary',
    bg: 'bg-primary/10',
    title: 'Money Received',
    body: 'KSh 3,500 received from Grace Wanjiku. M-PESA balance is KSh 24,850.',
    time: '2 hrs ago',
    unread: true,
  },
  {
    id: 2,
    icon: Shield,
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    title: 'Security Alert',
    body: 'Unusual login attempt blocked from a new device in Nairobi West. Was this you?',
    time: '5 hrs ago',
    unread: true,
  },
  {
    id: 3,
    icon: Star,
    color: 'text-yellow-400',
    bg: 'bg-yellow-400/10',
    title: 'Bonga Points Earned',
    body: 'You earned 45 Bonga Points from today\'s transactions. Total: 1,240 points.',
    time: 'Yesterday',
    unread: false,
  },
  {
    id: 4,
    icon: Wifi,
    color: 'text-purple-400',
    bg: 'bg-purple-400/10',
    title: 'Bundle Running Low',
    body: 'Your 5GB bundle has 2.4GB remaining and expires in 4 days. Renew now.',
    time: 'Yesterday',
    unread: false,
  },
  {
    id: 5,
    icon: Zap,
    color: 'text-yellow-400',
    bg: 'bg-yellow-400/10',
    title: 'Fuliza Reminder',
    body: 'You have KSh 250 Fuliza outstanding. It will be auto-deducted on your next deposit.',
    time: '2 days ago',
    unread: false,
  },
  {
    id: 6,
    icon: ArrowUpRight,
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    title: 'Money Sent',
    body: 'KSh 1,200 sent to John Kamau 0712 345 678 successfully.',
    time: '2 days ago',
    unread: false,
  },
];

export default function Notifications() {
  const [notifications, setNotifications] = useState(SEED_NOTIFICATIONS);
  const unreadCount = notifications.reduce((n, x) => n + (x.unread ? 1 : 0), 0);

  // `Mark all read` is a local-only acknowledgement: the notifications feed
  // itself is a preview (no notifications backend table is wired yet) so we do
  // NOT pretend to persist the read state to a server. Once a server-side
  // `notifications` table exists, this handler should POST a mark-read mutation
  // before clearing local unread flags.
  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
  };

  const markOneRead = (id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, unread: false } : n)));
  };

  return (
    <div className="px-4 py-4 pb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${unreadCount > 0 ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40'}`}
          />
          <span className={`text-xs font-medium ${unreadCount > 0 ? 'text-primary' : 'text-muted-foreground'}`}>
            {unreadCount > 0 ? `${unreadCount} unread` : 'All read'}
          </span>
        </div>
        <button
          type="button"
          onClick={markAllRead}
          disabled={unreadCount === 0}
          aria-label="Mark all notifications as read"
          className={`flex items-center gap-1 text-xs transition-colors ${
            unreadCount === 0 ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Check size={12} />
          Mark all read
        </button>
      </div>

      <div className="glass-card rounded-xl px-3 py-2 mb-3 flex items-start gap-2" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Notifications preview — read state is local to this device until the notifications backend is enabled.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {notifications.map((n, i) => {
          const Icon = n.icon;
          return (
            <motion.button
              type="button"
              key={n.id}
              onClick={() => markOneRead(n.id)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              className={`glass-card rounded-2xl px-4 py-4 relative text-left ${n.unread ? 'border-primary/15' : ''}`}
              aria-label={`${n.unread ? 'Unread: ' : ''}${n.title}`}
            >
              {n.unread && <div className="absolute top-4 right-4 w-2 h-2 rounded-full bg-primary" />}
              <div className="flex items-start gap-3">
                <div className={`w-9 h-9 rounded-2xl ${n.bg} flex items-center justify-center shrink-0`}>
                  <Icon size={16} className={n.color} />
                </div>
                <div className="flex-1 pr-4">
                  <p className={`text-sm font-semibold ${n.unread ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {n.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{n.body}</p>
                  <p className="text-[10px] text-muted-foreground/70 mt-2">{n.time}</p>
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
