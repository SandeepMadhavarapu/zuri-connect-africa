import * as React from 'react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import ChamaCard from '@/components/chama/ui/ChamaCard';
import Money from '@/components/chama/ui/Money';
import StatusPill from '@/components/chama/ui/StatusPill';
import ContributionRing from '@/components/chama/ContributionRing';

const MAX_AVATARS = 4;

const ROLE_CLS = {
  chair: 'border-hesabu-emerald text-hesabu-emerald',
  treasurer: 'border-hesabu-emerald text-hesabu-emerald',
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
    name,
    role = 'member',
    pooledCents = 0,
    nextObligation,
    membersPaid = 0,
    membersTotal = 0,
    members = [],
  } = chama;

  const shown = members.slice(0, MAX_AVATARS);
  const overflow = Math.max(0, (membersTotal || members.length) - shown.length);
  const dueLabel = nextObligation ? formatDueDate(nextObligation.dueDate) : null;

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
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-hesabu-muted">Pooled</p>
        </div>
      </div>

      <div className="my-4 h-px bg-hesabu-line" />

      {/* Body: obligation + ring on the right */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-muted">
            Next contribution
          </p>
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
            <p className="text-sm text-hesabu-muted">All settled for this cycle.</p>
          )}
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <ContributionRing paid={membersPaid} total={membersTotal} />
          <span className="text-[10px] uppercase tracking-wide text-hesabu-muted">paid</span>
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
        <span className="text-xs text-hesabu-muted">{membersTotal} members</span>
      </div>
    </ChamaCard>
  );
}
