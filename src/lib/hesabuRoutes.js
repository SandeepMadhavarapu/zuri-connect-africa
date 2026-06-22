// Routes that adopt the dark Hesabu surface (ink background + dark top bar /
// bottom nav). Originally just the chama front door at '/' and '/chama'; as of
// Restructure Step 2-B the Wallet dashboard at '/home', the Account page at
// '/profile', and the Transactions page at '/history' are also dark Hesabu
// surfaces, so the whole "front-of-app" reads as one product. The remaining Zuri
// page ('/ai') stays light until its own step (page 4). Any shared chrome that
// applies the dark treatment must gate on this rule rather than a bare
// startsWith('/chama'), otherwise '/' would get light chrome.
export function isHesabuRoute(pathname) {
  return pathname === '/' || pathname === '/home' || pathname === '/profile' || pathname === '/history' || pathname.startsWith('/chama');
}
