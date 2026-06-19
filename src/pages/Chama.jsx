import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';

import { Button } from '@/components/ui/button';
import { HESABU_BRAND } from '@/lib/branding/hesabu';
import Eyebrow from '@/components/chama/ui/Eyebrow';
import TreasuryHero from '@/components/chama/TreasuryHero';
import HashChainRibbon from '@/components/chama/HashChainRibbon';
import ChamaListItem from '@/components/chama/ChamaListItem';
import EmptyState from '@/components/chama/EmptyState';
import CreateChamaDialog from '@/components/chama/CreateChamaDialog';
import { fetchMyChamas, MY_CHAMAS_QUERY_KEY } from '@/components/chama/data/chamaApi';
import { useAuth } from '@/lib/AuthContext';

/**
 * Hesabu home — now driven by the user's REAL chamas (groups they're an active
 * member of), fetched via TanStack Query against the Supabase chama_* tables.
 * Composition (top to bottom):
 *   1. Treasury hero band (sum of pooled totals)
 *   2. Hash-chain ribbon (settled history; preview state when empty)
 *   3. Your chamas (real cards)
 *   4. Primary actions → open the Create dialog
 * …plus loading skeletons, a friendly error state, and the real EmptyState.
 *
 * The whole subtree is wrapped in `.hesabu-theme` so the identity stays
 * contained. The Create dialog is portalled, so it sets `.hesabu-theme` itself.
 */

function CardSkeleton() {
  return (
    <div className="hesabu-elevated animate-pulse rounded-2xl border border-hesabu-line bg-hesabu-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-5 w-40 rounded bg-hesabu-surface-2" />
          <div className="h-4 w-16 rounded-full bg-hesabu-surface-2" />
        </div>
        <div className="h-5 w-24 rounded bg-hesabu-surface-2" />
      </div>
      <div className="my-4 h-px bg-hesabu-line" />
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-3 w-28 rounded bg-hesabu-surface-2" />
          <div className="h-4 w-20 rounded bg-hesabu-surface-2" />
        </div>
        <div className="h-14 w-14 rounded-full bg-hesabu-surface-2" />
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-8">
      <div className="hesabu-elevated h-40 animate-pulse rounded-3xl border border-hesabu-line bg-hesabu-surface" />
      <div className="space-y-4">
        <Eyebrow>Your chamas</Eyebrow>
        <div className="space-y-4">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    </div>
  );
}

function ErrorState({ onRetry }) {
  return (
    <div className="hesabu-elevated flex flex-col items-center rounded-3xl border border-hesabu-line bg-hesabu-surface px-6 py-12 text-center">
      <h2 className="font-display text-xl font-bold text-hesabu-paper">
        Couldn&apos;t load your chamas
      </h2>
      <p className="mt-2 max-w-xs text-sm text-hesabu-muted">
        Something went wrong reaching the treasury. Check your connection and try again.
      </p>
      <Button
        onClick={onRetry}
        className="mt-6 bg-hesabu-emerald text-hesabu-ink hover:bg-hesabu-emerald-dim"
      >
        Try again
      </Button>
    </div>
  );
}

function PrimaryActions({ onCreate, onJoin }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Button
        onClick={onCreate}
        className="bg-hesabu-emerald font-semibold text-hesabu-ink shadow-[0_4px_14px_-4px_rgba(31,157,107,0.45)] transition-shadow hover:bg-hesabu-emerald-dim hover:shadow-[0_8px_24px_-6px_rgba(31,157,107,0.6)] sm:flex-1"
      >
        Create a chama
      </Button>
      <Button
        variant="outline"
        onClick={onJoin}
        className="border-hesabu-line bg-hesabu-surface-2 font-medium text-hesabu-paper hover:border-hesabu-emerald hover:bg-hesabu-surface-2 hover:text-hesabu-paper sm:flex-1"
      >
        Join with code
      </Button>
    </div>
  );
}

export default function ChamaHome() {
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = React.useState(false);

  const {
    data: chamas = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: MY_CHAMAS_QUERY_KEY,
    queryFn: () => fetchMyChamas(user),
    enabled: Boolean(user?.id),
  });

  const openCreate = () => setCreateOpen(true);
  // TODO(join-chama): wire "Join with code" to the join flow (next feature).
  const handleJoin = () => console.log('[Hesabu] join with code — coming soon');

  const totalCents = chamas.reduce((sum, c) => sum + (c.pooledCents || 0), 0);
  const memberCount = chamas.reduce((sum, c) => sum + (c.membersTotal || 0), 0);

  // Settled-history blocks for the ribbon. None exist for new accounts yet, so
  // the ribbon renders its preview state. (Richer settled feed is a later read
  // path — we don't fabricate demo blocks.)
  const chainBlocks = [];

  const isEmpty = !isLoading && !isError && chamas.length === 0;

  let body;
  if (isLoading || (!user?.id && !isError)) {
    body = <LoadingState />;
  } else if (isError) {
    body = <ErrorState onRetry={() => refetch()} />;
  } else if (isEmpty) {
    body = <EmptyState onCreate={openCreate} onJoin={handleJoin} />;
  } else {
    body = (
      <div className="space-y-10">
        {/* 1 — Treasury hero */}
        <TreasuryHero
          totalCents={totalCents}
          chamaCount={chamas.length}
          memberCount={memberCount}
        />

        <div className="h-px bg-hesabu-line" />

        {/* 2 — The signature: hash-chain ribbon (preview when no settled history) */}
        <HashChainRibbon blocks={chainBlocks} />

        <div className="h-px bg-hesabu-line" />

        {/* 3 — Your chamas, with the primary actions anchored directly beneath
            the cards (not floating in a void below). */}
        <section className="space-y-4">
          <Eyebrow tick>Your chamas</Eyebrow>
          <div className="space-y-4">
            {chamas.map((c) => (
              <ChamaListItem key={c.id} chama={c} />
            ))}
          </div>
          <div className="pt-2">
            <PrimaryActions onCreate={openCreate} onJoin={handleJoin} />
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="hesabu-theme">
      {/* react-hot-toast portal. Scoped here because the app's global toaster is
          a different library and we only touch chama files; one Toaster instance
          for the chama surface is enough. */}
      <Toaster position="top-center" />

      {/* Ink fill anchored to the scroll container (<main>, the nearest
          positioned ancestor) — spans its full visible height edge-to-edge on
          mobile AND desktop, regardless of content height. The page's own
          parent (AppShell's motion wrapper) has auto height, so min-h-full
          alone cannot reach it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-hesabu-ink"
      />

      <div className="relative min-h-full bg-hesabu-ink px-5 pb-12 pt-7">
        {/* Wordmark */}
        <header className="mb-7 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-hesabu-emerald">
            <span className="font-display text-xl font-bold text-hesabu-ink">H</span>
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-hesabu-paper">
              {HESABU_BRAND.name}
            </h1>
            <p className="text-sm text-hesabu-muted">{HESABU_BRAND.tagline}</p>
          </div>
        </header>

        {body}
      </div>

      <CreateChamaDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
