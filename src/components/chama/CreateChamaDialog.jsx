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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { createChamaGroup, MY_CHAMAS_QUERY_KEY } from '@/components/chama/data/chamaApi';

// Mirror the server's validation bounds (create-chama-group Edge Function /
// chama_groups CHECK) so the user gets instant feedback. The SERVER is still
// the source of truth — these only gate the submit button + show inline errors.
const NAME_MIN = 3;
const NAME_MAX = 80;
const DESC_MAX = 500;

// Friendly copy for each server error code.
const ERROR_MESSAGES = {
  NAME_REQUIRED: 'Please enter a group name.',
  NAME_INVALID: `Name must be ${NAME_MIN}–${NAME_MAX} characters.`,
  DESCRIPTION_TOO_LONG: `Description must be ${DESC_MAX} characters or fewer.`,
  CURRENCY_INVALID: 'That currency code isn’t valid.',
  RATE_LIMITED: 'You’ve created several groups recently. Please try again later.',
  GROUP_CREATE_FAILED: 'Something went wrong. Please try again.',
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

/**
 * Create-a-chama modal. Themed Hesabu (the portalled content sets `.hesabu-theme`
 * itself so the tokens resolve outside the page subtree). Calls the live
 * create-chama-group Edge Function; on success it invalidates the home list so
 * the new group appears.
 */
export default function CreateChamaDialog({ open, onOpenChange }) {
  const queryClient = useQueryClient();

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [currency] = React.useState('KES');
  const [touched, setTouched] = React.useState(false);

  const trimmedName = name.trim();
  const nameError =
    !trimmedName
      ? 'Group name is required.'
      : trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX
        ? `Name must be ${NAME_MIN}–${NAME_MAX} characters.`
        : null;
  const descError = description.length > DESC_MAX ? `Max ${DESC_MAX} characters.` : null;
  const canSubmit = !nameError && !descError;

  const resetForm = React.useCallback(() => {
    setName('');
    setDescription('');
    setTouched(false);
  }, []);

  const mutation = useMutation({
    mutationFn: () =>
      createChamaGroup({
        name: trimmedName,
        description: description.trim() || undefined,
        currency,
      }),
    onSuccess: (group) => {
      toast.success(`“${group.name}” created`);
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="hesabu-theme border-hesabu-line bg-hesabu-surface text-hesabu-paper sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-bold text-hesabu-paper">
            Create a chama
          </DialogTitle>
          <DialogDescription className="text-hesabu-muted">
            Start a savings group your members can actually audit.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {/* Name */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="chama-name" className="text-hesabu-paper">
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
              id="chama-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="e.g. Mwangaza Welfare"
              maxLength={NAME_MAX + 20}
              autoFocus
              aria-invalid={Boolean(showNameError)}
              aria-describedby={showNameError ? 'chama-name-error' : undefined}
              disabled={mutation.isPending}
              className={inputCls}
            />
            {showNameError && (
              <p id="chama-name-error" className="text-xs text-hesabu-danger">
                {nameError}
              </p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="chama-description" className="text-hesabu-paper">
                Description <span className="text-hesabu-muted">(optional)</span>
              </Label>
              <span
                className={cn(
                  'text-[11px] tabular-nums',
                  descError ? 'text-hesabu-danger' : 'text-hesabu-muted',
                )}
              >
                {description.length}/{DESC_MAX}
              </span>
            </div>
            <Textarea
              id="chama-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this group saving for?"
              rows={3}
              aria-invalid={Boolean(descError)}
              aria-describedby={descError ? 'chama-description-error' : undefined}
              disabled={mutation.isPending}
              className={cn(inputCls, 'resize-none')}
            />
            {descError && (
              <p id="chama-description-error" className="text-xs text-hesabu-danger">
                {descError}
              </p>
            )}
          </div>

          {/* Currency — KES only for now */}
          <div className="space-y-1.5">
            <Label htmlFor="chama-currency" className="text-hesabu-paper">
              Currency
            </Label>
            <Input
              id="chama-currency"
              value={currency}
              readOnly
              disabled
              className={cn(inputCls, 'cursor-not-allowed opacity-80')}
            />
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
              {mutation.isPending ? 'Creating…' : 'Create chama'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
