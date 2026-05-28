import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Star, Gift, Award, TrendingUp, Zap, Crown,
  Receipt, CheckCircle2, Sparkles,
  ArrowRight, Lock, History, Info,
} from 'lucide-react';
import {
  getRewardsState, redeemPoints,
  getTierProgress, getMilestones, getAISuggestions,
  REDEMPTION_CATALOG,
} from '@/lib/rewardsEngine';

// ─── Icon map ─────────────────────────────────────────────────────────────────
const ICONS = { Star, Gift, Award, TrendingUp, Zap, Crown, Receipt };

// ─── Tier badge ───────────────────────────────────────────────────────────────
function TierBadge({ tier }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full"
      style={{ background: `${tier.glow}`, color: tier.color, border: `1px solid ${tier.color}40` }}>
      <Crown size={9} style={{ color: tier.color }} />
      {tier.label}
    </span>
  );
}

// ─── Animated ring ────────────────────────────────────────────────────────────
function TierRing({ pct, color, size = 80 }) {
  const r    = 32;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <svg width={size} height={size} viewBox="0 0 80 80">
      <circle cx="40" cy="40" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
      <motion.circle cx="40" cy="40" r={r} fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform="rotate(-90 40 40)"
        initial={{ strokeDasharray: `0 ${circ}` }}
        animate={{ strokeDasharray: `${dash} ${circ}` }}
        transition={{ duration: 1.2, ease: 'easeOut' }} />
    </svg>
  );
}

// ─── Points Hero Card ─────────────────────────────────────────────────────────
function PointsHero({ state, progress }) {
  const { current, next, pct, remaining } = progress;
  return (
    <div className="relative overflow-hidden glass-card rounded-3xl p-5 mb-4"
      style={{ border: `1px solid ${current.color}30` }}>
      <div className="absolute top-0 right-0 w-40 h-40 rounded-full blur-3xl opacity-20"
        style={{ background: current.color }} />
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Star size={13} className="text-amber-400" fill="currentColor" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Zuri Points</span>
          </div>
          <p className="font-grotesk text-5xl font-bold text-foreground leading-none">
            {state.points.toLocaleString()}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            ≈ KSh {(state.points * 0.10).toFixed(0)} redemption value
          </p>
          <div className="flex items-center gap-2 mt-3">
            <TierBadge tier={current} />
            {next && (
              <span className="text-[10px] text-muted-foreground">{remaining.toLocaleString()} pts to {next.label}</span>
            )}
          </div>
        </div>
        <div className="relative shrink-0">
          <TierRing pct={pct} color={current.color} />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-grotesk font-bold text-lg text-foreground">{pct}%</span>
          </div>
        </div>
      </div>

      {/* Tier progress bar */}
      {next && (
        <div className="mt-4 pt-4 border-t border-white/5">
          <div className="flex justify-between mb-1.5">
            <span className="text-[10px] text-muted-foreground">{current.label}</span>
            <span className="text-[10px] font-semibold" style={{ color: next.color }}>{next.label}</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden bg-white/6">
            <motion.div className="h-full rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 1.1, ease: 'easeOut' }}
              style={{ background: `linear-gradient(90deg, ${current.color}, ${next.color})` }} />
          </div>
        </div>
      )}

      {/* Month stats */}
      <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-white/5">
        {[
          { label: 'Earned today', value: '+320 pts' },
          { label: 'Lifetime',     value: state.lifetimePoints.toLocaleString() },
          { label: 'Redeemed',     value: state.redeemHistory.reduce((s, r) => s + r.pts, 0).toLocaleString() },
        ].map(s => (
          <div key={s.label} className="text-center">
            <p className="text-[10px] text-muted-foreground">{s.label}</p>
            <p className="text-[13px] font-bold text-foreground mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── AI Suggestions strip ─────────────────────────────────────────────────────
function AISuggestions({ suggestions }) {
  return (
    <div className="mb-4">
      {suggestions.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 mb-2.5">
            <Sparkles size={11} className="text-violet-400" />
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">AI Suggestions</p>
          </div>
          <div className="flex flex-col gap-2">
            {suggestions.map((s, i) => {
              const Icon = ICONS[s.icon] || Zap;
              return (
                <motion.div key={s.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.06 }}
                  className={`flex items-center gap-3 glass-card rounded-2xl px-3.5 py-3 border border-white/6 ${s.bg}`}>
                  <div className={`w-7 h-7 rounded-xl bg-black/20 flex items-center justify-center shrink-0`}>
                    <Icon size={13} className={s.color} />
                  </div>
                  <p className="text-[12px] text-foreground/85 leading-relaxed">{s.text}</p>
                </motion.div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Milestones ───────────────────────────────────────────────────────────────
function MilestonesRow({ milestones }) {
  return (
    <div className="mb-4">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Milestones</p>
      <div className="flex gap-2.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
        {milestones.map((m, i) => {
          const Icon = ICONS[m.icon] || Award;
          return (
            <motion.div key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className={`shrink-0 flex flex-col items-center gap-2 glass-card rounded-2xl px-4 py-3.5 border ${
                m.achieved ? 'border-primary/20 bg-primary/5' : 'border-white/6'
              }`} style={{ minWidth: 90 }}>
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${m.achieved ? 'bg-primary/15' : 'bg-white/5'}`}>
                {m.achieved
                  ? <CheckCircle2 size={16} className="text-primary" />
                  : <Icon size={16} className="text-muted-foreground" />}
              </div>
              <p className="text-[10px] font-semibold text-center leading-tight"
                style={{ color: m.achieved ? 'var(--green)' : 'inherit' }}>
                {m.label}
              </p>
              <p className="text-[9px] text-muted-foreground text-center">{m.pts.toLocaleString()} pts</p>
              {m.achieved && (
                <span className="text-[9px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">Done</span>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Redemption catalog ───────────────────────────────────────────────────────
function RedeemCatalog({ currentPoints, onRedeem }) {
  const [filter, setFilter] = useState('all');
  const cats = ['all', 'data', 'airtime', 'cashback', 'credit', 'entertainment', 'transfer'];
  const visible = REDEMPTION_CATALOG.filter(r => filter === 'all' || r.category === filter);

  return (
    <div className="mb-4">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Redeem Rewards</p>

      <div className="flex gap-2 overflow-x-auto pb-1 mb-3" style={{ scrollbarWidth: 'none' }}>
        {cats.map(c => (
          <button key={c} onClick={() => setFilter(c)}
            className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-semibold border capitalize transition-all ${
              filter === c ? 'bg-primary/15 border-primary/30 text-primary' : 'bg-white/5 border-white/7 text-muted-foreground'
            }`}>
            {c}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {visible.map((r, i) => {
          const canAfford = currentPoints >= r.points;
          return (
            <motion.div key={r.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              className="glass-card rounded-2xl px-4 py-3.5 flex items-center gap-3"
              style={{ border: canAfford ? '1px solid rgba(46,204,113,0.1)' : '1px solid rgba(255,255,255,0.05)' }}>
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${canAfford ? 'bg-primary/10' : 'bg-white/5'}`}>
                <Gift size={15} className={canAfford ? 'text-primary' : 'text-muted-foreground'} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-[13px] font-semibold text-foreground">{r.title}</p>
                  {r.popular && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">Hot</span>}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <Star size={9} className="text-amber-400" fill="currentColor" />
                  <span className="text-[11px] text-muted-foreground">{r.points.toLocaleString()} pts</span>
                  <span className="text-[10px] text-muted-foreground/60">·</span>
                  <span className="text-[11px] text-primary font-medium">{r.value} value</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => canAfford && onRedeem(r.id)}
                disabled={!canAfford}
                aria-label={canAfford ? `Reserve ${r.title}` : `${r.title} requires more points`}
                title={canAfford ? 'Reserve this reward in the preview catalog' : 'Not enough points'}
                className={`shrink-0 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-all ${
                  canAfford ? 'gradient-green text-black' : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
                }`}>
                {canAfford ? 'Reserve' : <Lock size={10} />}
              </button>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Earn history ─────────────────────────────────────────────────────────────
const EARN_ICONS = {
  bundle:    { icon: Zap,        color: 'text-violet-400', bg: 'bg-violet-400/10' },
  transfer:  { icon: ArrowRight, color: 'text-blue-400',   bg: 'bg-blue-400/10'   },
  paybill:   { icon: Receipt,    color: 'text-primary',    bg: 'bg-primary/10'    },
  airtime:   { icon: Star,       color: 'text-amber-400',  bg: 'bg-amber-400/10'  },
  ecosystem: { icon: Crown,      color: 'text-pink-400',   bg: 'bg-pink-400/10'   },
};

function EarnHistory({ history }) {
  const [show, setShow] = useState(false);
  const items = show ? history : history.slice(0, 4);
  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <History size={11} className="text-muted-foreground" />
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Earn History</p>
        </div>
        {history.length > 4 && (
          <button onClick={() => setShow(s => !s)} className="text-[11px] text-primary font-medium">
            {show ? 'Less' : `+${history.length - 4} more`}
          </button>
        )}
      </div>
      <div className="glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.05)' }}>
        {items.map((e, i) => {
          const cfg  = EARN_ICONS[e.type] || EARN_ICONS.transfer;
          const Icon = cfg.icon;
          const date = new Date(e.date).toLocaleDateString('en-KE', { month: 'short', day: 'numeric' });
          return (
            <motion.div key={e.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.03 }}
              className={`flex items-center gap-3 px-4 py-3 ${i < items.length - 1 ? 'border-b border-white/5' : ''}`}>
              <div className={`w-7 h-7 rounded-xl ${cfg.bg} flex items-center justify-center shrink-0`}>
                <Icon size={12} className={cfg.color} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-medium text-foreground truncate">{e.label}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{date}</p>
              </div>
              <p className="text-[13px] font-bold text-primary shrink-0">+{e.pts} pts</p>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function RewardsDashboard() {
  const [state,   setState]   = useState(() => getRewardsState());
  const [success, setSuccess] = useState(null);

  const progress    = getTierProgress(state.lifetimePoints);
  const milestones  = getMilestones(state.lifetimePoints);
  const suggestions = getAISuggestions(state);

  // Redemptions are reserved against the *local* preview rewards ledger
  // (`rewardsEngine` -> sessionStorage). No backend fulfillment is dispatched
  // yet, so the success copy must say "reserved", never "redeemed".
  const handleRedeem = (rewardId) => {
    const next = redeemPoints(rewardId);
    setState(next);
    const reward = REDEMPTION_CATALOG.find(r => r.id === rewardId);
    setSuccess(reward?.title);
    setTimeout(() => setSuccess(null), 3500);
  };

  return (
    <div className="px-4 py-4 pb-10 relative">
      {/* Single subtle preview banner — points + redemption history are local
          to this device until the rewards backend (fulfillment + airtime/data
          dispatch) is wired up. Honest copy retained so users know reservations
          aren't yet real settlement. */}
      <div
        className="glass-card rounded-xl px-3 py-2 mb-3 flex items-start gap-2"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Rewards preview — points are tracked on this device; fulfillment requires the rewards backend.
        </p>
      </div>

      {/* Success toast */}
      <AnimatePresence>
        {success && (
          <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 glass-card border border-primary/25 text-foreground px-4 py-2.5 rounded-2xl shadow text-[12px] font-semibold max-w-[90%] text-center">
            <CheckCircle2 size={14} className="text-primary" />
            <span>{success} reserved · awaiting backend fulfillment</span>
          </motion.div>
        )}
      </AnimatePresence>

      <PointsHero state={state} progress={progress} />
      <AISuggestions suggestions={suggestions} />
      <MilestonesRow milestones={milestones} />
      <RedeemCatalog currentPoints={state.points} onRedeem={handleRedeem} />
      <EarnHistory history={state.earnHistory} />
    </div>
  );
}