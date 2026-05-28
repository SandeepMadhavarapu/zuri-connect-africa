/**
 * Zuri Connect Africa — Device Trust v2
 *
 * Architecture:
 *   - Persistent device fingerprint stored in localStorage (survives sessions)
 *   - Multi-signal browser fingerprint (canvas, fonts, screen, timezone, UA, platform)
 *   - Session binding: each session token is tied to its fingerprint at creation
 *   - Trusted device registry: max 5 devices per user, oldest evicted on overflow
 *   - SIM-swap anomaly signals: timezone drift, UA/platform flip, fingerprint divergence
 *   - Risk score 0–100 emitted with every fingerprint evaluation
 *   - Step-up challenge tokens with 5-minute expiry and replay protection
 */

import { emit } from './eventBus';

// ── Storage keys ──────────────────────────────────────────────────────────────
const TRUSTED_DEVICES_KEY  = 'zuri_trusted_devices_v2';   // localStorage — persists
const CURRENT_DEVICE_KEY   = 'zuri_current_device_v2';    // localStorage — persists
const SESSION_BINDING_KEY  = 'zuri_session_binding';       // sessionStorage — session only
const CHALLENGE_KEY        = 'zuri_stepup_challenge';      // sessionStorage — session only
const RISK_HISTORY_KEY     = 'zuri_risk_history';          // localStorage — persists

const DEVICE_LOCATION_KEY  = 'zuri_device_locations_v1';

const MAX_TRUSTED_DEVICES  = 5;
const CHALLENGE_TTL_MS     = 5 * 60 * 1000;   // 5 minutes
const RISK_HISTORY_LIMIT   = 50;
const FINGERPRINT_DRIFT_THRESHOLD = 0.35;      // 35% signal divergence = suspect
const IMPOSSIBLE_TRAVEL_KMH = 900;

// ── Storage helpers ───────────────────────────────────────────────────────────

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function ssGet(key) {
  try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
}
function ssSet(key, val) {
  try { sessionStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function detectEmulatorOrBot() {
  const signals = [];
  let confidence = 0;

  // Check 1 — Selenium/Puppeteer/Playwright flag
  if (navigator.webdriver === true) {
    signals.push('webdriver_flag');
    confidence += 40;
  }

  // Check 2 — WebGL renderer string (emulator GPU signatures)
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
        const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '';
        const combined = (renderer + ' ' + vendor).toLowerCase();
        const emulatorStrings = [
          'swiftshader', 'llvmpipe', 'microsoft basic render',
          'android emulator', 'google swiftshader', 'virtualbox',
          'vmware', 'parallels', 'mesa offscreen'
        ];
        for (const s of emulatorStrings) {
          if (combined.includes(s)) {
            signals.push('webgl_emulator:' + s);
            confidence += 35;
            break;
          }
        }
      }
    }
  } catch {
    // WebGL not available — not necessarily an emulator
  }

  // Check 3 — Single CPU core on mobile user agent (emulators often report 1)
  const isMobileUA = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
  if (isMobileUA && navigator.hardwareConcurrency === 1) {
    signals.push('single_core_mobile');
    confidence += 20;
  }

  // Check 4 — No touch points on mobile user agent
  if (isMobileUA && navigator.maxTouchPoints === 0) {
    signals.push('no_touch_mobile');
    confidence += 20;
  }

  // Check 5 — Common emulator screen resolutions on mobile UA
  if (isMobileUA) {
    const w = screen.width;
    const h = screen.height;
    const emulatorResolutions = [
      [1280, 720], [1920, 1080], [2560, 1440]
    ];
    for (const [ew, eh] of emulatorResolutions) {
      if (w === ew && h === eh) {
        signals.push('emulator_resolution:' + w + 'x' + h);
        confidence += 15;
        break;
      }
    }
  }

  return {
    isEmulator: confidence >= 35,
    signals,
    confidence: Math.min(confidence, 100)
  };
}

// ── Device Fingerprinting ─────────────────────────────────────────────────────

/**
 * Collect all available browser/device signals.
 * Returns a flat object of named signals — no hashing yet, so we can diff signals individually.
 */
export function collectDeviceSignals() {
  const nav = navigator;
  const scr = screen;
  const emulatorResult = detectEmulatorOrBot();

  // Canvas fingerprint — unique per GPU/driver combination
  let canvasHash = 'unavailable';
  try {
    const canvas = document.createElement('canvas');
    canvas.width  = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font         = '14px Arial';
    ctx.fillStyle    = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle    = '#069';
    ctx.fillText('Zuri🔐', 2, 15);
    ctx.fillStyle    = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('Zuri🔐', 4, 17);
    canvasHash = simpleHash(canvas.toDataURL());
  } catch {}

  // WebGL renderer string — ties to GPU model
  let webglRenderer = 'unavailable';
  try {
    const gl  = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (ext) webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch {}

  // Installed font probe — partial fingerprint
  let fontProbe = 'unavailable';
  try {
    const testFonts = ['Arial', 'Courier New', 'Georgia', 'Helvetica', 'Times New Roman', 'Verdana'];
    const canvas2   = document.createElement('canvas');
    const ctx2      = canvas2.getContext('2d');
    const widths    = testFonts.map(f => { ctx2.font = `12px ${f}`; return ctx2.measureText('mmmmm').width; });
    fontProbe       = widths.join(',');
  } catch {}

  return {
    // Platform
    userAgent:        nav.userAgent        || '',
    platform:         nav.platform         || '',
    language:         nav.language         || '',
    languages:        (nav.languages || []).join(','),
    hardwareConcurrency: nav.hardwareConcurrency || 0,
    deviceMemory:     nav.deviceMemory     || 0,
    maxTouchPoints:   nav.maxTouchPoints   || 0,
    cookieEnabled:    nav.cookieEnabled    ? '1' : '0',
    doNotTrack:       nav.doNotTrack       || 'null',

    // Screen
    screenWidth:      scr.width            || 0,
    screenHeight:     scr.height           || 0,
    colorDepth:       scr.colorDepth       || 0,
    pixelRatio:       (window.devicePixelRatio || 1).toFixed(2),

    // Time / locale
    timezone:         Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    timezoneOffset:   new Date().getTimezoneOffset(),
    locale:           Intl.DateTimeFormat().resolvedOptions().locale   || '',

    // Graphics
    canvasHash,
    webglRenderer,
    fontProbe,

    // Connection
    connectionType:   (navigator.connection || {}).effectiveType || '',

    isEmulator: emulatorResult.isEmulator,
    emulatorSignals: emulatorResult.signals,
    emulatorConfidence: emulatorResult.confidence,
  };
}

/**
 * Simple non-cryptographic hash — fast, deterministic.
 * Used only for canvas data URL compression, NOT for security hashes.
 */
function simpleHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h  = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Compute a stable device fingerprint ID from signals.
 * Excludes volatile signals (connectionType, timezoneOffset — can change on travel).
 */
export function computeFingerprintId(signals) {
  const stable = [
    signals.userAgent,
    signals.platform,
    signals.hardwareConcurrency,
    signals.deviceMemory,
    signals.maxTouchPoints,
    signals.screenWidth,
    signals.screenHeight,
    signals.colorDepth,
    signals.pixelRatio,
    signals.canvasHash,
    signals.webglRenderer,
    signals.fontProbe,
    signals.language,
  ].join('|');
  return 'fp_' + simpleHash(stable);
}

/**
 * Compare two signal sets and return a divergence score 0–1.
 * 0 = identical, 1 = completely different.
 * Used to detect fingerprint drift (SIM swap, cloned device, browser spoof).
 */
export function computeSignalDivergence(sigA, sigB) {
  const SIGNAL_WEIGHTS = {
    canvasHash:          3.0,   // GPU-tied — very stable; change = strong anomaly
    webglRenderer:       2.5,
    fontProbe:           1.5,
    userAgent:           2.0,
    platform:            2.0,
    hardwareConcurrency: 1.0,
    deviceMemory:        1.0,
    screenWidth:         1.0,
    screenHeight:        1.0,
    colorDepth:          0.5,
    pixelRatio:          0.5,
    timezone:            1.5,   // timezone shift mid-session = suspicious
    language:            0.8,
    maxTouchPoints:      0.5,
  };

  let totalWeight = 0, mismatch = 0;
  for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    if (sigA[key] === undefined || sigB[key] === undefined) continue;
    totalWeight += weight;
    if (String(sigA[key]) !== String(sigB[key])) mismatch += weight;
  }
  return totalWeight > 0 ? mismatch / totalWeight : 0;
}

function entropyScore(signals) {
  const entropyFields = [
    signals.canvasHash,
    signals.webglRenderer,
    signals.fontProbe,
    signals.userAgent,
    signals.platform,
    signals.hardwareConcurrency,
    signals.deviceMemory,
    signals.screenWidth,
    signals.screenHeight,
    signals.colorDepth,
    signals.pixelRatio,
    signals.language,
    signals.timezone,
  ];
  const unique = new Set(entropyFields.map(value => String(value || 'unknown'))).size;
  return Math.round((unique / entropyFields.length) * 100);
}

function readLocations() {
  return lsGet(DEVICE_LOCATION_KEY) || [];
}

function writeLocations(locations) {
  lsSet(DEVICE_LOCATION_KEY, locations.slice(-20));
}

function distanceKm(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) {
    return null;
  }
  const radiusKm = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function connectionLooksLikeProxy(signals, context = {}) {
  const ua = String(signals.userAgent || '').toLowerCase();
  return Boolean(
    context.vpnDetected ||
    context.proxyDetected ||
    context.ipReputation === 'proxy' ||
    ua.includes('headless') ||
    ua.includes('phantom')
  );
}

export function recordDeviceLocation({ lat, lon, accuracy, source = 'network' } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const locations = readLocations();
  const entry = {
    lat,
    lon,
    accuracy: accuracy || null,
    source,
    timestamp: Date.now(),
  };
  locations.push(entry);
  writeLocations(locations);
  return entry;
}

export function evaluateDeviceRisk(context = {}) {
  const device = getCurrentDevice();
  const currentSignals = collectDeviceSignals();
  const trusted = isCurrentDeviceTrusted();
  const binding = verifySessionBinding();
  const signals = [];
  let score = trusted ? 0 : 20;

  const divergence = computeSignalDivergence(device.signals || currentSignals, currentSignals);
  if (divergence > FINGERPRINT_DRIFT_THRESHOLD) {
    score += 25;
    signals.push({ code: 'fingerprint_drift', severity: 'high', detail: `Signal divergence ${(divergence * 100).toFixed(0)}%` });
  }

  if (!binding.valid && binding.anomalies?.length) {
    score += 20;
    binding.anomalies.forEach(code => signals.push({ code, severity: 'medium', detail: 'Session binding anomaly' }));
  }

  if (device.lastTimezone && device.lastTimezone !== currentSignals.timezone) {
    score += 12;
    signals.push({ code: 'timezone_mismatch', severity: 'medium', detail: `${device.lastTimezone} -> ${currentSignals.timezone}` });
  }

  const deviceAgeMs = Date.now() - (device.firstSeenAt || Date.now());
  if (deviceAgeMs < 24 * 60 * 60 * 1000) {
    score += 12;
    signals.push({ code: 'new_device_age', severity: 'medium', detail: 'Device younger than 24h' });
  } else if (deviceAgeMs > 30 * 24 * 60 * 60 * 1000 && trusted) {
    score = Math.max(0, score - 8);
  }

  const entropy = entropyScore(currentSignals);
  if (entropy < 55) {
    score += 10;
    signals.push({ code: 'low_browser_entropy', severity: 'medium', detail: `Entropy ${entropy}` });
  }

  if (connectionLooksLikeProxy(currentSignals, context)) {
    score += 18;
    signals.push({ code: 'vpn_proxy_suspicion', severity: 'high', detail: 'Proxy/VPN indicators present' });
  }

  if (currentSignals.isEmulator) {
    score += 25;
    signals.push({ code: 'emulator_or_bot_detected', severity: 'high', detail: 'Emulator or automation indicators' });
  }

  if (context.simSwapSignal) {
    score += 30;
    signals.push({ code: 'sim_swap_indicator', severity: 'critical', detail: 'SIM or device change signal present' });
  }

  if (context.location) {
    const previous = readLocations().slice(-1)[0];
    const currentLocation = recordDeviceLocation(context.location);
    const km = distanceKm(previous, currentLocation);
    const hours = previous && currentLocation ? (currentLocation.timestamp - previous.timestamp) / 3600000 : null;
    if (km !== null && hours > 0) {
      const speed = km / hours;
      if (speed > IMPOSSIBLE_TRAVEL_KMH) {
        score += 28;
        signals.push({ code: 'impossible_travel', severity: 'critical', detail: `${Math.round(speed)} km/h travel velocity` });
      } else if (km > 250) {
        score += 10;
        signals.push({ code: 'geolocation_shift', severity: 'medium', detail: `${Math.round(km)} km from last location` });
      }
    }
  }

  const clamped = Math.min(100, Math.max(0, Math.round(score)));
  const level = clamped >= 75 ? 'critical' : clamped >= 55 ? 'high' : clamped >= 25 ? 'medium' : 'low';
  const result = {
    score: clamped,
    level,
    trusted,
    fingerprintId: device.fingerprintId,
    entropy,
    divergence,
    signals,
    authEscalation: clamped >= 75 ? ['pin', 'face', 'webauthn'] : clamped >= 45 ? ['pin', 'face'] : ['pin'],
    fraudSensitivityBump: clamped >= 75 ? 25 : clamped >= 45 ? 12 : clamped >= 25 ? 5 : 0,
    transactionThrottle: clamped >= 65,
    settlementDelayMs: clamped >= 75 ? 2 * 60 * 1000 : 0,
  };

  appendRiskEvent({
    type: 'device_risk_evaluated',
    level,
    score: clamped,
    signals: signals.map(signal => signal.code),
  });

  updateCurrentDevice({
    signals: currentSignals,
    lastTimezone: currentSignals.timezone,
    lastUserAgent: currentSignals.userAgent,
    lastPlatform: currentSignals.platform,
  });

  return result;
}

// ── Current Device ────────────────────────────────────────────────────────────

/**
 * Get or create the persistent current-device record.
 * First call initialises and stores it; subsequent calls return the stored record.
 */
export function getCurrentDevice() {
  let device = lsGet(CURRENT_DEVICE_KEY);
  if (!device) {
    const signals = collectDeviceSignals();
    device = {
      fingerprintId: computeFingerprintId(signals),
      signals,
      firstSeenAt:   Date.now(),
      lastSeenAt:    Date.now(),
      sessionCount:  1,
      isTrusted:     false,
      authSuccessCount: 0,
      authFailureCount: 0,
      lastBiometricAuth: null,
      lastPinAuth:       null,
      // SIM-swap tracking
      lastTimezone:  signals.timezone,
      lastUserAgent: signals.userAgent,
      lastPlatform:  signals.platform,
    };
    lsSet(CURRENT_DEVICE_KEY, device);
  } else {
    // Refresh volatile fields
    device.lastSeenAt = Date.now();
    device.sessionCount = (device.sessionCount || 0) + 1;
    lsSet(CURRENT_DEVICE_KEY, device);
  }
  return device;
}

export function updateCurrentDevice(patch) {
  const device = getCurrentDevice();
  const updated = { ...device, ...patch };
  lsSet(CURRENT_DEVICE_KEY, updated);
  return updated;
}

// ── Trusted Device Registry ───────────────────────────────────────────────────

export function getTrustedDevices() {
  return lsGet(TRUSTED_DEVICES_KEY) || [];
}

/**
 * Trust the current device. Evicts oldest entry if registry is full.
 */
export function trustCurrentDevice(label = 'My Device') {
  const devices = getTrustedDevices();
  const device  = getCurrentDevice();

  const existing = devices.findIndex(d => d.fingerprintId === device.fingerprintId);
  if (existing >= 0) {
    devices[existing].trusted = true;
    devices[existing].lastSeenAt = Date.now();
  } else {
    if (devices.length >= MAX_TRUSTED_DEVICES) {
      // Evict the oldest-seen device
      devices.sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0));
      devices.shift();
    }
    devices.push({
      fingerprintId: device.fingerprintId,
      label,
      trusted:       true,
      addedAt:       Date.now(),
      lastSeenAt:    Date.now(),
    });
  }

  lsSet(TRUSTED_DEVICES_KEY, devices);
  updateCurrentDevice({ isTrusted: true });
  emit('DEVICE_TRUSTED', { fingerprintId: device.fingerprintId });
  return devices;
}

export function revokeDeviceTrust(fingerprintId) {
  const devices = getTrustedDevices().filter(d => d.fingerprintId !== fingerprintId);
  lsSet(TRUSTED_DEVICES_KEY, devices);
  if (getCurrentDevice().fingerprintId === fingerprintId) {
    updateCurrentDevice({ isTrusted: false });
  }
  emit('DEVICE_REVOKED', { fingerprintId });
}

export function isCurrentDeviceTrusted() {
  const device  = getCurrentDevice();
  const trusted = getTrustedDevices();
  return trusted.some(d => d.fingerprintId === device.fingerprintId && d.trusted);
}

// ── Session Binding ───────────────────────────────────────────────────────────

/**
 * Bind the current session to the current device fingerprint.
 * Called once on login. Subsequent checks ensure the fingerprint hasn't drifted.
 */
export function bindSession() {
  const device = getCurrentDevice();
  const binding = {
    fingerprintId:  device.fingerprintId,
    signals:        device.signals,
    boundAt:        Date.now(),
    sessionToken:   crypto.randomUUID?.() || `st_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  };
  ssSet(SESSION_BINDING_KEY, binding);
  return binding;
}

/**
 * Verify the current session binding.
 * Returns { valid, divergence, anomalies }
 */
export function verifySessionBinding() {
  const binding = ssGet(SESSION_BINDING_KEY);
  if (!binding) return { valid: false, divergence: 1, anomalies: ['no_session_binding'] };

  const currentSignals = collectDeviceSignals();
  const divergence     = computeSignalDivergence(binding.signals, currentSignals);
  const anomalies      = [];

  if (divergence > FINGERPRINT_DRIFT_THRESHOLD) anomalies.push('fingerprint_drift');
  if (binding.signals.timezone !== currentSignals.timezone) anomalies.push('timezone_shift');
  if (binding.signals.userAgent !== currentSignals.userAgent) anomalies.push('useragent_change');
  if (binding.signals.platform  !== currentSignals.platform)  anomalies.push('platform_change');

  return {
    valid:      divergence <= FINGERPRINT_DRIFT_THRESHOLD,
    divergence,
    anomalies,
  };
}

// ── Step-up Challenge Tokens ──────────────────────────────────────────────────

/**
 * Issue a step-up challenge token (e.g. before high-risk transaction).
 * Token expires in 5 minutes and can only be consumed once (replay protection).
 */
export function issueStepUpChallenge(reason = 'high_risk') {
  const challenge = {
    token:     crypto.randomUUID?.() || `ch_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    reason,
    issuedAt:  Date.now(),
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    consumed:  false,
  };
  ssSet(CHALLENGE_KEY, challenge);
  return challenge;
}

/**
 * Consume a step-up challenge token.
 * Returns { valid, reason } — token becomes invalid after consumption.
 */
export function consumeStepUpChallenge(token) {
  const challenge = ssGet(CHALLENGE_KEY);
  if (!challenge)                         return { valid: false, reason: 'no_challenge' };
  if (challenge.consumed)                 return { valid: false, reason: 'already_consumed' };
  if (challenge.token !== token)          return { valid: false, reason: 'token_mismatch' };
  if (Date.now() > challenge.expiresAt)   return { valid: false, reason: 'expired' };

  challenge.consumed   = true;
  challenge.consumedAt = Date.now();
  ssSet(CHALLENGE_KEY, challenge);
  return { valid: true, reason: challenge.reason };
}

export function hasPendingChallenge() {
  const c = ssGet(CHALLENGE_KEY);
  return !!(c && !c.consumed && Date.now() < c.expiresAt);
}

// ── Auth tracking ──────────────────────────────────────────────────────────────

export function recordSuccessfulBiometricAuth() {
  const device = getCurrentDevice();
  return updateCurrentDevice({
    lastBiometricAuth:  new Date().toISOString(),
    authSuccessCount:   (device.authSuccessCount || 0) + 1,
    isTrusted:          (device.authSuccessCount || 0) + 1 >= 3,
  });
}

export function recordSuccessfulPinAuth() {
  return updateCurrentDevice({ lastPinAuth: new Date().toISOString() });
}

export function recordAuthFailure() {
  const device = getCurrentDevice();
  const failures = (device.authFailureCount || 0) + 1;
  const patch = { authFailureCount: failures };
  if (failures > 5) { patch.isTrusted = false; patch.authFailureCount = 0; }
  return updateCurrentDevice(patch);
}

export function shouldSkipBiometricPrompt() {
  const device = getCurrentDevice();
  if (!device.isTrusted || !device.lastBiometricAuth) return false;
  return (Date.now() - new Date(device.lastBiometricAuth).getTime()) < 10 * 60 * 1000;
}

// ── Risk History ──────────────────────────────────────────────────────────────

export function appendRiskEvent(event) {
  const history = lsGet(RISK_HISTORY_KEY) || [];
  history.push({ ...event, ts: Date.now() });
  if (history.length > RISK_HISTORY_LIMIT) history.splice(0, history.length - RISK_HISTORY_LIMIT);
  lsSet(RISK_HISTORY_KEY, history);
}

export function getRiskHistory() {
  return lsGet(RISK_HISTORY_KEY) || [];
}

// ── Convenience getters (backward compat) ─────────────────────────────────────

export function getDeviceTrust() {
  return getCurrentDevice();
}

export function initializeDeviceTrust() {
  return getCurrentDevice();
}

export function getDeviceInfo() {
  const d = getCurrentDevice();
  return {
    deviceId:          d.fingerprintId,
    isTrusted:         d.isTrusted || isCurrentDeviceTrusted(),
    isRecognized:      isCurrentDeviceTrusted(),
    successCount:      d.authSuccessCount || 0,
    failureCount:      d.authFailureCount || 0,
    enrolledAt:        d.firstSeenAt ? new Date(d.firstSeenAt).toISOString() : null,
    lastBiometricAuth: d.lastBiometricAuth,
    lastPinAuth:       d.lastPinAuth,
  };
}

export function clearDeviceTrust() {
  try { localStorage.removeItem(CURRENT_DEVICE_KEY); sessionStorage.removeItem(SESSION_BINDING_KEY); return { success: true }; }
  catch { return { success: false }; }
}

export function resetDeviceTrust() {
  clearDeviceTrust();
  return getCurrentDevice();
}
