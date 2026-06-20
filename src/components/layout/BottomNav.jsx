import { useNavigate, useLocation } from 'react-router-dom';
import { History, MessageSquare, Landmark, Wallet, User } from 'lucide-react';
import { motion } from 'framer-motion';
import { AI_BRAND } from '@/lib/branding/aiBrand';
import { isHesabuRoute } from '@/lib/hesabuRoutes';

const tabs = [
  { path: '/',        icon: Landmark,      label: 'Hesabu'         },
  { path: '/home',    icon: Wallet,        label: 'Wallet'         },
  { path: '/history', icon: History,       label: 'History'        },
  { path: '/ai',      icon: MessageSquare, label: AI_BRAND.navLabel },
  { path: '/profile', icon: User,          label: 'Account', badge: true },
];

export default function BottomNav() {
  const navigate  = useNavigate();
  const location  = useLocation();
  // Mirror TopBar's adaptive chrome: the nav tints to its section (dark ink-glass
  // on Hesabu, light glass on Zuri) while staying the same component. Adding
  // `hesabu-theme` brings the --hesabu-* vars into scope on the element, exactly
  // as TopBar does. Gated on isHesabuRoute so it's deliberate and reversible.
  const isChama   = isHesabuRoute(location.pathname);

  return (
    <div
      className={`zuri-bottom-nav backdrop-blur-xl px-3 pt-2 shrink-0 z-20 relative ${
        isChama ? 'hesabu-theme zuri-bottom-nav--hesabu' : ''
      }`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-center justify-between h-[66px] gap-1">
        {tabs.map((tab) => {
          const { path, icon: Icon, label, badge } = tab;
          const active = location.pathname === path;

          return (
            <motion.button
              key={path}
              onClick={() => navigate(path)}
              className={`flex-1 min-w-0 h-14 flex flex-col items-center justify-center relative group px-1 rounded-2xl ${
                active ? 'zuri-nav-active' : ''
              }`}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              {/* Active background */}
              {active && (
                <motion.div
                  layoutId="nav-indicator"
                  className="absolute inset-x-1 top-1 bottom-1 rounded-2xl bg-primary/10 border border-primary/20 shadow-sm shadow-primary/10"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}

              {/* Icon */}
              <div className="relative z-10 mb-1 flex h-5 items-center justify-center">
                <motion.div
                  animate={active ? { y: -2 } : { y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <Icon
                    size={19}
                    className={`transition-all duration-300 ${
                      active
                        ? 'text-primary'
                        : isChama
                          ? 'text-hesabu-muted group-hover:text-hesabu-paper'
                          : 'text-muted-foreground group-hover:text-foreground'
                    }`}
                  />
                </motion.div>

                {badge && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -top-0.5 -right-1.5 w-2 h-2 rounded-full gradient-green"
                  />
                )}
              </div>

              {/* Label */}
              <motion.span
                className={`text-[10px] font-bold relative z-10 transition-colors duration-300 leading-none ${
                  active
                    ? 'text-primary'
                    : isChama
                      ? 'text-hesabu-muted group-hover:text-hesabu-paper'
                      : 'text-muted-foreground group-hover:text-foreground'
                }`}
                animate={active ? { opacity: 1 } : { opacity: 0.7 }}
              >
                {label}
              </motion.span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
