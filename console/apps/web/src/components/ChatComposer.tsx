import SendIcon from '@mui/icons-material/Send';
import { Box, IconButton, InputBase, Paper, Tooltip } from '@mui/material';
import { useEffect, useRef, type KeyboardEvent } from 'react';

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
}

/** The message field and its send button. Stays usable while the agent works. */
export function ChatComposer({ value, onChange, onSend, busy = false, placeholder = 'Message', enterSends, autoFocus = false }: ChatComposerProps) {
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
      sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.5, pl: 2, pr: 0.5, py: 0.5, borderRadius: 6, bgcolor: 'background.paper', '&:focus-within': { borderColor: 'primary.main' } }}
    >
      <InputBase
        inputRef={input}
        multiline
        maxRows={6}
        fullWidth
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        inputProps={{ 'aria-label': 'Message', maxLength: CHAT_MESSAGE_MAX, enterKeyHint: enterSends ? 'send' : 'enter' }}
        // 16 px on a phone: a smaller field makes iOS zoom the page on focus.
        sx={{ py: 1, fontSize: { xs: 16, sm: 'inherit' } }}
      />
      <Tooltip title="Send">
        <Box component="span">
          <IconButton type="submit" color="primary" aria-label="Send" disabled={!canSend} sx={{ width: 44, height: 44 }}>
            <SendIcon />
          </IconButton>
        </Box>
      </Tooltip>
    </Paper>
  );
}
