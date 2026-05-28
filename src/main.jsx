import { runStartupValidation, renderStartupBlockedRootHtml } from '@/config/validateEnv.js';
import { METRICS, track } from '@/lib/observability/metrics.js';
import { isDemoFallbackActive } from '@/lib/demoMode/index.js';
import { bootInfo } from '@/lib/devLog.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/index.css';

if (typeof document !== 'undefined') {
  document.addEventListener('securitypolicyviolation', (e) => {
    try {
      track(METRICS.CSP_VIOLATION, 1, {
        violatedDirective: e.violatedDirective,
        blockedURI: String(e.blockedURI || '').slice(0, 256),
      });
    } catch {
      /* ignore */
    }
  });
}

const startup = runStartupValidation(import.meta.env, { mode: import.meta.env.MODE });

const rootEl = document.getElementById('root');

if (startup.shouldBlockApp) {
  rootEl.innerHTML = renderStartupBlockedRootHtml(startup);
} else {
  if (isDemoFallbackActive()) {
    try {
      track(METRICS.DEMO_FALLBACK_BOOT, 1);
    } catch {
      /* ignore */
    }
  }

  (async () => {
    try {
      bootInfo('[Zuri:Boot] env ok, loading App module');
      const { default: App } = await import('@/App.jsx');
      bootInfo('[Zuri:Boot] App module loaded, creating root');
      ReactDOM.createRoot(rootEl).render(<App />);
      bootInfo('[Zuri:Boot] React root render invoked');
    } catch (err) {
      console.error('[Zuri:Boot] Fatal bootstrap error', err);
      rootEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui;padding:24px;background:#0a0a0a;color:#fafafa;">
          <div style="max-width:360px;text-align:center;">
            <p style="font-weight:600;margin-bottom:8px;">Unable to start app</p>
            <p style="font-size:13px;opacity:0.8;margin-bottom:16px;">Zuri Connect Africa could not complete startup. Please reload to try again.</p>
            <button type="button" onclick="location.reload()" style="padding:10px 20px;border-radius:12px;border:none;background:#2ecc71;color:#000;font-weight:600;cursor:pointer;">Reload</button>
          </div>
        </div>`;
    }
  })();
}
