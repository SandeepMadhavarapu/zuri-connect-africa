/**
 * Zuri Connect Africa — Platform Readiness page (/platform).
 *
 * This is NOT a consumer feature. It is an internal-style architecture
 * disclosure surface intended for Safaricom / M-PESA engineers and reviewers.
 *
 * Honesty rules baked into the copy:
 *   - The page header reads "Platform Readiness · Architecture and rollout
 *     readiness". Never "production-ready".
 *   - Every component pill comes from `src/lib/platformReadiness.js` so the
 *     status is the single source of truth (no hand-edited claims).
 *   - The operational sections (provider verification, dispute/reversal,
 *     merchant) carry explicit "Operational workflow preview" / "Reversal
 *     readiness flow" labels and never imply live capability.
 */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Info, Layers, ShieldCheck, FileText, AlertTriangle, Building2, ChevronRight,
} from 'lucide-react';
import {
  PLATFORM_COMPONENTS,
  READINESS_STATUS_META,
  OPERATIONAL_PREVIEWS,
  groupByLayer,
} from '@/lib/platformReadiness';
import { PROVIDER_DIRECTORY_SEED } from '@/lib/providerDirectory';
import RenderGuard from '@/components/system/RenderGuard';
import AppErrorBoundary from '@/components/AppErrorBoundary';

const fadeUp = {
  hidden: { opacity: 0, y: 8 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
};

function StatusPill({ status }) {
  const meta = READINESS_STATUS_META[status] || READINESS_STATUS_META.preview;
  return (
    <span
      className={`text-[9px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${meta.className}`}
      title={meta.helper}
    >
      {meta.label}
    </span>
  );
}

function ComponentRow({ component, isLast }) {
  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 ${
        isLast ? '' : 'border-b border-white/5'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[12px] font-semibold text-foreground">{component.name}</p>
          <StatusPill status={component.status} />
        </div>
        <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
          {component.description}
        </p>
        {component.proof?.length > 0 && (
          <p className="mt-1.5 text-[10px] text-muted-foreground/80 font-mono break-all">
            Proof · {component.proof.join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}

function ArchitectureMatrix() {
  const grouped = useMemo(() => groupByLayer(PLATFORM_COMPONENTS), []);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Layers size={13} className="text-primary" />
        <p className="section-title">System architecture matrix</p>
      </div>
      <div
        className="glass-card rounded-xl px-3 py-2 mb-3 flex items-start gap-2"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Architecture and rollout readiness — every component below points at the file,
          migration, or Edge Function that backs it. No item claims live / production
          status in this build.
        </p>
      </div>

      {grouped.map(({ layer, items }) => (
        <div key={layer} className="mb-4">
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">
            {layer}
          </p>
          <div
            className="glass-card rounded-2xl overflow-hidden"
            style={{ border: '1px solid rgba(255,255,255,0.06)' }}
          >
            {items.map((c, i) => (
              <ComponentRow key={c.id} component={c} isLast={i === items.length - 1} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function OperationalPreviewCard({ preview, icon: Icon, accent }) {
  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="mb-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-8 h-8 rounded-xl ${accent.bg} border ${accent.border} flex items-center justify-center shrink-0`}>
            <Icon size={14} className={accent.text} />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-foreground truncate">{preview.title}</p>
            <p className="text-[10px] text-muted-foreground">{preview.summary}</p>
          </div>
        </div>
        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${accent.badge}`}>
          {preview.label}
        </span>
      </div>
      <div
        className="glass-card rounded-2xl overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.06)' }}
      >
        {preview.bullets.map((b, i) => (
          <div
            key={i}
            className={`flex items-start gap-3 px-4 py-2.5 ${
              i < preview.bullets.length - 1 ? 'border-b border-white/5' : ''
            }`}
          >
            <ChevronRight size={11} className="text-muted-foreground/70 mt-0.5 shrink-0" />
            <p className="text-[11px] text-foreground/85 leading-relaxed">{b}</p>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function ProviderDirectorySnapshot() {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <FileText size={13} className="text-blue-400" />
        <p className="section-title">Provider directory · seed snapshot</p>
      </div>
      <div
        className="glass-card rounded-xl px-3 py-2 mb-2 flex items-start gap-2"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          UI / data-model preview only. No PayBill or Till numbers are populated in this seed —
          every entry stays unverified until a verified provider source is connected.
        </p>
      </div>
      <div
        className="glass-card rounded-2xl overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.06)' }}
      >
        {PROVIDER_DIRECTORY_SEED.map((entry, i) => (
          <div
            key={`${entry.category}-${i}`}
            className={`flex items-start gap-3 px-4 py-3 ${
              i < PROVIDER_DIRECTORY_SEED.length - 1 ? 'border-b border-white/5' : ''
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-[12px] font-semibold text-foreground">{entry.providerName}</p>
                <span className="text-[9px] font-bold px-2 py-0.5 rounded-full border bg-amber-400/10 text-amber-500 border-amber-400/20 whitespace-nowrap">
                  {entry.verificationStatus}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {entry.category} · {entry.accountReferenceLabel} ({entry.accountReferenceFormat})
              </p>
              <p className="text-[10px] text-muted-foreground/80 mt-0.5">
                Source required · last verified: {entry.lastVerifiedAt || 'never'} · report wrong number: enabled
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PlatformReadiness() {
  const previewIcons = {
    provider_verification: { icon: ShieldCheck, accent: {
      bg: 'bg-blue-400/10', border: 'border-blue-400/20', text: 'text-blue-400',
      badge: 'bg-blue-400/10 text-blue-400 border-blue-400/20',
    }},
    dispute_reversal:      { icon: AlertTriangle, accent: {
      bg: 'bg-amber-400/10', border: 'border-amber-400/20', text: 'text-amber-500',
      badge: 'bg-amber-400/10 text-amber-500 border-amber-400/20',
    }},
    merchant_business:     { icon: Building2, accent: {
      bg: 'bg-primary/10', border: 'border-primary/20', text: 'text-primary',
      badge: 'bg-primary/10 text-primary border-primary/20',
    }},
  };

  return (
    <AppErrorBoundary>
      <div className="px-4 py-4 pb-8" data-testid="platform-readiness-page">
        {/* Header — explicitly framed as readiness, not a consumer feature */}
        <div className="premium-card rounded-[24px] p-4 mb-4 overflow-hidden relative">
          <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-primary/10 blur-2xl" />
          <div className="relative flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 border border-primary/15">
              <Layers size={18} className="text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold text-primary uppercase tracking-widest">
                Internal · Architecture disclosure
              </p>
              <p className="mt-1 text-[14px] font-bold text-foreground">Platform Readiness</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Architecture and rollout readiness · operational workflow preview. Not a
                consumer feature. No component below claims live / production status in
                this build.
              </p>
            </div>
          </div>
        </div>

        <RenderGuard name="Architecture Matrix">
          <ArchitectureMatrix />
        </RenderGuard>

        <div className="mb-2 mt-2">
          <p className="section-title">Operational workflow previews</p>
        </div>

        <RenderGuard name="Operational Previews">
          {OPERATIONAL_PREVIEWS.map((p) => {
            const meta = previewIcons[p.id] || previewIcons.provider_verification;
            return (
              <OperationalPreviewCard
                key={p.id}
                preview={p}
                icon={meta.icon}
                accent={meta.accent}
              />
            );
          })}
        </RenderGuard>

        <RenderGuard name="Provider Directory Snapshot">
          <ProviderDirectorySnapshot />
        </RenderGuard>

        <div
          className="glass-card rounded-xl px-3 py-3 mt-3 flex items-start gap-2"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Pitch caveat — this page intentionally avoids overclaim wording such as live or
            production status. Daraja STK Push, AI router providers, and the production
            provider directory all require Safaricom / partner onboarding before
            transacting.
          </p>
        </div>
      </div>
    </AppErrorBoundary>
  );
}
