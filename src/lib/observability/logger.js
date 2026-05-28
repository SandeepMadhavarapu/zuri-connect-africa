import { emit, EVENTS } from '../eventBus';

const LOG_KEY = 'zuri_obs_logs';

export const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
};

export function log(level, message, metadata = {}) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    service: 'zuri-connect',
    env: import.meta.env.MODE === 'production' ? 'production' : 'demo',
    ...metadata,
  };

  const serialised = JSON.stringify(entry);

  switch (level) {
    case LOG_LEVELS.CRITICAL:
    case LOG_LEVELS.ERROR:
      console.error(`[OBS] ${serialised}`);
      emit(EVENTS.FRAUD_FLAGGED, { level, message, metadata });
      break;
    case LOG_LEVELS.WARN:
      console.warn(`[OBS] ${serialised}`);
      break;
    default:
      console.info(`[OBS] ${serialised}`);
  }

  try {
    const logs = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
    logs.push(entry);
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    sessionStorage.setItem(LOG_KEY, JSON.stringify(logs));
  } catch {
    // ignore storage failures
  }
}

export function getLogs(level) {
  try {
    const logs = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
    return level ? logs.filter((l) => l.level === level) : logs;
  } catch {
    return [];
  }
}
