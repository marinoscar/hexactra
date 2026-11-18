import AddIcon from '@mui/icons-material/Add';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { paramKey, parseGoal } from './model';

/** A stretch of the goal as the overlay draws it. */
export type GoalPiece = { text: string; kind: 'plain' | 'token' | 'error' };

/**
 * The goal cut into what the field highlights: each `{{Name}}` placeholder a
 * token, each malformed one (from the shared parser's errors) underlined, the
 * rest plain. The pieces join back to the goal exactly.
 */
export function goalPieces(goal: string): GoalPiece[] {
  const { segments, errors } = parseGoal(goal);
  const marks: { start: number; end: number; kind: 'token' | 'error' }[] = [];
  for (const s of segments) if ('key' in s) marks.push({ start: s.start, end: s.end, kind: 'token' });
  for (const e of errors) {
    const close = goal.indexOf('}}', e.position + 2);
    const nextOpen = goal.indexOf('{{', e.position + 2);
    const end = close >= 0 && (nextOpen < 0 || close < nextOpen) ? close + 2 : e.position + 2;
    marks.push({ start: e.position, end, kind: 'error' });
  }
  marks.sort((a, b) => a.start - b.start);
  const out: GoalPiece[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start < at) continue;
    if (m.start > at) out.push({ text: goal.slice(at, m.start), kind: 'plain' });
    out.push({ text: goal.slice(m.start, m.end), kind: m.kind });
    at = m.end;
  }
  if (at < goal.length) out.push({ text: goal.slice(at), kind: 'plain' });
  return out;
}

/** Why a typed parameter name cannot be used, or null. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the parameter a name';
  if (n.length > 40) return 'At most 40 characters';
  if (!/^[\p{L}\p{N} _-]+$/u.test(n)) return 'Use letters, digits, spaces, _ and -';
  if (!paramKey(n)) return 'Use at least one letter or digit';
  return null;
}

export interface GoalFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string | null;
  /** The helper text under the field (the goal's help and counter). */
  helperText: ReactNode;
  maxLength: number;
  /** Shows the "Insert parameter" button (#556). */
  canInsert?: boolean;
}

/**
 * The task goal (#556): one plain, labelled text area whose `{{Name}}`
 * placeholders are drawn as tokens by an overlay behind its text, so a screen
 * reader still reads a single field with the goal as its value. A malformed
 * placeholder is underlined and the parser's message is the field's error.
 * "Insert parameter" asks for a name and puts `{{Name}}` at the caret.
 */
export function GoalField({ value, onChange, label = 'Goal', required, disabled, error, helperText, maxLength, canInsert = true }: GoalFieldProps) {
  const uid = useId();
  const input = useRef<HTMLTextAreaElement | null>(null);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const pieces = useMemo(() => goalPieces(value), [value]);
  const parseError = useMemo(() => parseGoal(value).errors[0]?.message ?? null, [value]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const problem = nameProblem(name);

  const remember = () => {
    const el = input.current;
    if (el) caret.current = { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length };
  };
  const insert = () => {
    if (problem) return setNameTouched(true);
    const token = `{{${name.trim()}}}`;
    const at = caret.current ?? { start: value.length, end: value.length };
    const next = `${value.slice(0, at.start)}${token}${value.slice(at.end)}`.slice(0, maxLength);
    onChange(next);
    setNaming(false);
    setName('');
    setNameTouched(false);
    const pos = at.start + token.length;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange?.(pos, pos);
    });
  };

  const shownError = error ?? parseError;
  const hasMarks = pieces.some((p) => p.kind !== 'plain');
  return (
    <Box>
      <Box sx={{ position: 'relative' }}>
        <TextField
          label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onSelect={remember}
          onBlur={remember}
          required={required}
          fullWidth
          multiline
          minRows={4}
          disabled={disabled}
          error={Boolean(shownError)}
          helperText={shownError ? <span>{shownError}</span> : helperText}
          inputRef={input}
          slotProps={{
            htmlInput: { maxLength, 'aria-describedby': hasMarks ? `${uid}-tokens` : undefined },
            input: {
              sx: {
                position: 'relative',
                '& textarea': { position: 'relative', zIndex: 1, background: 'transparent' },
              },
              startAdornment: hasMarks ? (
                // Drawn behind the text area's own text: the same font, padding and wrapping, the text itself transparent.
                <Box
                  aria-hidden
                  data-testid="goal-overlay"
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    padding: '16.5px 14px',
                    pointerEvents: 'none',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'break-word',
                    wordBreak: 'break-word',
                    color: 'transparent',
                    typography: 'body1',
                    lineHeight: '1.4375em',
                    letterSpacing: 'inherit',
                    overflow: 'hidden',
                    zIndex: 0,
                  }}
                >
                  {pieces.map((p, i) =>
                    p.kind === 'plain' ? (
                      <span key={i}>{p.text}</span>
                    ) : p.kind === 'token' ? (
                      <Box key={i} component="mark" data-token sx={(t) => ({ color: 'transparent', bgcolor: alpha(t.palette.primary.main, 0.18), borderRadius: 1, boxShadow: `0 0 0 1px ${alpha(t.palette.primary.main, 0.4)}` })}>
                        {p.text}
                      </Box>
                    ) : (
                      <Box key={i} component="span" data-malformed sx={{ textDecoration: 'underline wavy', textDecorationColor: (t) => t.palette.error.main, textUnderlineOffset: '3px' }}>
                        {p.text}
                      </Box>
                    ),
                  )}
                </Box>
              ) : undefined,
            },
          }}
        />
        {hasMarks && (
          <Box id={`${uid}-tokens`} sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {`Parameters: ${pieces
              .filter((p) => p.kind === 'token')
              .map((p) => p.text.slice(2, -2).trim())
              .filter((n, i, all) => all.indexOf(n) === i)
              .join(', ')}`}
          </Box>
        )}
      </Box>
      {canInsert && (
        <Button size="small" startIcon={<AddIcon />} disabled={disabled} onMouseDown={remember} onClick={() => setNaming(true)} sx={{ mt: 0.5, minHeight: { xs: 44, sm: 'auto' } }}>
          Insert parameter
        </Button>
      )}
      <Dialog open={naming} onClose={() => setNaming(false)} aria-labelledby={`${uid}-insert`} fullWidth maxWidth="xs">
        <DialogTitle id={`${uid}-insert`}>Insert a parameter</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                insert();
              }
            }}
            error={nameTouched && Boolean(problem)}
            helperText={nameTouched && problem ? problem : 'What the blank is, for example Amount or Phone Number. You fill it in each time the task runs, or give it a saved value.'}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNaming(false)} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={insert} sx={{ minHeight: 44 }}>
            Insert
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
