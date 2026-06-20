// Routes that adopt the dark Hesabu surface (ink background + dark top bar /
// bottom nav). Originally just the chama front door at '/' and '/chama'; as of
// Restructure Step 2-B the Wallet dashboard at '/home' is also a dark Hesabu
// surface, so the whole "front-of-app" reads as one product. The remaining Zuri
// pages ('/history', '/profile', '/ai', …) stay light until their own steps.
// Any shared chrome that applies the dark treatment must gate on this rule
// rather than a bare startsWith('/chama'), otherwise '/' would get light chrome.
export function isHesabuRoute(pathname) {
  return pathname === '/' || pathname === '/home' || pathname.startsWith('/chama');
}
