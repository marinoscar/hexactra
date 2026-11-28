import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import { Box, IconButton, InputBase, Paper, Stack, Tooltip } from '@mui/material';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { CHAT_MESSAGE_MAX } from './chatThread';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Send what is typed. The composer does not clear itself: the page does, once the send went through. */
  onSend: () => void;
  busy?: boolean;
  placeholder?: string;
  /** On a phone Enter breaks the line (the keyboard has no Shift+Enter worth using); elsewhere Enter sends. */
  enterSends: boolean;
  /** Put the cursor in the field when the composer appears (a desktop; never a phone, where it would open the keyboard). */
  autoFocus?: boolean;
  /** The chat's options (#713), drawn in the toolbar under the field, left of Send: the "+" button and the chips of the policy and the machine. */
  options?: ReactNode;
}

/** The message field, its options and its send button. Stays usable while the agent works. */
export function ChatComposer({ value, onChange, onSend, busy = false, placeholder = 'Message', enterSends, autoFocus = false, options }: ChatComposerProps) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const canSend = value.trim().length > 0 && !busy;

  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    // Not while an input method is composing (Enter then picks a candidate).
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const send = enterSends ? !e.shiftKey : e.metaKey || e.ctrlKey;
    if (!send) return;
    e.preventDefault();
    if (canSend) onSend();
  };

  return (
    <Paper
      component="form"
      variant="outlined"
      aria-label="Send a message"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
      // A card with a modest corner, not a pill: a pill's corners cut into the first and last line of a long message.
      sx={{ display: 'flex', flexDirection: 'column', px: 1, pt: 0.5, pb: 0.75, borderRadius: '18px', bgcolor: 'background.paper', boxShadow: 'none', transition: 'border-color 120ms', '&:focus-within': { borderColor: 'primary.main' } }}
    >
      <InputBase
        inputRef={input}
        multiline
        maxRows={8}
        fullWidth
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        inputProps={{ 'aria-label': 'Message', maxLength: CHAT_MESSAGE_MAX, enterKeyHint: enterSends ? 'send' : 'enter' }}
        // 16 px on a phone: a smaller field makes iOS zoom the page on focus.
        sx={{ px: 1, py: 1, fontSize: { xs: 16, sm: 'inherit' } }}
      />
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minHeight: 44 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flex: 1, minWidth: 0, overflow: 'hidden' }} role="group" aria-label="Chat options">
          {options}
        </Stack>
        <Tooltip title="Send">
          <Box component="span">
            <IconButton
              type="submit"
              aria-label="Send"
              disabled={!canSend}
              sx={{
                width: 40,
                height: 40,
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                '&:hover': { bgcolor: 'primary.dark' },
                '&.Mui-disabled': { bgcolor: 'action.disabledBackground', color: 'action.disabled' },
              }}
            >
              <ArrowUpwardIcon />
            </IconButton>
          </Box>
        </Tooltip>
      </Stack>
    </Paper>
  );
}
