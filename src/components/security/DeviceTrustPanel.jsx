/**
 * Zuri Connect Africa — Device Trust Panel
 *
 * Displays:
 *   - Current device fingerprint + trust status
 *   - Server-authoritative trusted-device registry (security-devices Edge
 *     Function). The legacy localStorage registry is preserved as a UX cache
 *     but is NO LONGER the source of truth.
 *   - SIM-swap risk summary
 *   - Revoke trust controls — these now mutate the server deny-list (and the
 *     local registry for the calling device) and surface an honest message
 *     about the Supabase auth limitation on per-device refresh-token revoke.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  Plus,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import {
  getCurrentDevice,
  trustCurrentDevice,
  revokeDeviceTrust,
  isCurrentDeviceTrusted,
} from '@/lib/deviceTrust';
import {
  listDevices,
  trustCurrentDeviceServer,
  revokeDeviceServer,
} from '@/lib/security/deviceSessions';
import { getSimSwapSummary, evaluateSimSwapRisk, RISK_LEVEL } from '@/lib/simSwapDetector';
import { toast } from '@/components/ui/use-toast';

function formatLastSeen(iso) {
  if (!iso) return '';
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

export default function DeviceTrustPanel() {
  const [currentDevice, setCurrentDevice] = useState(null);
  const [serverDevices, setServerDevices] = useState([]);
  const [serverDevicesLoading, setServerDevicesLoading] = useState(false);
  const [serverDevicesUnavailable, setServerDevicesUnavailable] = useState(false);
  const [simSummary, setSimSummary] = useState(null);
  const [riskResult, setRiskResult] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingDeviceId, setPendingDeviceId] = useState(null);

  function loadLocal() {
    setCurrentDevice(getCurrentDevice());
    setSimSummary(getSimSwapSummary());
    setRiskResult(evaluateSimSwapRisk());
  }

  const loadServer = useCallback(async () => {
    setServerDevicesLoading(true);
    try {
      const res = await listDevices();
      if (res?.ok && Array.isArray(res.devices)) {
        setServerDevices(res.devices);
        setServerDevicesUnavailable(false);
      } else {
        setServerDevices([]);
        setServerDevicesUnavailable(true);
      }
    } catch {
      setServerDevices([]);
      setServerDevicesUnavailable(true);
    } finally {
      setServerDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLocal();
    loadServer();
  }, [loadServer]);

  async function handleTrustDevice() {
    // Local optimistic update so the UI updates immediately. The server call
    // below is the authoritative one — if it fails we surface that explicitly
    // and don't pretend the device is registered everywhere.
    trustCurrentDevice('This Device');
    loadLocal();
    const res = await trustCurrentDeviceServer({ label: 'This Device' });
    if (res?.ok) {
      toast({
        title: 'Device trusted',
        description: 'This device is registered on the server. You will see fewer step-up prompts here.',
      });
      loadServer();
    } else {
      toast({
        title: 'Device trusted on this device only',
        description:
          'Server registration is unavailable right now — local trust applied. We will retry the next time you connect.',
      });
    }
  }

  async function handleRevokeServer(device) {
    if (!device?.id) return;
    setPendingDeviceId(device.id);
    try {
      const res = await revokeDeviceServer({ deviceId: device.id });
      if (res?.ok) {
        // If we revoked the calling device, clear local trust too so the next
        // sensitive action on this device demands a fresh proof.
        if (device.is_current && currentDevice?.fingerprintId) {
          revokeDeviceTrust(currentDevice.fingerprintId);
        }
        loadLocal();
        loadServer();
        toast({
          title: 'Device trust revoked',
          description:
            'Local trust cleared on the server. Remote sessions are not signed out automatically — the device may remain signed in until its refresh token expires (Supabase auth limitation).',
        });
        return;
      }
      toast({
        title: 'Revoke failed',
        description: 'We could not revoke this device. Please try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      setPendingDeviceId(null);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.allSettled([
      new Promise((r) => setTimeout(r, 400)),
      loadServer(),
    ]);
    loadLocal();
    setRefreshing(false);
  }

  const isTrusted = isCurrentDeviceTrusted();

  const riskColors = {
    [RISK_LEVEL.LOW]:      { color: 'text-primary',   bg: 'bg-primary/10',   border: 'border-primary/20'   },
    [RISK_LEVEL.MEDIUM]:   { color: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/20' },
    [RISK_LEVEL.HIGH]:     { color: 'text-red-400',   bg: 'bg-red-400/10',   border: 'border-red-400/20'   },
    [RISK_LEVEL.CRITICAL]: { color: 'text-red-400',   bg: 'bg-red-400/12',   border: 'border-red-400/25'   },
  };
  const riskCfg = riskColors[riskResult?.level || RISK_LEVEL.LOW];

  const activeServerDevices = serverDevices.filter((d) => !d.revoked_at);

  return (
    <div className="space-y-3">
      {/* SIM Swap Risk Summary */}
      {riskResult && (
        <div className={`glass-card rounded-2xl px-4 py-3.5 border ${riskCfg.border} ${riskCfg.bg}`}>
          <div className="flex items-center gap-2.5 mb-2">
            {riskResult.level === RISK_LEVEL.LOW ? (
              <ShieldCheck size={15} className={riskCfg.color} />
            ) : (
              <ShieldAlert size={15} className={riskCfg.color} />
            )}
            <div className="flex-1">
              <p className={`text-[12px] font-bold ${riskCfg.color}`}>
                SIM Swap Shield — {riskResult.level === RISK_LEVEL.LOW ? 'All Clear' : riskResult.level}
              </p>
              <p className="text-[10px] text-muted-foreground">
                Risk score: {riskResult.score}/100 · {simSummary?.eventsLast24h || 0} events (24h)
              </p>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              aria-label="Refresh device trust"
              className="w-7 h-7 rounded-lg bg-white/6 flex items-center justify-center"
            >
              <RefreshCw size={11} className={`text-muted-foreground ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {riskResult.signals.length > 0 && (
            <div className="space-y-1 mt-2">
              {riskResult.signals.slice(0, 3).map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <AlertTriangle size={9} className="text-amber-400 shrink-0" />
                  <p className="text-[10px] text-muted-foreground">{s.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Current device */}
      {currentDevice && (
        <div className="glass-card rounded-2xl border border-white/6 overflow-hidden">
          <div className="px-4 py-3 flex items-center gap-3 border-b border-white/5">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${isTrusted ? 'bg-primary/10' : 'bg-white/6'}`}>
              <Smartphone size={14} className={isTrusted ? 'text-primary' : 'text-muted-foreground'} />
            </div>
            <div className="flex-1">
              <p className="text-[13px] font-semibold text-foreground">This Device</p>
              <p className="text-[10px] text-muted-foreground font-mono">{currentDevice.fingerprintId?.slice(0, 18)}…</p>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isTrusted ? 'bg-primary/10 text-primary border border-primary/20' : 'bg-white/8 text-muted-foreground border border-white/10'}`}>
              {isTrusted ? 'Trusted' : 'Unverified'}
            </span>
          </div>
          <div className="px-4 py-2 grid grid-cols-3 gap-2">
            {[
              { label: 'Sessions', value: currentDevice.sessionCount || 1 },
              { label: 'Auth OK',  value: currentDevice.authSuccessCount || 0 },
              { label: 'Failures', value: currentDevice.authFailureCount || 0 },
            ].map(s => (
              <div key={s.label} className="text-center py-1.5">
                <p className="text-sm font-bold text-foreground">{s.value}</p>
                <p className="text-[9px] text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>
          {!isTrusted && (
            <div className="px-4 pb-3">
              <button
                type="button"
                onClick={handleTrustDevice}
                aria-label="Trust this device on the server"
                className="w-full py-2.5 rounded-xl gradient-green text-black text-[12px] font-bold flex items-center justify-center gap-1.5"
              >
                <Plus size={12} /> Trust This Device
              </button>
            </div>
          )}
        </div>
      )}

      {/* Server-authoritative registry */}
      <div>
        <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">
          Trusted Devices ({activeServerDevices.length})
        </p>
        <div className="glass-card rounded-2xl border border-white/6 overflow-hidden">
          {serverDevicesLoading && activeServerDevices.length === 0 ? (
            <div className="px-4 py-5 text-center">
              <RefreshCw size={16} className="text-muted-foreground/40 mx-auto mb-2 animate-spin" />
              <p className="text-[11px] text-muted-foreground">Loading registered devices…</p>
            </div>
          ) : activeServerDevices.length === 0 ? (
            <div className="px-4 py-5 text-center">
              <Shield size={20} className="text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-[12px] text-muted-foreground">
                {serverDevicesUnavailable
                  ? 'Device registry unavailable. Sign in and try again to see your registered devices.'
                  : 'No trusted devices registered. Trust this device to reduce auth friction.'}
              </p>
            </div>
          ) : (
            activeServerDevices.map((d, i) => (
              <div
                key={d.id}
                className={`flex items-center gap-3 px-4 py-3 ${i < activeServerDevices.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div className="w-7 h-7 rounded-lg bg-primary/8 flex items-center justify-center shrink-0">
                  <Shield size={12} className="text-primary" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[12px] font-medium text-foreground">{d.device_label || 'Device'}</p>
                    {d.is_current && (
                      <span className="text-[9px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
                        Current
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Last seen {formatLastSeen(d.last_seen_at) || 'recently'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRevokeServer(d)}
                  disabled={pendingDeviceId === d.id}
                  aria-label={`Revoke trust for ${d.device_label || 'this device'}`}
                  className="w-7 h-7 rounded-lg bg-red-400/8 flex items-center justify-center disabled:opacity-50"
                >
                  <Trash2 size={11} className="text-red-400" />
                </button>
              </div>
            ))
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
          Revoking a device clears its server trust and blocks future sensitive actions on it. An active session may
          remain until its refresh token expires (Supabase auth limitation) — sign out from that device for an
          immediate effect.
        </p>
      </div>
    </div>
  );
}
