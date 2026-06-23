import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Mic, User, X, Activity, Zap, CreditCard, ShieldCheck, Wifi } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { routeAIRequest } from '@/lib/ai/orchestrator';
import { suggestActionsFromResponse, getActionCatalog } from '@/lib/ai/aiActions';
import { getTransactions } from '@/lib/mpesa';
import { deriveBalance } from '@/lib/ledger';
import { startListening, stopListening } from '@/lib/voice/speechToText';
import AIActionModal from '@/components/ai/AIActionModal';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import RenderGuard from '@/components/system/RenderGuard';
import SpendingPulseWidget from '@/components/ai/SpendingPulseWidget';
import FraudAlertsWidget from '@/components/ai/FraudAlertsWidget';
import NetworkHealthWidget from '@/components/ai/NetworkHealthWidget';
import RewardsWidget from '@/components/ai/RewardsWidget';
import AIMemoryWidget from '@/components/ai/AIMemoryWidget';
import { AI_BRAND, AI_FALLBACK } from '@/lib/branding/aiBrand';
import { getFirstNameForGreeting } from '@/lib/formatters/userDisplay';
import { DEFAULT_LIMITS, getCategorySpend } from '@/components/budget/budgetData';
import { sanitizeConversationMessages, buildContextualFallback, buildSafeAIContext } from '@/lib/ai/contextBuilder';

// ─── Quick suggestions by context ────────────────────────────────────────────

const SUGGESTIONS = [
  { label: "📊 What did I spend most on?",  type: 'spending_analysis'     },
  { label: "📡 Check my bundle status",      type: 'bundle_recommendation' },
  { label: "⚡ How's my Fuliza limit?",      type: 'financial_coach'       },
  { label: "🛡️ Am I at risk of a scam?",    type: 'fraud_detection'       },
  { label: "💰 How can I save more?",        type: 'financial_coach'       },
  { label: "📶 Why is my network slow?",     type: 'network_assistant'     },
];

// ─── Observability badge ──────────────────────────────────────────────────────

const COPILOT_TAGS = [
  { label: 'Payments', icon: CreditCard },
  { label: 'Bundles', icon: Zap },
  { label: 'Fraud', icon: ShieldCheck },
  { label: 'Network', icon: Wifi },
];

const INTRO_CAPABILITIES = [
  { label: 'Spending', detail: 'Budgets and trends', icon: Activity },
  { label: 'M-PESA', detail: 'Transfers and paybills', icon: CreditCard },
  { label: 'Bundles', detail: 'Airtime and data', icon: Zap },
  { label: 'Fraud', detail: 'Scam prevention', icon: ShieldCheck },
  { label: 'Network', detail: 'Signal support', icon: Wifi },
];

// Provider badges keep their semantic meaning but inside the Hesabu palette:
// live providers read emerald, degraded/rate-limited states brass, and
// auth/safety failures danger — no rainbow tints. Scoped to the .hesabu-theme
// subtree like the rest of /ai.
const PROVIDER_COLORS = {
  openai:       'text-hesabu-emerald bg-hesabu-emerald/10',
  anthropic:    'text-hesabu-emerald bg-hesabu-emerald/10',
  gemini:       'text-hesabu-emerald bg-hesabu-emerald/10',
  local:        'text-hesabu-brass bg-hesabu-brass/10',
  safety:       'text-hesabu-danger bg-hesabu-danger/10',
  rate_limited: 'text-hesabu-brass bg-hesabu-brass/10',
  auth:         'text-hesabu-danger bg-hesabu-danger/10',
};

function ProviderBadge({ provider, latency, fallback }) {
  if ((provider === 'local' || provider === 'unavailable') && !import.meta.env.DEV) return null;
  const cls = PROVIDER_COLORS[provider] || 'text-hesabu-muted bg-hesabu-surface-2';
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${cls} ml-2`}>
      {provider}{latency ? ` · ${latency}ms` : ''}{fallback ? ' ↩' : ''}
    </span>
  );
}

// ─── Action chips ─────────────────────────────────────────────────────────────

function ActionChips({ actionTypes, onAction }) {
  const actions = getActionCatalog(actionTypes);
  if (!actions.length) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-2">
        <span className="text-[10px] text-hesabu-muted">No actions available</span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {actions.map(a => (
        <button key={a.id} onClick={() => onAction(a.id)}
          className="text-[10px] font-bold px-2.5 py-1.5 rounded-full border bg-hesabu-surface-2 text-hesabu-emerald border-hesabu-line shadow-sm">
          {a.label} →
        </button>
      ))}
    </div>
  );
}

function AdvisorIntroBubble({ name }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="font-grotesk text-base font-bold text-hesabu-paper">Habari, {name}.</p>
        <p className="mt-1 text-[12px] leading-relaxed text-hesabu-muted">
          I am {AI_BRAND.name}, your Zuri Connect Africa copilot for wallet decisions, payments, bundles, fraud awareness, and network help.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2">
        {INTRO_CAPABILITIES.map(({ label, detail, icon: Icon }) => (
          <div key={label} className="flex items-center gap-2.5 hesabu-card rounded-2xl px-3 py-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-hesabu-surface-2 border border-hesabu-line">
              <Icon size={13} className="text-hesabu-emerald" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-bold text-hesabu-paper">{label}</p>
              <p className="text-[10px] text-hesabu-muted">{detail}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] font-semibold text-hesabu-emerald">What would you like to review today?</p>
    </div>
  );
}

// ─── Legacy Dashboard panels (kept for fallback) ────────────────────────────────

function SpendingPulse({ txHistory }) {
  const safeTx = Array.isArray(txHistory) ? txHistory : [];
  const debits = safeTx.filter(t => t && t.amount && t.amount < 0);
  const total = debits.reduce((s, t) => s + Math.abs(Math.max(0, Number(t?.amount) || 0)), 0) || 0;
  const bundles = debits.filter(t => t?.type === 'bundle').reduce((s, t) => s + Math.abs(Math.max(0, Number(t?.amount) || 0)), 0) || 0;
  const airtime = debits.filter(t => t?.type === 'airtime').reduce((s, t) => s + Math.abs(Math.max(0, Number(t?.amount) || 0)), 0) || 0;
  return (
    <div className="hesabu-card rounded-2xl p-3.5">
      <div className="flex items-center gap-1.5 mb-2.5">
        <Activity size={11} className="text-hesabu-emerald" />
        <p className="text-[10px] font-semibold text-hesabu-muted uppercase tracking-widest">Spending Pulse</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Total out', val: `KSh ${total.toLocaleString()}` },
          { label: 'Bundles',   val: `KSh ${bundles.toLocaleString()}` },
          { label: 'Airtime',   val: `KSh ${airtime.toLocaleString()}` },
        ].map(s => (
          <div key={s.label} className="text-center">
            <p className="font-grotesk font-bold text-[14px] text-hesabu-paper">{s.val}</p>
            <p className="text-[9px] text-hesabu-muted mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FraudAlerts({ threats }) {
  const safeThreats = threats || [];
  if (!safeThreats.length) return (
    <div className="hesabu-card rounded-2xl px-3.5 py-3 flex items-center gap-2">
      <Zap size={12} className="text-hesabu-emerald shrink-0" />
      <p className="text-[11px] text-hesabu-muted">No fraud alerts this session.</p>
    </div>
  );
  return (
    <div className="hesabu-card rounded-2xl overflow-hidden">
      {safeThreats.slice(0, 3).map((t, i) => (
        <div key={i} className={`px-3.5 py-2.5 flex items-center gap-2 ${i < 2 ? 'border-b border-hesabu-line' : ''}`}>
          <div className="w-5 h-5 rounded bg-hesabu-danger/10 flex items-center justify-center shrink-0">
            <Zap size={9} className="text-hesabu-danger" />
          </div>
          <p className="text-[11px] text-hesabu-paper/80">{t.scamCategory || 'Fraud'} pattern · {t.userAction}</p>
        </div>
      ))}
    </div>
  );
}

function NetworkPanel({ insights }) {
  const safeInsights = Array.isArray(insights) ? insights : [];
  return (
    <div className="flex flex-col gap-1.5">
      {safeInsights.length > 0 ? (
        safeInsights.map((ins, i) => (
          <div key={i} className={`hesabu-card rounded-xl px-3.5 py-2.5 ${ins?.type === 'warning' ? 'border-hesabu-brass/30' : ''}`}>
            <p className="text-[11px] text-hesabu-paper/80 leading-relaxed">{ins?.text || 'No insight'}</p>
          </div>
        ))
      ) : (
        <div className="hesabu-card rounded-xl px-3.5 py-2.5">
          <p className="text-[11px] text-hesabu-muted">Network status normal</p>
        </div>
      )}
    </div>
  );
}

// ─── Dashboard tab ────────────────────────────────────────────────────────────

function DashboardTab() {
  return (
    <div className="px-4 py-3 space-y-4">
      <RenderGuard name="Spending Pulse">
        <SpendingPulseWidget />
      </RenderGuard>

      <div>
        <p className="text-[10px] font-semibold text-hesabu-muted uppercase tracking-widest mb-2">Fraud Alerts</p>
        <RenderGuard name="Fraud Alerts">
          <FraudAlertsWidget />
        </RenderGuard>
      </div>

      <div>
        <p className="text-[10px] font-semibold text-hesabu-muted uppercase tracking-widest mb-2">Network Health</p>
        <RenderGuard name="Network Health">
          <NetworkHealthWidget />
        </RenderGuard>
      </div>

      <div>
        <p className="text-[10px] font-semibold text-hesabu-muted uppercase tracking-widest mb-2">Rewards</p>
        <RenderGuard name="Rewards">
          <RewardsWidget />
        </RenderGuard>
      </div>

      <div>
        <p className="text-[10px] font-semibold text-hesabu-muted uppercase tracking-widest mb-2">AI Memory</p>
        <RenderGuard name="AI Memory">
          <AIMemoryWidget />
        </RenderGuard>
      </div>
    </div>
  );
}

// ─── Main AI page ──────────────────────────────────────────────────────────────

export default function AI() {
  const { user } = useAuth();
  const [tab, setTab] = useState('chat'); // chat | dashboard
  const [messages, setMessages] = useState(() => [{
    id: 1,
    role: 'assistant',
    content: `Habari, ${getFirstNameForGreeting(user?.full_name || user?.email)}. I'm ${AI_BRAND.name}, your Zuri Connect Africa copilot.\n\nI can help with:\n• Spending analysis & budgeting\n• M-PESA transfers & payments\n• Bundles, airtime & Fuliza\n• Scam prevention & fraud alerts\n• Financial planning & rewards\n• Network troubleshooting\n\nWhat would you like to review today?`,
    provider: null,
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [actionModal, setActionModal] = useState(null); // { type, params }
  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const sttRef     = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const detectRequestType = useCallback((text) => {
    const lower = text.toLowerCase();
    if (/scam|fraud|ujanja|phish|suspicious/.test(lower))       return 'fraud_detection';
    if (/bundle|data|internet|gb|zimeisha/.test(lower))          return 'bundle_recommendation';
    if (/network|signal|slow|mtandao|congestion/.test(lower))   return 'network_assistant';
    if (/spend|budget|bei|expense|cost/.test(lower))             return 'spending_analysis';
    if (/reward|points|bonga|tier/.test(lower))                  return 'rewards_assistant';
    if (/security|pin|auth|protect|freeze/.test(lower))         return 'security_assistant';
    if (/fuliza|borrow|overdraft/.test(lower))                   return 'financial_coach';
    return 'financial_coach';
  }, []);

  const send = async (text, overrideType) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput('');

    const userMsg = { id: Date.now(), role: 'user', content: msg };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const txHistory = getTransactions?.(6) || [];
      const conversationMessages = sanitizeConversationMessages([...messages, userMsg]);
      let balanceStr = 'unavailable';
      let availableBalance = null;
      
      try {
        const bal = await Promise.race([
          deriveBalance?.(user?.phone || ''),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Balance timeout')), 3000)),
        ]);
        if (bal !== null && bal !== undefined) {
          availableBalance = Number(bal);
          balanceStr = `KSh ${bal.toLocaleString()}`;
        }
      } catch (e) {
        console.warn('[AI] Balance derivation failed:', e?.message);
      }

      const type = overrideType || detectRequestType(msg);
      const budgetSpend = getCategorySpend?.() || {};
      const safeContext = buildSafeAIContext({
        user,
        txHistory,
        availableBalance: availableBalance ?? balanceStr,
        currentPage: tab === 'dashboard' ? 'Duke AI dashboard' : 'Duke AI chat',
        conversationMessages,
        budgetSpend,
        budgetLimits: DEFAULT_LIMITS,
      });
      
      let result;
      try {
        result = await Promise.race([
          routeAIRequest?.({
            type,
            user,
            message: msg,
            context: {
              txHistory,
              availableBalance: availableBalance ?? balanceStr,
              currentPage: tab === 'dashboard' ? 'Duke AI dashboard' : 'Duke AI chat',
              conversationMessages,
              budgetSpend,
              budgetLimits: DEFAULT_LIMITS,
              extra: `Balance: ${balanceStr}`,
            },
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('AI request timeout')), 12000)),
        ]);
      } catch (aiErr) {
        console.error('[AI] Route error:', aiErr?.message);
        result = { response: buildContextualFallback(msg, safeContext), provider: 'unavailable', fallbackTriggered: true };
      }

      if (!result || typeof result !== 'object') {
        result = { response: buildContextualFallback(msg, safeContext), provider: 'unavailable', fallbackTriggered: true };
      }

      const actionTypes = result.proposed_action?.action_type
        ? [result.proposed_action.action_type]
        : suggestActionsFromResponse?.(result.response || '') || [];

      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'assistant',
        content: result.response || 'Unable to process your request.',
        provider: result.provider || 'unknown',
        latency: result.latency,
        fallback: result.fallbackTriggered,
        language: result.language || 'en',
        actionTypes,
        proposedAction: result.proposed_action || null,
        rateLimited: Boolean(result.rateLimited),
        retryAfterSeconds: result.retryAfterSeconds || null,
      }]);
    } catch (e) {
      console.error('[AI] Send error:', e?.message);
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'assistant',
        content: AI_FALLBACK.chatUnavailable,
        provider: 'error',
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleVoice = () => {
    if (isListening) {
      try {
        stopListening?.(sttRef.current);
      } catch (e) {
        console.warn('[Voice] Stop listening error:', e);
      }
      setIsListening(false);
      return;
    }
    setIsListening(true);
    try {
      sttRef.current = startListening?.({
        onResult: ({ transcript }) => {
          setIsListening(false);
          if (transcript) send(transcript);
        },
        onError: (e) => {
          console.warn('[Voice] Listening error:', e);
          setIsListening(false);
        },
      });
      if (!sttRef.current) setIsListening(false);
    } catch (e) {
      console.error('[Voice] Start listening error:', e);
      setIsListening(false);
    }
  };

  return (
    <AppErrorBoundary>
    <div className="hesabu-theme relative flex flex-col min-h-full">
      {/* Ink fill anchored to the page box so the warm green-black surface spans
          the full visible height edge-to-edge — mirrors Home / Profile / History.
          The route's .app-scrollbar[data-chama-route] fill (gated on isHesabuRoute,
          which now includes '/ai') handles the nav-clearance band. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-hesabu-ink"
      />

      {/* Header */}
      <motion.div
        className="px-4 py-4 border-b border-hesabu-line bg-hesabu-ink/80 backdrop-blur-xl"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-center gap-3 mb-4">
          <motion.div
            className="security-shield-pulse w-12 h-12 rounded-2xl bg-hesabu-emerald/15 border border-hesabu-emerald/30 flex items-center justify-center shrink-0"
            animate={{ scale: [1, 1.02, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <span className="text-hesabu-emerald font-bold text-base font-grotesk">Z</span>
          </motion.div>
          <div className="flex-1">
            <p className="text-sm font-bold text-hesabu-paper font-grotesk">{AI_BRAND.copilotHeader}</p>
            <p className="text-xs text-hesabu-muted">Payments &middot; Bundles &middot; Fraud &middot; Network</p>
          </div>
          <motion.div
            className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-hesabu-emerald/10 border border-hesabu-emerald/25"
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
          >
            <motion.div
              className="w-2 h-2 rounded-full bg-hesabu-emerald"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            <span className="text-xs font-semibold text-hesabu-emerald">Active</span>
          </motion.div>
        </div>

        <div className="mb-4 grid grid-cols-4 gap-1.5">
          {COPILOT_TAGS.map(({ label, icon: Icon }) => (
            <div key={label} className="hesabu-card rounded-2xl px-2 py-2 text-center">
              <Icon size={13} className="mx-auto mb-1 text-hesabu-emerald" />
              <span className="block truncate text-[9px] font-bold text-hesabu-muted">{label}</span>
            </div>
          ))}
        </div>

        {/* Tab switcher — recessed panel; the active pill uses the hesabu-emerald
            token (not brand-green). Inactive keeps a transparent border so the
            active border doesn't shift layout. */}
        <motion.div className="flex gap-1 hesabu-panel rounded-2xl p-1.5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          {[['chat', 'Chat'], ['dashboard', 'Dashboard']].map(([key, label]) => (
            <motion.button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all border ${
                tab === key
                  ? 'bg-hesabu-emerald/15 text-hesabu-emerald border-hesabu-emerald/30'
                  : 'text-hesabu-muted border-transparent hover:text-hesabu-paper'
              }`}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.95 }}
            >
              {label}
            </motion.button>
          ))}
        </motion.div>
      </motion.div>

      {/* Body */}
      <AnimatePresence mode="wait">
        {tab === 'dashboard' ? (
          <motion.div key="dash" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <RenderGuard name="Dashboard">
              <DashboardTab />
            </RenderGuard>
          </motion.div>
        ) : (
          <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col min-h-full">
            {/* Messages */}
            <div className="px-4 py-5 space-y-4 flex-1">
              {Array.isArray(messages) && messages.length > 0 ? messages.map(msg => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
                  className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.role === 'assistant' && (
                    <motion.div
                      className="w-8 h-8 rounded-2xl bg-hesabu-emerald/15 border border-hesabu-emerald/30 flex items-center justify-center shrink-0 mt-0.5"
                      animate={{ scale: [1, 1.02, 1] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    >
                      <span className="text-hesabu-emerald font-bold text-xs font-grotesk">Z</span>
                    </motion.div>
                  )}
                  <div className={`${msg.id === 1 ? 'max-w-[92%]' : 'max-w-[80%]'} ${msg.role === 'user' ? 'flex flex-col items-end gap-1' : ''}`}>
                    <motion.div
                      className={`rounded-3xl px-5 py-3.5 text-sm leading-relaxed font-medium backdrop-blur ${
                        msg.role === 'user'
                          ? 'bg-hesabu-emerald/15 border border-hesabu-emerald/30 text-hesabu-paper rounded-br-lg'
                          : msg.id === 1
                            ? 'hesabu-card text-hesabu-paper rounded-bl-lg'
                            : 'bg-hesabu-surface border border-hesabu-line text-hesabu-paper rounded-bl-lg'
                      }`}
                      whileHover={{ scale: 1.01 }}
                      transition={{ duration: 0.2 }}
                    >
                      {msg.id === 1 && msg.role === 'assistant' ? (
                        <AdvisorIntroBubble name={getFirstNameForGreeting(user?.full_name || user?.email)} />
                      ) : (
                        msg.content?.split('\n').map((line, i, arr) => (
                          <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
                        ))
                      )}
                    </motion.div>
                    {msg.role === 'assistant' && msg.provider && (
                      <div className="mt-1 flex items-center flex-wrap gap-1">
                        <ProviderBadge provider={msg.provider} latency={msg.latency} fallback={msg.fallback} />
                        {msg.language && msg.language !== 'en' && (
                          <span className="text-[9px] text-hesabu-muted bg-hesabu-surface-2 px-1.5 py-0.5 rounded-full">{msg.language}</span>
                        )}
                      </div>
                    )}
                    {msg.role === 'assistant' && msg.actionTypes?.length > 0 && (
                      <ActionChips
                        actionTypes={msg.actionTypes}
                        onAction={(type) => setActionModal({
                          type,
                          params: msg.proposedAction || {},
                          proposal: msg.proposedAction || null,
                        })}
                      />
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-7 h-7 rounded-lg bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center shrink-0 mt-0.5">
                      <User size={11} className="text-hesabu-muted" />
                    </div>
                  )}
                </motion.div>
              )) : (
                <div className="flex items-center justify-center py-8 text-hesabu-muted text-sm">
                  Loading conversation…
                </div>
              )}

              {loading && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-2.5">
                  <div className="w-8 h-8 rounded-2xl bg-hesabu-emerald/15 border border-hesabu-emerald/30 flex items-center justify-center shrink-0">
                    <span className="text-hesabu-emerald font-bold text-[10px]">Z</span>
                  </div>
                  <div className="bg-hesabu-surface border border-hesabu-line rounded-2xl rounded-bl-sm px-4 py-3.5 min-w-[172px]">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-hesabu-emerald animate-pulse" />
                      <p className="text-[10px] font-bold uppercase tracking-widest text-hesabu-muted">{AI_BRAND.thinkingLabel}</p>
                    </div>
                    <div className="mt-3 space-y-2">
                      <div className="bg-hesabu-surface-2 animate-pulse h-2.5 w-32 rounded-full" />
                      <div className="bg-hesabu-surface-2 animate-pulse h-2.5 w-24 rounded-full" />
                    </div>
                  </div>
                </motion.div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Quick suggestions */}
            {messages.length <= 2 && (
              <div className="px-4 pb-2">
                <div className="quick-chip-shell">
                  <div className="chip-row advisor-chip-row">
                    {SUGGESTIONS.map(s => (
                      <button key={s.label} onClick={() => send(s.label, s.type)}
                        className="shrink-0 rounded-full border bg-hesabu-surface-2 border-hesabu-line text-[11px] font-bold px-3 py-2 text-hesabu-muted hover:text-hesabu-paper hover:border-hesabu-emerald/30 transition-all">
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Input bar */}
            <div className="sticky bottom-0 z-20 px-4 py-3 border-t border-hesabu-line bg-hesabu-ink/95 backdrop-blur-xl">
              <div className="flex items-center gap-2">
                <button onClick={handleVoice}
                  className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 transition-all border ${
                    isListening
                      ? 'bg-hesabu-emerald/20 text-hesabu-emerald border-hesabu-emerald/30 animate-pulse'
                      : 'bg-hesabu-surface border-hesabu-line text-hesabu-muted'
                  }`}>
                  <Mic size={16} />
                </button>
                <div className="flex-1 flex items-center hesabu-panel rounded-2xl px-4 py-2.5 gap-2">
                  <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && send()}
                    placeholder="Ask anything…"
                    className="flex-1 bg-transparent text-[13px] text-hesabu-paper placeholder:text-hesabu-muted outline-none" />
                  {input && <button onClick={() => setInput('')}><X size={13} className="text-hesabu-muted" /></button>}
                </div>
                <button onClick={() => send()} disabled={!input.trim() || loading}
                  className="w-10 h-10 rounded-2xl bg-hesabu-emerald/15 border border-hesabu-emerald/30 flex items-center justify-center shrink-0 disabled:opacity-25">
                  <Send size={15} className="text-hesabu-emerald" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI Action Modal */}
      <AnimatePresence>
        {actionModal && (
          <AIActionModal
            actionType={actionModal.type}
            params={actionModal.params}
            proposal={actionModal.proposal}
            userId={user?.email}
            onClose={() => setActionModal(null)}
            onConfirmed={() => setActionModal(null)}
          />
        )}
      </AnimatePresence>
    </div>
    </AppErrorBoundary>
  );
}
