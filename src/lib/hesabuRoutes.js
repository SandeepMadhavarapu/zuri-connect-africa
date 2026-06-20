// Hesabu (chama) now lives at BOTH '/' (the app front door) and '/chama'
// (kept for old links, which redirect to '/'). Any shared chrome that applies
// the dark Hesabu treatment must gate on this rule rather than a bare
// startsWith('/chama'), otherwise '/' would get the light Zuri chrome.
export function isHesabuRoute(pathname) {
  return pathname === '/' || pathname.startsWith('/chama');
}
