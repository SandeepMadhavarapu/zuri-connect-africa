/**
 * Comprehensive route audit & validation
 * Validates all navigation routes against mounted App.jsx routes
 */

const EXPECTED_ROUTES = {
  '/': 'Home',
  '/history': 'History',
  '/ai': 'Duke AI',
  '/profile': 'Account',
  '/notifications': 'Notifications',
  '/schedules': 'Schedules',
  '/wallet': 'Wallet',
  '/security': 'Security',
  '/network': 'Network Status',
  '/audit': 'Audit',
  ...(import.meta.env.VITE_ALLOW_INTERNAL_PAGES === 'true' ? {
    '/admin': 'Admin',
    '/admin/soc': 'Security SOC',
  } : {}),
};

const NAVIGATION_LINKS = [
  // BottomNav
  { from: 'BottomNav', route: '/', label: 'Home' },
  { from: 'BottomNav', route: '/history', label: 'History' },
  { from: 'BottomNav', route: '/ai', label: 'Duke AI' },
  { from: 'BottomNav', route: '/wallet', label: 'Wallet' },
  { from: 'BottomNav', route: '/profile', label: 'Account' },

  // Home/Dashboard quick actions
  { from: 'Home', route: '/wallet', label: 'Wallet' },
  { from: 'Home', route: '/schedules', label: 'Standing Orders' },
  { from: 'Home', route: '/security', label: 'Security' },
  { from: 'Home', route: '/ai', label: 'Duke AI' },

  // Profile menu
  { from: 'Profile', route: '/security', label: 'Security' },
  { from: 'Profile', route: '/notifications', label: 'Notifications' },
  { from: 'Profile', route: '/audit', label: 'Audit' },
  { from: 'Profile', route: '/', label: 'Home' },
];

export function validateRoute(route) {
  if (!route) return { valid: false, error: 'Route is empty' };
  
  const normalizedRoute = String(route).toLowerCase().trim();
  const exists = normalizedRoute in EXPECTED_ROUTES;
  
  return {
    valid: exists,
    error: exists ? null : `Route "${route}" not found in App.jsx`,
    label: EXPECTED_ROUTES[normalizedRoute],
  };
}

export function validateAllNavigationLinks() {
  const issues = [];
  
  NAVIGATION_LINKS.forEach(link => {
    const validation = validateRoute(link.route);
    if (!validation.valid) {
      issues.push({
        from: link.from,
        route: link.route,
        label: link.label,
        error: validation.error,
      });
    }
  });
  
  return {
    totalLinks: NAVIGATION_LINKS.length,
    issuesFound: issues.length,
    issues,
    status: issues.length === 0 ? 'healthy' : 'warning',
  };
}

export function logRouteAudit() {
  if (import.meta.env.MODE !== 'development') return;
  
  const audit = validateAllNavigationLinks();
  
  if (audit.issuesFound > 0) {
    console.warn('[Route Audit]', audit);
  } else {
    console.log('[Route Audit] ✓ All routes valid');
  }
  
  return audit;
}