import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, TextField } from '@mui/material';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useBreakpoint } from './useBreakpoint';

export interface ConfirmOptions {
  title: string;
  /** What will happen, in a sentence or two. */
  body?: ReactNode;
  /** The confirm button; default "Confirm". */
  confirmLabel?: string;
  /** The cancel button; default "Cancel". */
  cancelLabel?: string;
  /** Colours the confirm button `error` and starts focus on Cancel. */
  destructive?: boolean;
  /** A word the user must type before the confirm button enables ("delete"). */
  requireText?: string;
}

/** Asks the user; resolves `true` on confirm, `false` on Cancel, Escape and a backdrop click. Never rejects. */
export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  /** Cancel, Escape and a backdrop click. */
  onCancel: () => void;
}

/** Room the title, the actions and the dialog's margins take, when deciding whether the body fits the viewport. */
const CHROME_PX = 200;

/**
 * The one confirmation dialog. Pages do not render it: they call
 * `useConfirm()`. On a phone the buttons stack full-width, and the dialog goes
 * full-screen only when its body is taller than the viewport.
 */
export function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false, requireText, onConfirm, onCancel }: ConfirmDialogProps) {
  const { isPhone } = useBreakpoint();
  const titleId = useId();
  const bodyId = useId();
  // State, not a ref: the dialog mounts through a portal, after this component's first layout effect.
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [typed, setTyped] = useState('');
  const [tall, setTall] = useState(false);

  useEffect(() => {
    if (open) setTyped('');
  }, [open, requireText]);

  // Full-screen on a phone only when the body does not fit the viewport.
  useLayoutEffect(() => {
    if (!open || !isPhone) return setTall(false);
    setTall(content !== null && content.scrollHeight + CHROME_PX > window.innerHeight);
  }, [open, isPhone, content, body, requireText]);

  const matches = requireText === undefined || typed.trim() === requireText;
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      fullWidth
      maxWidth="xs"
      fullScreen={isPhone && tall}
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
    >
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        {title}
      </DialogTitle>
      <DialogContent ref={setContent}>
        {body &&
          (typeof body === 'string' ? (
            <DialogContentText id={bodyId} sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              {body}
            </DialogContentText>
          ) : (
            <div id={bodyId}>{body}</div>
          ))}
        {requireText !== undefined && (
          <TextField
            fullWidth
            margin="normal"
            size="small"
            label={`Type “${requireText}” to confirm`}
            value={typed}
            autoComplete="off"
            autoFocus={!destructive}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches) onConfirm();
            }}
          />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, flexDirection: { xs: 'column-reverse', sm: 'row' }, gap: 1, '& > :not(style) ~ :not(style)': { ml: { xs: 0, sm: 1 } } }}>
        <Button onClick={onCancel} autoFocus={destructive} sx={{ width: { xs: '100%', sm: 'auto' }, minHeight: { xs: 44, sm: 'auto' } }}>
          {cancelLabel}
        </Button>
        <Button
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          disabled={!matches}
          autoFocus={!destructive && requireText === undefined}
          onClick={onConfirm}
          sx={{ width: { xs: '100%', sm: 'auto' }, minHeight: { xs: 44, sm: 'auto' } }}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const ConfirmContext = createContext<Confirm | null>(null);

/**
 * Mounted once inside the shell (App.tsx): renders the dialog `useConfirm()`
 * opens. One question at a time: asking again while a dialog is open answers
 * the earlier one `false`.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ options: ConfirmOptions; open: boolean } | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);

  const settle = useCallback((answer: boolean) => {
    resolver.current?.(answer);
    resolver.current = null;
    // Keep the options while the dialog closes, so its text does not blank mid-transition.
    setState((s) => (s ? { ...s, open: false } : s));
  }, []);

  const confirm = useCallback<Confirm>((options) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setState({ options, open: true });
    });
  }, []);

  // Unmounting (sign-out, a route outside the shell) answers a pending question "no".
  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    [],
  );

  const value = useMemo(() => confirm, [confirm]);
  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {state && <ConfirmDialog {...state.options} open={state.open} onConfirm={() => settle(true)} onCancel={() => settle(false)} />}
    </ConfirmContext.Provider>
  );
}

/**
 * The confirmation every destructive action goes through:
 *
 * ```tsx
 * const confirm = useConfirm();
 * if (await confirm({ title: 'Delete this schedule?', confirmLabel: 'Delete', destructive: true })) await remove();
 * ```
 */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm() needs a <ConfirmProvider> above it (App.tsx mounts one inside the shell; a test wraps the page in one).');
  return confirm;
}
