import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { formatKesFromCents, pluralize } from '@/lib/branding/hesabu';
import {
  createContributionCycle,
  MY_CHAMAS_QUERY_KEY,
} from '@/components/chama/data/chamaApi';

// Mirror the server's validation bounds (create-contribution-cycle Edge
// Function) so the user gets instant feedback. The SERVER is still the source of
// truth — these only gate the submit button + show inline errors.
const NAME_MIN = 3;
const NAME_MAX = 80;
const MAX_AMOUNT_KES = 1_000_000; // matches MAX_AMOUNT_CENTS (100,000,000) server-side.

// Friendly copy for each server error code in the confirmed contract.
const ERROR_MESSAGES = {
  GROUP_ID_REQUIRED: 'Something went wrong identifying this chama. Please reopen and try again.',
  NAME_INVALID: `Name must be ${NAME_MIN}–${NAME_MAX} characters.`,
  AMOUNT_INVALID: 'Enter a valid amount in KES.',
  DUE_DATE_INVALID: 'Pick a due date in the future.',
  GRACE_DAYS_INVALID: 'That grace period isn’t valid.',
  NOT_AUTHORIZED: 'Only the chair or treasurer can open a cycle.',
  OPEN_CYCLE_EXISTS: 'This chama already has an open cycle.',
  CYCLE_NAME_EXISTS: 'A cycle with that name already exists.',
  GROUP_NOT_ACTIVE: 'This chama isn’t active, so a cycle can’t be opened.',
  GROUP_NOT_FOUND: 'We couldn’t find this chama. Please refresh and try again.',
  NO_ACTIVE_MEMBERS: 'This chama has no active members to bill yet.',
  RATE_LIMITED: 'You’ve opened several cycles recently. Please try again later.',
  CYCLE_CREATE_FAILED: 'Something went wrong. Please try again.',
};

function messageForError(err) {
  if (
    err?.status === 401 ||
    err?.code === 'MISSING_AUTHORIZATION' ||
    err?.code === 'INVALID_TOKEN'
  ) {
    return 'Please sign in again.';
  }
  if (err?.code && ERROR_MESSAGES[err.code]) return ERROR_MESSAGES[err.code];
  if (err?.status === 429) return ERROR_MESSAGES.RATE_LIMITED;
  return 'Something went wrong. Please try again.';
}

const inputCls =
  'border-hesabu-line bg-hesabu-ink text-hesabu-paper placeholder:text-hesabu-muted ' +
  'focus-visible:ring-hesabu-emerald';

/** Local YYYY-MM-DD for a Date (avoids UTC off-by-one from toISOString). */
function toDateInputValue(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${dy}`;
}

/**
 * Open-a-cycle modal — sibling of CreateChamaDialog. Themed Hesabu (the portalled
 * content sets `.hesabu-theme` itself so the tokens resolve outside the page
 * subtree). Calls the live create-contribution-cycle Edge Function for the given
 * group; on success it invalidates the home list so the card reflects the new
 * cycle + the user's own obligation.
 *
 * @param {{ open: boolean, onOpenChange: (next: boolean) => void,
 *   groupId: string, groupName?: string }} props
 */
export default function OpenCycleDialog({ open, onOpenChange, groupId, groupName }) {
  const queryClient = useQueryClient();

  const [name, setName] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [dueDate, setDueDate] = React.useState('');
  const [touched, setTouched] = React.useState(false);

  // Earliest selectable due date is tomorrow (server requires strictly future).
  const minDue = React.useMemo(() => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return toDateInputValue(t);
  }, [open]);

  const trimmedName = name.trim();
  const nameError = !trimmedName
    ? 'Cycle name is required.'
    : trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX
      ? `Name must be ${NAME_MIN}–${NAME_MAX} characters.`
      : null;

  const amountNum = Number(amount);
  const amountError =
    amount === ''
      ? 'Amount is required.'
      : !Number.isFinite(amountNum) || amountNum <= 0
        ? 'Enter an amount greater than zero.'
        : amountNum > MAX_AMOUNT_KES
          ? `Amount can’t exceed KES ${MAX_AMOUNT_KES.toLocaleString('en-KE')}.`
          : null;

  const dueError = !dueDate
    ? 'Due date is required.'
    : dueDate < minDue
      ? 'Due date must be in the future.'
      : null;

  const canSubmit = !nameError && !amountError && !dueError;

  // Live formatted preview of what each member will owe.
  const amountPreview =
    !amountError && amount !== ''
      ? formatKesFromCents(Math.round(amountNum * 100))
      : null;

  const resetForm = React.useCallback(() => {
    setName('');
    setAmount('');
    setDueDate('');
    setTouched(false);
  }, []);

  const mutation = useMutation({
    mutationFn: () =>
      createContributionCycle({
        groupId,
        name: trimmedName,
        amountKes: amountNum,
        dueDate,
      }),
    onSuccess: ({ cycle, obligationCount }) => {
      toast.success(
        `${cycle.name} cycle opened — ${pluralize(obligationCount, 'member')} owe ` +
          `${formatKesFromCents(cycle.amount_cents)}`,
      );
      queryClient.invalidateQueries({ queryKey: MY_CHAMAS_QUERY_KEY });
      resetForm();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(messageForError(err));
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit || mutation.isPending) return;
    mutation.mutate();
  };

  // Reset when the dialog is dismissed (but never mid-flight).
  const handleOpenChange = (next) => {
    if (mutation.isPending) return;
    if (!next) resetForm();
    onOpenChange(next);
  };

  const showNameError = (touched || name.length > 0) && nameError;
  const showAmountError = (touched || amount.length > 0) && amountError;
  const showDueError = (touched || dueDate.length > 0) && dueError;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="hesabu-theme border-hesabu-line bg-hesabu-surface text-hesabu-paper sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-bold text-hesabu-paper">
            Open a cycle
          </DialogTitle>
          <DialogDescription className="text-hesabu-muted">
            {groupName
              ? `Bill every active member of ${groupName} for this round.`
              : 'Bill every active member for this round.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {/* Name */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="cycle-name" className="text-hesabu-paper">
                Name
              </Label>
              <span
                className={cn(
                  'text-[11px] tabular-nums',
                  trimmedName.length > NAME_MAX ? 'text-hesabu-danger' : 'text-hesabu-muted',
                )}
              >
                {trimmedName.length}/{NAME_MAX}
              </span>
            </div>
            <Input
              id="cycle-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="e.g. June 2026"
              maxLength={NAME_MAX + 20}
              autoFocus
              aria-invalid={Boolean(showNameError)}
              aria-describedby={showNameError ? 'cycle-name-error' : undefined}
              disabled={mutation.isPending}
              className={inputCls}
            />
            {showNameError && (
              <p id="cycle-name-error" className="text-xs text-hesabu-danger">
                {nameError}
              </p>
            )}
          </div>

          {/* Amount per member */}
          <div className="space-y-1.5">
            <Label htmlFor="cycle-amount" className="text-hesabu-paper">
              Amount per member <span className="text-hesabu-muted">(KES)</span>
            </Label>
            <Input
              id="cycle-amount"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="e.g. 1000"
              aria-invalid={Boolean(showAmountError)}
              aria-describedby={showAmountError ? 'cycle-amount-error' : undefined}
              disabled={mutation.isPending}
              className={inputCls}
            />
            {showAmountError ? (
              <p id="cycle-amount-error" className="text-xs text-hesabu-danger">
                {amountError}
              </p>
            ) : (
              <p className="text-xs text-hesabu-muted">
                {amountPreview
                  ? `Each member will owe ${amountPreview}.`
                  : 'What each member will owe this cycle.'}
              </p>
            )}
          </div>

          {/* Due date — must be in the future */}
          <div className="space-y-1.5">
            <Label htmlFor="cycle-due" className="text-hesabu-paper">
              Due date
            </Label>
            <Input
              id="cycle-due"
              type="date"
              min={minDue}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={Boolean(showDueError)}
              aria-describedby={showDueError ? 'cycle-due-error' : undefined}
              disabled={mutation.isPending}
              className={cn(inputCls, '[color-scheme:dark]')}
            />
            {showDueError && (
              <p id="cycle-due-error" className="text-xs text-hesabu-danger">
                {dueError}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={mutation.isPending}
              className="border-hesabu-line bg-transparent text-hesabu-paper hover:bg-hesabu-surface-2 hover:text-hesabu-paper"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || mutation.isPending}
              className="bg-hesabu-emerald text-hesabu-ink hover:bg-hesabu-emerald-dim"
            >
              {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mutation.isPending ? 'Opening…' : 'Open cycle'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
