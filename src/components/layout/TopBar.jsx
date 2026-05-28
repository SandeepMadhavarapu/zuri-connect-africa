import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, ChevronLeft, ShieldCheck } from 'lucide-react';
import { AI_BRAND } from '@/lib/branding/aiBrand';

const routeTitles = {
  '/': null,
  '/send': 'Send Money',
  '/receive': 'Receive',
  '/airtime': 'Airtime',
  '/bundles': 'Data Bundles',
  '/fuliza': 'Fuliza',
  '/bonga': 'Bonga Points',
  '/paybill': 'Pay Bill',
  '/history': 'Transactions',
  '/profile': 'Account',
  '/ai': AI_BRAND.routeTitle,
  '/notifications': 'Notifications',
  '/budget': 'Budget & Insights',
  '/schedules': 'Standing Orders',
  '/wallet': 'M-PESA Wallet',
  '/security': 'Security Centre',
  '/network': 'Network Status',
  '/platform': 'Platform Readiness',
  '/audit': 'Audit & Reconciliation',
  '/admin': 'Fraud Ops Center',
};

export default function TopBar() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const title     = routeTitles[location.pathname];
  const isHome    = location.pathname === '/';

  return (
    <div className="bg-background/90 backdrop-blur-xl border-b border-primary/10 px-4 flex items-center justify-between h-[60px] shrink-0 z-20 relative">
      {isHome ? (
        <>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-2xl gradient-green flex items-center justify-center shadow-lg shadow-primary/20 shrink-0">
              <span className="text-white font-bold text-sm tracking-tight font-grotesk">Z</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1">
                <span className="font-grotesk font-bold text-[14px] text-foreground tracking-tight">Zuri Connect</span>
                <span className="text-primary text-[11px] font-bold">Africa</span>
              </div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.18em]">M-PESA intelligence</p>
            </div>
          </div>
          <button
            onClick={() => navigate('/notifications')}
            className="relative w-9 h-9 rounded-2xl soft-icon-button flex items-center justify-center transition-all hover:bg-primary/8"
          >
            <Bell size={15} className="text-muted-foreground" />
            <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-primary shadow-sm shadow-primary" />
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => window.history.length > 1 ? navigate(-1) : navigate('/')}
            className="w-9 h-9 rounded-2xl soft-icon-button flex items-center justify-center transition-all hover:bg-primary/8"
          >
            <ChevronLeft size={17} className="text-foreground" />
          </button>
          <span className="font-jakarta font-bold text-[13px] text-foreground tracking-tight">{title}</span>
          <div className="w-9 h-9 rounded-2xl bg-primary/8 flex items-center justify-center border border-primary/15">
            <ShieldCheck size={13} className="text-primary" />
          </div>
        </>
      )}
    </div>
  );
}
