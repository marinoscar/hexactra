// An answer-type provider through the AI service (OpenAI web search, E50.9): no key field; the model it answers with, chosen by the
// administrator. Moved here from the old Web search pages by E50.14 (#984).
import { Button, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import { AI_SERVICE_COST_TEXT, AI_SERVICE_KEY_TEXT } from './webSearchWords';

export function AiServiceProviderSettings({ model, disabled, onSave }: { model: string | null; disabled: boolean; onSave: (model: string | null) => void }) {
  const [value, setValue] = useState(model ?? '');
  useEffect(() => setValue(model ?? ''), [model]);
  const v = value.trim();
  const bad = v !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v);
  return (
    <Stack spacing={1}>
      <Typography variant="body2">{AI_SERVICE_KEY_TEXT} It needs AI on, Web search switched on under hosted tools in Administration → AI, and a model chosen here.</Typography>
      <Typography variant="body2" color="text.secondary">
        {AI_SERVICE_COST_TEXT}
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField size="small" label="Model for web search" value={value} disabled={disabled} error={bad} helperText={bad ? 'A model id of the AI catalogue' : model ? 'A model of the AI catalogue' : 'Not chosen: this provider is not used'} onChange={(e) => setValue(e.target.value)} sx={{ flex: 1 }} />
        <Button variant="outlined" sx={{ minHeight: 40 }} disabled={disabled || bad || v === (model ?? '')} onClick={() => onSave(v === '' ? null : v)}>
          Save model
        </Button>
      </Stack>
    </Stack>
  );
}
