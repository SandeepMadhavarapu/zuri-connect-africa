import * as React from 'react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import ChamaCard from '@/components/chama/ui/ChamaCard';
import Money from '@/components/chama/ui/Money';
import StatusPill from '@/components/chama/ui/StatusPill';
import Eyebrow from '@/components/chama/ui/Eyebrow';
import ContributionRing from '@/components/chama/ContributionRing';
import OpenCycleDialog from '@/components/chama/OpenCycleDialog';
import { pluralize } from '@/lib/branding/hesabu';

const MAX_AVATARS = 4;

// Roles permitted to open a contribution cycle (mirrors the Edge Function's
// AUTHORIZED_ROLES). A plain member can never open one.
const CYCLE_ROLES = new Set(['chair', 'treasurer']);

const ROLE_CLS = {
  chair: 'border-hesabu-emerald bg-hesabu-emerald/10 text-hesabu-emerald',
  treasurer: 'border-hesabu-emerald bg-hesabu-emerald/10 text-hesabu-emerald',
  member: 'border-hesabu-line text-hesabu-muted',
};

function RolePill({ role }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border bg-hesabu-surface px-2.5 py-0.5',
        'text-[11px] font-semibold uppercase tracking-wide',
        ROLE_CLS[role] || ROLE_CLS.member,
      )}
    >
      {role}
    </span>
  );
}

function formatDueDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

/**
 * One chama, rendered with real internal hierarchy (not a flat row): the group
 * identity + your role, the pooled amount, the next obligation with its status,
 * a stack of member avatars, and an animated contribution ring for this cycle.
 * Hover-lift comes from ChamaCard.
 */
export default function ChamaListItem({ chama }) {
  const {
    id,
    name,
    role = 'member',
    pooledCents = 0,
    nextObligation,
    membersPaid = 0,
    membersTotal = 0,
    members = [],
    hasActiveCycle = true,
  } = chama;

  const [cycleOpen, setCycleOpen] = React.useState(false);

  const shown = members.slice(0, MAX_AVATARS);
  const overflow = Math.max(0, (membersTotal || members.length) - shown.length);
  const dueLabel = nextObligation ? formatDueDate(nextObligation.dueDate) : null;

  // Only a chair/treasurer of a group with no open cycle may open one. A plain
  // member never sees the button; once a cycle is active, nobody does.
  const canOpenCycle = !hasActiveCycle && CYCLE_ROLES.has(role);

  return (
    <ChamaCard className="p-4">
      {/* Header: name + role, pooled amount on the right */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-lg font-semibold text-hesabu-paper">
            {name}
          </h3>
          <div className="mt-1.5">
            <RolePill role={role} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          <Money cents={pooledCents} className="text-base font-semibold" />
          <Eyebrow className="mt-0.5">Pooled</Eyebrow>
        </div>
      </div>

      <div className="my-4 h-px bg-hesabu-line" />

      {/* Body: obligation + ring on the right */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Eyebrow>Next contribution</Eyebrow>
          {nextObligation ? (
            <>
              <div className="flex items-baseline gap-2">
                <Money cents={nextObligation.amountCents} className="text-sm font-semibold" />
                {dueLabel && (
                  <span className="text-xs text-hesabu-muted">due {dueLabel}</span>
                )}
              </div>
              <StatusPill status={nextObligation.status} />
            </>
          ) : (
            <div className="space-y-2.5">
              <p className="text-sm text-hesabu-muted">
                {hasActiveCycle ? 'All settled for this cycle.' : 'No active cycle yet.'}
              </p>
              {canOpenCycle && (
                <Button
                  size="sm"
                  onClick={() => setCycleOpen(true)}
                  className="bg-hesabu-emerald font-semibold text-hesabu-ink shadow-[0_4px_14px_-4px_rgba(31,157,107,0.45)] transition-shadow hover:bg-hesabu-emerald-dim hover:shadow-[0_8px_24px_-6px_rgba(31,157,107,0.6)]"
                >
                  Open a cycle
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <ContributionRing paid={membersPaid} total={membersTotal} />
          <Eyebrow as="span">paid</Eyebrow>
        </div>
      </div>

      {/* Footer: member avatar stack */}
      <div className="mt-4 flex items-center gap-2">
        <div className="flex items-center">
          {shown.map((m, i) => (
            <Avatar
              key={m.name || i}
              className={cn('h-7 w-7 ring-2 ring-hesabu-surface', i > 0 && '-ml-2')}
            >
              <AvatarFallback className="bg-hesabu-surface-2 text-[11px] font-semibold text-hesabu-paper">
                {m.initial}
              </AvatarFallback>
            </Avatar>
          ))}
          {overflow > 0 && (
            <span className="-ml-2 flex h-7 w-7 items-center justify-center rounded-full bg-hesabu-surface-2 text-[11px] font-semibold text-hesabu-muted ring-2 ring-hesabu-surface">
              +{overflow}
            </span>
          )}
        </div>
        <span className="text-xs text-hesabu-muted">
          {pluralize(membersTotal, 'member')}
        </span>
      </div>

      {/* Each card owns its own cycle dialog, scoped to THIS group. On success
          the dialog invalidates the home query, so this card refetches and
          shows the live cycle + the user's obligation + the ring. */}
      {canOpenCycle && (
        <OpenCycleDialog
          open={cycleOpen}
          onOpenChange={setCycleOpen}
          groupId={id}
          groupName={name}
        />
      )}
    </ChamaCard>
  );
}
