import { Box, Chip, List, ListItem, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';

import type { McpTool, McpToolMode } from './api';
import { hintWords, MODE_HELP, MODE_WORDS, REVIEW_WORDS, suggestionWords } from './mcpWords';

const TOUCH = { minHeight: { xs: 44, sm: 36 } } as const;
const MODES: McpToolMode[] = ['off', 'read', 'write'];

interface Props {
  tools: McpTool[];
  /** The tool being saved: its switch is disabled meanwhile. */
  busyId?: string | null;
  disabled?: boolean;
  onChange: (tool: McpTool, mode: McpToolMode) => void;
}

/**
 * The tools of an MCP server and the owner's decision for each: off (the default), read, or write. What the server says about a tool is
 * its CLAIM: the description is shown as plain text (never as markup), the hints are worded as claims and only suggest a default. A
 * tool that is new, or changed since the owner decided, is marked and stays off until they decide again.
 */
export function McpToolList({ tools, busyId, disabled, onChange }: Props) {
  if (tools.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 2 }}>
        The server lists no tools.
      </Typography>
    );
  }
  return (
    <List disablePadding aria-label="Tools">
      {tools.map((t) => {
        const hints = hintWords(t);
        return (
          <ListItem key={t.id} aria-label={`Tool ${t.title ?? t.name}`} divider sx={{ display: 'block', py: 1.5, px: 0 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                {t.title ?? t.name}
              </Typography>
              {t.title && t.title !== t.name && <Chip size="small" variant="outlined" label={t.name} sx={{ maxWidth: '100%' }} />}
              {t.review && <Chip size="small" color="warning" label={REVIEW_WORDS[t.review]} />}
            </Stack>
            {t.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
                {t.description}
              </Typography>
            )}
            {t.parameters.length > 0 && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
                Takes: {t.parameters.map((p) => `${p.name}${p.required ? '' : ' (optional)'}`).join(', ')}
              </Typography>
            )}
            {hints.length > 0 && (
              <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.75 }} aria-label="What the server claims">
                {hints.map((h) => (
                  <Chip key={h} size="small" variant="outlined" label={h} />
                ))}
              </Stack>
            )}
            <Box sx={{ mt: 1 }}>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={t.mode}
                disabled={disabled || busyId === t.id}
                aria-label={`What ${t.title ?? t.name} may do`}
                onChange={(_e, mode: McpToolMode | null) => {
                  if (mode && mode !== t.mode) onChange(t, mode);
                }}
                sx={{ width: { xs: '100%', sm: 'auto' } }}
              >
                {MODES.map((m) => (
                  <ToggleButton key={m} value={m} aria-label={`${MODE_WORDS[m]}: ${t.title ?? t.name}`} sx={{ ...TOUCH, flex: { xs: 1, sm: 'none' }, px: 2 }}>
                    {MODE_WORDS[m]}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                {MODE_HELP[t.mode]} {suggestionWords(t)}
              </Typography>
            </Box>
          </ListItem>
        );
      })}
    </List>
  );
}
