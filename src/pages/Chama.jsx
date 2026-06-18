import { Button } from '@/components/ui/button';
import { HESABU_BRAND } from '@/lib/branding/hesabu';
import TreasuryHero from '@/components/chama/TreasuryHero';
import HashChainRibbon from '@/components/chama/HashChainRibbon';
import ChamaListItem from '@/components/chama/ChamaListItem';
import EmptyState from '@/components/chama/EmptyState';

/**
 * Hesabu home — the screen that sells the product. Composition (top to bottom):
 *   1. Treasury hero band (pooled total, the thesis)
 *   2. Hash-chain ribbon (the signature: tamper-evidence, the one bold moment)
 *   3. Your chamas (structured cards, not flat rows)
 *   4. Primary actions
 * …plus a real empty state when there are no chamas.
 *
 * FRONTEND ONLY for now: a local DEMO_DATA constant drives the populated
 * preview. Flip USE_EMPTY_STATE to true to preview the empty state. The whole
 * subtree is wrapped in `.hesabu-theme` so the identity stays contained.
 */

// Flip to true to preview the empty state.
const USE_EMPTY_STATE = false;

const DEMO_DATA = {
  chamas: [
    {
      id: 'mwangaza',
      name: 'Mwangaza Welfare',
      role: 'chair',
      pooledCents: 28450000, // KES 284,500.00
      nextObligation: { amountCents: 500000, dueDate: '2026-06-25', status: 'due' },
      membersPaid: 9,
      membersTotal: 12,
      members: [
        { name: 'Aisha N.', initial: 'A' },
        { name: 'Brian O.', initial: 'B' },
        { name: 'Caroline W.', initial: 'C' },
        { name: 'Dennis K.', initial: 'D' },
        { name: 'Esther M.', initial: 'E' },
      ],
    },
    {
      id: 'sokoni',
      name: 'Sokoni Traders SACCO',
      role: 'treasurer',
      pooledCents: 15120000, // KES 151,200.00
      nextObligation: { amountCents: 300000, dueDate: '2026-06-20', status: 'pending_payment' },
      membersPaid: 7,
      membersTotal: 10,
      members: [
        { name: 'Faith A.', initial: 'F' },
        { name: 'Geoffrey M.', initial: 'G' },
        { name: 'Halima S.', initial: 'H' },
        { name: 'Ian R.', initial: 'I' },
      ],
    },
    {
      id: 'umoja',
      name: 'Umoja Boda Riders',
      role: 'member',
      pooledCents: 4665000, // KES 46,650.00
      nextObligation: { amountCents: 150000, dueDate: '2026-06-15', status: 'overdue' },
      membersPaid: 4,
      membersTotal: 6,
      members: [
        { name: 'James W.', initial: 'J' },
        { name: 'Kevin O.', initial: 'K' },
        { name: 'Lydia N.', initial: 'L' },
      ],
    },
  ],
  // Last settled contributions, most recent last (drawn left → right).
  chain: [
    { member: 'Aisha N.', initial: 'A', amountCents: 500000, hash: 'a3f91c27d4' },
    { member: 'Brian O.', initial: 'B', amountCents: 500000, hash: '7b2e08fa19' },
    { member: 'Geoffrey M.', initial: 'G', amountCents: 300000, hash: 'c4d77e3b60' },
    { member: 'Halima S.', initial: 'H', amountCents: 300000, hash: '1f9a52cc8d' },
    { member: 'Kevin O.', initial: 'K', amountCents: 150000, hash: 'e0c63d7a41' },
  ],
};

function SectionLabel({ children }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-muted">
      {children}
    </p>
  );
}

function PrimaryActions() {
  const handleCreate = () => console.log('[Hesabu] create a chama');
  const handleJoin = () => console.log('[Hesabu] join with code');
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Button
        onClick={handleCreate}
        className="bg-hesabu-emerald text-hesabu-ink hover:bg-hesabu-emerald-dim sm:flex-1"
      >
        Create a chama
      </Button>
      <Button
        variant="outline"
        onClick={handleJoin}
        className="border-hesabu-line bg-transparent text-hesabu-paper hover:bg-hesabu-surface-2 hover:text-hesabu-paper sm:flex-1"
      >
        Join with code
      </Button>
    </div>
  );
}

export default function ChamaHome() {
  const chamas = USE_EMPTY_STATE ? [] : DEMO_DATA.chamas;
  const isEmpty = chamas.length === 0;

  const totalCents = chamas.reduce((sum, c) => sum + (c.pooledCents || 0), 0);
  const memberCount = chamas.reduce((sum, c) => sum + (c.membersTotal || 0), 0);

  return (
    <div className="hesabu-theme">
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

        {isEmpty ? (
          <EmptyState
            onCreate={() => console.log('[Hesabu] create a chama')}
            onJoin={() => console.log('[Hesabu] join with code')}
          />
        ) : (
          <div className="space-y-8">
            {/* 1 — Treasury hero */}
            <TreasuryHero
              totalCents={totalCents}
              chamaCount={chamas.length}
              memberCount={memberCount}
            />

            <div className="h-px bg-hesabu-line" />

            {/* 2 — The signature: hash-chain ribbon */}
            <HashChainRibbon blocks={DEMO_DATA.chain} />

            <div className="h-px bg-hesabu-line" />

            {/* 3 — Your chamas */}
            <section className="space-y-4">
              <SectionLabel>Your chamas</SectionLabel>
              <div className="space-y-4">
                {chamas.map((c) => (
                  <ChamaListItem key={c.id} chama={c} />
                ))}
              </div>
            </section>

            {/* 4 — Primary actions */}
            <PrimaryActions />
          </div>
        )}
      </div>
    </div>
  );
}
