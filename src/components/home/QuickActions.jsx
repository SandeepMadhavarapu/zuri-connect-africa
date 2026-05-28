import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight, ArrowDownLeft, Phone, Wifi,
  CreditCard, CalendarClock, Zap, Wallet
} from 'lucide-react';

const actions = [
  { icon: ArrowUpRight,  label: 'Send',      color: 'text-primary',      path: '/send' },
  { icon: ArrowDownLeft, label: 'Receive',   color: 'text-blue-400',     path: '/receive' },
  { icon: Phone,         label: 'Airtime',   color: 'text-amber-400',    path: '/airtime' },
  { icon: Wifi,          label: 'Bundles',   color: 'text-violet-400',   path: '/bundles' },
  { icon: CreditCard,    label: 'Paybill',   color: 'text-primary',      path: '/paybill' },
  { icon: CalendarClock, label: 'Standing',  color: 'text-orange-400',   path: '/schedules' },
  { icon: Zap,           label: 'Fuliza',    color: 'text-amber-400',    path: '/fuliza' },
  { icon: Wallet,        label: 'M-PESA',    color: 'text-primary',      path: '/wallet' },
];

export default function QuickActions() {
  const navigate = useNavigate();

  return (
    <div>
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">Services</p>
      <div className="grid grid-cols-4 gap-3">
        {actions.map(action => {
          const Icon = action.icon;
          return (
            <button key={action.label} onClick={() => navigate(action.path)}
              className="flex flex-col items-center gap-2 active:opacity-70 transition-opacity">
              <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/7 flex items-center justify-center transition-all">
                <Icon size={19} className={action.color} />
              </div>
              <span className="text-[11px] text-muted-foreground font-medium">{action.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}