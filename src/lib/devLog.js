/** Development-only logging - keeps executive demos and production consoles clean. */

export function isDebugLoggingEnabled() {
  return import.meta.env.DEV === true || import.meta.env.VITE_DEBUG_LOGS === 'true';
}

export function isBootLoggingEnabled() {
  return isDebugLoggingEnabled() || import.meta.env.VITE_DEBUG_BOOT === 'true';
}

export function devWarn(...args) {
  if (isDebugLoggingEnabled()) console.warn(...args);
}

export function devLog(...args) {
  if (isDebugLoggingEnabled()) console.log(...args);
}

export function devInfo(...args) {
  if (isDebugLoggingEnabled()) console.info(...args);
}

export function bootInfo(...args) {
  if (isBootLoggingEnabled()) console.info(...args);
}

export function bootWarn(...args) {
  if (isBootLoggingEnabled()) console.warn(...args);
}
