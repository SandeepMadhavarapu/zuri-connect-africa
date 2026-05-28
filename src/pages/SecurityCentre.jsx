import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck, AlertTriangle, Lock, Smartphone,
  Clock, ChevronRight, CheckCircle2,
  Fingerprint, RefreshCw, Shield,
  ShieldAlert, Zap, Gift, UserX, DollarSign, AlertCircle, Phone, Info
} from 'lucide-react';
import { getRecentThreats } from '@/lib/scamTelemetry';
import DeviceTrustPanel from '@/components/security/DeviceTrustPanel';
import { useNavigate } from 'react-router-dom';
import { toast } from '@/components/ui/use-toast';
import {
  listDevices as listServerDevices,
  revokeDeviceServer,
} from '@/lib/security/deviceSessions';
import { useAuth } from '@/lib/AuthContext';

// ── Scam education cards ──────────────────────────────────────────────────────

const SCAM_CARDS = [
  {
    icon: Phone,
    iconFallback: Smartphone,
    title: 'Wrong Number Scam',
    color: 'text-blue-400',
    bg: 'bg-blue-400/8',
    border: 'border-blue-400/15',
    how: 'Someone sends you money, then claims it was a mistake and asks you to "return" it to a different number. The original transfer may have used stolen funds.',
    signs: ['You receive money from a stranger', 'They immediately ask you to send it elsewhere', "They're unusually urgent or emotional"],
    what: 'Call Safaricom on 100. Never send money to a third number based on a message alone.',
  },
  {
    icon: AlertCircle,
    iconFallback: Zap,
    title: 'Emergency Scam',
    color: 'text-amber-400',
    bg: 'bg-amber-400/8',
    border: 'border-amber-400/15',
    how: 'A caller pretends to be a relative or friend in an emergency — accident, hospital, police — and pressures you to send money immediately before you can verify.',
    signs: ['Unexpected call about a family emergency', 'They ask you not to call anyone else', 'They demand fast payment to an unknown number'],
    what: 'Hang up. Call the person directly on their known number. Real emergencies allow time to verify.',
  },
  {
    icon: Gift,
    iconFallback: Gift,
    title: 'Prize & Lottery Scam',
    color: 'text-primary',
    bg: 'bg-primary/8',
    border: 'border-primary/15',
    how: "You receive a message saying you've won a prize, cash, or phone. To \"claim\" it, you must first pay a processing fee, tax, or registration fee.",
    signs: ['"Hongera! Umeshinda…" messages', 'Requests to deposit money first', 'Safaricom or company impersonation'],
    what: 'Legitimate prizes never require payment. Block and report the number immediately.',
  },
  {
    icon: UserX,
    iconFallback: UserX,
    title: 'Safaricom Agent Impersonation',
    color: 'text-violet-400',
    bg: 'bg-violet-400/8',
    border: 'border-violet-400/15',
    how: 'A scammer poses as a Safaricom customer service agent and asks for your PIN, OTP, or personal details to "resolve an account issue" or "unlock your line".',
    signs: ['Unexpected call from "Safaricom support"', 'Request for your M-PESA PIN or OTP', 'Threats of line suspension'],
    what: 'Safaricom will NEVER ask for your PIN. Hang up and call the real Safaricom on 100.',
  },
  {
    icon: DollarSign,
    iconFallback: DollarSign,
    title: 'Advance Fee Scam',
    color: 'text-red-400',
    bg: 'bg-red-400/8',
    border: 'border-red-400/15',
    how: 'A stranger promises a large payment, investment return, or business deal — but you must first send a small "advance fee" to unlock it. The large payment never arrives.',
    signs: ['Too-good-to-be-true returns promised', 'Small payment required upfront', 'Requests to keep it secret'],
    what: 'No legitimate investment or business deal requires upfront payment via M-PESA to a stranger.',
  },
];

// ── Scam education card component ─────────────────────────────────────────────

function ScamCard({ card, index }) {
  const [expanded, setExpanded] = useState(false);
  const IconComponent = card.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.3, ease: 'easeOut' }}
      className={`glass-card rounded-2xl overflow-hidden mb-3 ${card.border}`}
      style={{ border: `1px solid` }}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-3 px-4 py-3.5 w-full text-left"
      >
        <div className={`w-9 h-9 rounded-xl ${card.bg} flex items-center justify-center shrink-0`}>
          <IconComponent size={16} className={card.color} />
        </div>
        <div className="flex-1">
          <p className="text-[13px] font-semibold text-foreground">{card.title}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{expanded ? 'Tap to collapse' : 'Tap to learn more'}</p>
        </div>
        <motion.div animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.2 }}>
          <ChevronRight size={14} className="text-muted-foreground" />
        </motion.div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="pt-3">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">How it works</p>
                <p className="text-[12px] text-foreground/80 leading-relaxed">{card.how}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Warning signs</p>
                {card.signs.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 py-0.5">
                    <AlertTriangle size={10} className={`${card.color} shrink-0 mt-1`} />
                    <p className="text-[12px] text-foreground/75">{s}</p>
                  </div>
                ))}
              </div>
              <div className={`${card.bg} rounded-xl px-3 py-2.5`} style={{ border: `1px solid`, borderColor: card.border }}>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'inherit' }}>What to do</p>
                <p className={`text-[12px] font-medium ${card.color} leading-relaxed`}>{card.what}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Scam Shield section ────────────────────────────────────────────────────────

function ScamShieldSection() {
  const threats = getRecentThreats(10);

  const categoryLabel = {
    lottery: 'Prize / Lottery Scam',
    urgency: 'Urgency Pressure',
    reversal: 'Reversal Scam',
    impersonation: 'Impersonation Attempt',
    velocity: 'Transaction Velocity Alert',
    device: 'Device Anomaly',
    graph: 'Suspicious Recipient',
    generic: 'General Fraud Alert',
  };

  const actionLabel = {
    proceeded: 'Proceeded after review',
    cancelled: 'Transaction cancelled',
    blocked: 'Automatically blocked',
    warned: 'Warning shown',
  };

  const formatTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-xl bg-primary/10 flex items-center justify-center">
          <Shield size={14} className="text-primary" />
        </div>
        <div>
          <p className="text-[13px] font-bold text-foreground">Scam Shield — Stay Alert</p>
          <p className="text-[10px] text-muted-foreground">Scam education and recent on-device alerts</p>
        </div>
      </div>

      {/* Recent alerts */}
      {threats.length > 0 ? (
        <div className="mb-4">
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">Recent Shield Activity</p>
          <div className="glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            {threats.slice(0, 5).map((t, i) => (
              <div key={i} className={`flex items-start gap-3 px-4 py-3 ${i < Math.min(threats.length, 5) - 1 ? 'border-b border-white/5' : ''}`}>
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                  t.eventType === 'fraud_blocked' ? 'bg-red-400/10' : 'bg-amber-400/10'
                }`}>
                  {t.eventType === 'fraud_blocked'
                    ? <ShieldOff size={12} className="text-red-400" />
                    : <AlertTriangle size={12} className="text-amber-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-foreground">
                    {categoryLabel[t.scamCategory] || 'Fraud Alert'}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {actionLabel[t.userAction] || t.userAction}
                    {t.amountBand && t.amountBand !== 'unknown' ? ` · KSh ${t.amountBand}` : ''}
                  </p>
                </div>
                <p className="text-[10px] text-muted-foreground shrink-0">{formatTime(t.timestamp)}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="glass-card rounded-2xl px-4 py-4 mb-4 flex items-center gap-3"
          style={{ border: '1px solid rgba(46,204,113,0.12)' }}>
          <ShieldCheck size={16} className="text-primary shrink-0" />
          <div>
            <p className="text-[13px] font-semibold text-foreground">No threats detected this session</p>
            <p className="text-[11px] text-muted-foreground">Scam Shield monitors transaction patterns this session.</p>
          </div>
        </div>
      )}

      {/* Scam education */}
      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-3">Know Your Threats</p>
      {SCAM_CARDS.map((card, i) => (
        <ScamCard key={card.title} card={card} index={i} />
      ))}

      <div className="glass-card rounded-xl px-4 py-3 mt-1" style={{ borderColor: 'rgba(46,204,113,0.10)' }}>
        <p className="text-[11px] text-muted-foreground leading-relaxed text-center">
          Stay informed. Real M-PESA support never asks for your PIN, OTP, or password. When in doubt, hang up and dial *234#.
        </p>
      </div>
    </div>
  );
}

// ── Dummy ShieldOff import workaround (inline) ────────────────────────────────
function ShieldOff({ size, className }) {
  return <ShieldAlert size={size} className={className} />;
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SecurityCentre() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    setTimeout(() => {
      setRefreshing(false);
      toast({ title: 'Security view refreshed' });
    }, 600);
  };

  const simSub = user?.phone
    ? `Bound to your verified phone ···${user.phone.slice(-4)}`
    : 'Bound to your verified phone';

  return (
    <div className="px-4 py-4 pb-8">
      {/* Status header */}
      <div className="glass-card rounded-2xl p-4 mb-4 flex items-center gap-3"
        style={{ border: '1px solid rgba(46,204,113,0.15)' }}>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary/10">
          <ShieldCheck size={18} className="text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-[13px] font-semibold text-foreground">Account protected</p>
          <p className="text-[11px] text-muted-foreground">Your security overview</p>
        </div>
        <button onClick={handleRefresh} className="w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center">
          <RefreshCw size={13} className={`text-muted-foreground ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 glass-card rounded-xl p-1">
        {[
          ['overview',  'Overview'],
          ['devices',   'Devices'],
          ['scamshield','Scam Shield'],
          ['sessions',  'Sessions'],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)}
            className={`flex-1 py-2 rounded-lg text-[11px] font-semibold transition-all ${
              activeTab === key ? 'bg-primary text-black' : 'text-muted-foreground'
            }`}>
            {label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'overview' && (
          <motion.div key="ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">Authentication Methods</p>
            <div className="glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
              {[
                { icon: Fingerprint, label: 'Biometric',       sub: 'Face ID + Fingerprint', active: true },
                { icon: Lock,        label: 'M-PESA PIN',       sub: '6-digit secure PIN',    active: true },
                { icon: Smartphone,  label: 'SIM Verification', sub: simSub,                  active: true },
              ].map((m, i) => {
                const Icon = m.icon;
                return (
                  <div key={m.label} className={`flex items-center gap-3 px-4 py-3.5 ${i < 2 ? 'border-b border-white/5' : ''}`}>
                    <div className="w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center shrink-0">
                      <Icon size={14} className="text-primary" />
                    </div>
                    <div className="flex-1">
                      <p className="text-[13px] font-medium text-foreground">{m.label}</p>
                      <p className="text-[11px] text-muted-foreground">{m.sub}</p>
                    </div>
                    <CheckCircle2 size={14} className="text-primary" />
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {activeTab === 'devices' && (
          <motion.div key="dev" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">Device Trust & SIM Swap Shield</p>
            <DeviceTrustPanel />
          </motion.div>
        )}

        {activeTab === 'scamshield' && (
          <motion.div key="ss" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ScamShieldSection />
          </motion.div>
        )}

        {activeTab === 'sessions' && (
          <motion.div key="sess" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <SessionsPanel />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Sessions tab ─────────────────────────────────────────────────────────────
// Real backend wire-up: trusted devices are loaded from the `security-devices`
// Edge Function (service role + RLS-protected `trusted_devices` table). The
// Revoke button mutates the server deny-list which is then consulted by every
// sensitive Edge Function before completing a step-up.
//
// Limitation we surface honestly: Supabase Edge Functions cannot selectively
// revoke another device's refresh token, so the device may remain signed in
// until its token expires. The deny-list still prevents new sensitive actions.

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

function SessionsPanel() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [pendingId, setPendingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listServerDevices();
      if (res?.ok && Array.isArray(res.devices)) {
        setDevices(res.devices);
        setUnavailable(false);
      } else {
        setDevices([]);
        setUnavailable(true);
      }
    } catch {
      setDevices([]);
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRevoke(device) {
    if (!device?.id) return;
    setPendingId(device.id);
    try {
      const res = await revokeDeviceServer({ deviceId: device.id });
      if (res?.ok) {
        toast({
          title: 'Device trust revoked',
          description:
            'Device removed from the trusted registry. Remote sessions are not signed out automatically — the device may remain signed in until its refresh token expires (Supabase auth limitation), but any sensitive action will be blocked.',
        });
        load();
        return;
      }
      toast({
        title: 'Revoke failed',
        description: 'We could not revoke this device. Please try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      setPendingId(null);
    }
  }

  const activeDevices = devices.filter((d) => !d.revoked_at);

  return (
    <>
      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">
        Active & Recent Sessions
      </p>

      {activeDevices.length > 0 ? (
        <div
          className="glass-card rounded-2xl overflow-hidden mb-3"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {activeDevices.map((d, i) => (
            <div
              key={d.id}
              className={`flex items-start gap-3 px-4 py-3.5 ${
                i < activeDevices.length - 1 ? 'border-b border-white/5' : ''
              }`}
            >
              <div
                className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                  d.is_current ? 'bg-primary/12' : 'bg-white/5'
                }`}
              >
                <Smartphone size={14} className={d.is_current ? 'text-primary' : 'text-muted-foreground'} />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium text-foreground">{d.device_label || 'Device'}</p>
                  {d.is_current && (
                    <span className="text-[9px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
                      Current
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Clock size={10} className="text-muted-foreground" />
                  <p className="text-[11px] text-muted-foreground">
                    Last seen {formatLastSeen(d.last_seen_at) || 'recently'}
                  </p>
                </div>
              </div>
              {!d.is_current && (
                <button
                  type="button"
                  onClick={() => handleRevoke(d)}
                  disabled={pendingId === d.id}
                  aria-label={`Revoke ${d.device_label || 'this device'}`}
                  className="text-[10px] font-semibold text-red-400 bg-red-400/10 px-2.5 py-1 rounded-lg border border-red-400/20 disabled:opacity-50"
                  title="Revoke server trust for this device"
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="glass-card rounded-2xl px-4 py-6 mb-3 flex items-center gap-3"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <Smartphone size={16} className="text-muted-foreground shrink-0" />
          <p className="text-[13px] text-muted-foreground">
            No active sessions on file yet. New sign-ins will appear here.
          </p>
        </div>
      )}

      <div
        className="glass-card rounded-xl px-4 py-3 mb-3 flex items-start gap-2"
        style={{ borderColor: 'rgba(240,165,0,0.18)' }}
      >
        <Info size={12} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Device trust is server-managed. Revoking blocks future sensitive actions on that device, but the
          active session may remain until the refresh token expires (Supabase auth limitation). For an
          immediate effect, sign out from that device or contact Zuri support on *234#.
          {loading && <span className="ml-1 opacity-70">Refreshing…</span>}
          {unavailable && <span className="ml-1 opacity-70">Device registry unavailable.</span>}
        </p>
      </div>

      <div className="glass-card rounded-xl px-4 py-3" style={{ borderColor: 'rgba(46,204,113,0.12)' }}>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          If you don&apos;t recognise a session, change your PIN and sign out of this device. Contact Zuri support
          on *234# or 0722 000 100.
        </p>
      </div>
    </>
  );
}
