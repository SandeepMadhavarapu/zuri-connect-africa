// Routes that adopt the dark Hesabu surface (ink background + dark top bar /
// bottom nav). Originally just the chama front door at '/' and '/chama'; as of
// Restructure Step 2-B the Wallet dashboard at '/home', the Account page at
// '/profile', and the Transactions page at '/history' are also dark Hesabu
// surfaces, so the whole "front-of-app" reads as one product. Step 2-B page 4/4
// brings the Duke AI copilot at '/ai' into the same dark identity, so every
// primary route is now Hesabu-themed. Any shared chrome that applies the dark
// treatment must gate on this rule rather than a bare startsWith('/chama'),
// otherwise '/' would get light chrome.
export function isHesabuRoute(pathname) {
  return pathname === '/' || pathname === '/home' || pathname === '/profile' || pathname === '/history' || pathname === '/ai' || pathname.startsWith('/chama');
}
