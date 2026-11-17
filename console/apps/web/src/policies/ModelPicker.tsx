import { Autocomplete, Box, Chip, TextField, Typography } from '@mui/material';
import type { UsableAiModel } from '@marinoscar/platform-web/ai/headless';
import type { ReactNode } from 'react';

/** `provider:modelId`, as the platform's catalogue and the policy pins name a model. */
export const modelKey = (m: Pick<UsableAiModel, 'provider' | 'modelId'>) => `${m.provider}:${m.modelId}`;

export const hasTools = (m: UsableAiModel) => m.capabilities.capabilities.includes('tools');
export const hasVision = (m: UsableAiModel) => m.capabilities.capabilities.includes('vision_input') || m.capabilities.inputModalities.includes('image');

export interface ModelPickerProps {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  /** The models the viewer can call (`useUsableAiModels`). Only those with tool calls are offered. */
  models: readonly UsableAiModel[];
  /** A pin must also accept images: models without vision are listed but disabled. */
  requireVision?: boolean;
  helperText?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  size?: 'small' | 'medium';
}

/**
 * A model picker over the platform AI catalogue. The browser agent needs tool
 * calls, so only models with tools are offered; a model without image input
 * is labelled "no vision" (the run then works without screenshots). A typed
 * `provider:modelId` is accepted too; the API validates it on save.
 */
export function ModelPicker({ label, value, onChange, models, requireVision, helperText, placeholder, disabled, size = 'small' }: ModelPickerProps) {
  const usable = models.filter(hasTools);
  const byKey = new Map(usable.map((m) => [modelKey(m), m]));
  const options = usable.map(modelKey);

  return (
    <Autocomplete
      freeSolo
      size={size}
      disabled={disabled}
      options={options}
      value={value}
      inputValue={value ?? ''}
      getOptionDisabled={(key) => Boolean(requireVision && byKey.get(key) && !hasVision(byKey.get(key)!))}
      onChange={(_e, next) => onChange(typeof next === 'string' && next.trim() ? next.trim() : null)}
      onInputChange={(_e, next, reason) => {
        if (reason === 'input' || reason === 'clear') onChange(next.trim() ? next.trim() : null);
      }}
      renderOption={(props, key) => {
        const m = byKey.get(key)!;
        const { key: itemKey, ...rest } = props as typeof props & { key: string };
        return (
          <Box component="li" key={itemKey} {...rest} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2">{m.displayName ?? m.modelId}</Typography>
              <Typography variant="caption" color="text.secondary">
                {key}
              </Typography>
            </Box>
            {!hasVision(m) && <Chip size="small" variant="outlined" label={requireVision ? 'no vision: cannot be pinned' : 'no vision'} />}
          </Box>
        );
      }}
      renderInput={(params) => <TextField {...params} label={label} placeholder={placeholder} helperText={helperText} />}
    />
  );
}

/** The display name of a model key, when the catalogue knows it. */
export function modelName(models: readonly UsableAiModel[], key: string | null | undefined): string | null {
  if (!key) return null;
  const m = models.find((x) => modelKey(x) === key || x.modelId === key);
  return m?.displayName ?? key;
}
