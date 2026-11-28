import { Alert, Box, Button, Card, CardContent, CircularProgress, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import { useUsableAiModels } from '@marinoscar/platform-web/ai/headless';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { getAiHelpers, saveAiHelpers, type AiHelpersSettings } from '../policies/api';
import { ModelPicker, modelKey } from '../policies/ModelPicker';
import { errorText } from '../policies/usePolicyCatalog';
import { PageContainer, PageHeader } from '../ui';

/** `provider:modelId`, as the API stores a pick. */
const PICK = /^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const EMPTY_NOTE = 'Empty uses your default model.';
const pickError = (v: string | null) => (v && !PICK.test(v) ? 'Choose a model from the list, or type provider:model' : null);

/**
 * Helper models (`/settings/helper-models`, E55.1, #1094): the model that
 * writes the short titles of runs and chats, and the model that creates and
 * improves tasks. Empty is the owner's default AI model. These are not
 * browser-agent calls, so they are outside the model tiers.
 */
export function HelperModelsPage() {
  const { api, viewer } = usePlatformHost();
  const { models, error: modelsError } = useUsableAiModels();
  const canWrite = viewer.hasPermission('user_settings:write');
  const [draft, setDraft] = useState<AiHelpersSettings | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const got = await getAiHelpers(api);
      setDraft(got.settings);
      setVersion(got.version);
    } catch (e) {
      setError(errorText(e, 'Could not load the helper models'));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const update = (patch: Partial<AiHelpersSettings>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const known = new Set(models.map(modelKey));
  /** A saved pick the catalogue no longer offers: the default model is used until the owner picks again. */
  const gone = (v: string | null) => Boolean(v && models.length > 0 && PICK.test(v) && !known.has(v));
  const invalid = !draft || Boolean(pickError(draft.titleModel) || pickError(draft.taskModel));

  const save = async () => {
    if (!draft || invalid) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await saveAiHelpers(api, draft, version);
      setDraft(next.settings);
      setVersion(next.version);
      setSaved(true);
    } catch (e) {
      setError(isPlatformApiError(e) && (e.status === 409 || e.status === 412) ? 'These settings changed elsewhere; reload the page and try again.' : errorText(e, 'Could not save the helper models'));
    } finally {
      setSaving(false);
    }
  };

  const goneNote = 'This model can no longer be used. Your default model is used until you pick another.';

  return (
    <PageContainer width="narrow">
      <PageHeader title="Helper models" subtitle="The models for the small jobs around the agent. Leave one empty to use your default AI model. The models a run itself uses are set in Model tiers." />
      {modelsError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          The model list could not be loaded. You can still type a model as provider:model.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!draft && !error && <CircularProgress aria-label="Loading" />}
      {draft && (
        <Stack spacing={2}>
          <Card variant="outlined" component="section" aria-label="Titles">
            <CardContent>
              <Typography variant="h6" component="h2" sx={{ fontSize: '1.1rem' }}>
                Titles
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                A short name for each run and chat, written from what you asked. A small, fast model is enough.
              </Typography>
              <ModelPicker
                label="Title model"
                value={draft.titleModel}
                onChange={(v) => update({ titleModel: v })}
                models={models}
                requireTools={false}
                disabled={!canWrite}
                placeholder="My default model"
                helperText={pickError(draft.titleModel) ?? (gone(draft.titleModel) ? goneNote : EMPTY_NOTE)}
              />
              <Stack sx={{ mt: 1 }}>
                <FormControlLabel control={<Switch checked={draft.runTitles} disabled={!canWrite} onChange={(e) => update({ runTitles: e.target.checked })} />} label="Write a short title for each run" />
                <FormControlLabel control={<Switch checked={draft.chatTitles} disabled={!canWrite} onChange={(e) => update({ chatTitles: e.target.checked })} />} label="Write a short title for each chat" />
              </Stack>
            </CardContent>
          </Card>
          <Card variant="outlined" component="section" aria-label="Task creation">
            <CardContent>
              <Typography variant="h6" component="h2" sx={{ fontSize: '1.1rem' }}>
                Task creation
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Used by Build with AI, by the chat when it drafts a task, and by Improve this task. A stronger model writes better tasks.
              </Typography>
              <ModelPicker
                label="Task model"
                value={draft.taskModel}
                onChange={(v) => update({ taskModel: v })}
                models={models}
                disabled={!canWrite}
                placeholder="My default model"
                helperText={pickError(draft.taskModel) ?? (gone(draft.taskModel) ? goneNote : EMPTY_NOTE)}
              />
            </CardContent>
          </Card>
          {saved && <Alert severity="success">Saved. The next title and the next task use these models.</Alert>}
          {canWrite && (
            <Box>
              <Button variant="contained" disabled={saving || invalid} onClick={() => void save()}>
                Save
              </Button>
            </Box>
          )}
        </Stack>
      )}
    </PageContainer>
  );
}
