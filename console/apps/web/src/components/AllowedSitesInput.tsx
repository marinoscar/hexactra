import { Autocomplete, Chip, TextField } from '@mui/material';
import { useState, type ClipboardEvent, type FocusEvent } from 'react';

import { MAX_ALLOWED_DOMAINS, addDomains, isValidDomain, splitDomains } from '../taskForm/values';

export interface AllowedSitesInputProps {
  value: string[];
  onChange: (domains: string[]) => void;
  disabled?: boolean;
  /** A message for the whole field (an invalid chip, a server refusal). */
  error?: string;
  id?: string;
}

export const ALLOWED_SITES_HELP = 'Leave empty to allow any site. Use *.example.test for every subdomain. Web search and page reading stay inside these sites.';

/**
 * The sites a task may visit, as chips. Enter, a comma, a space or a paste
 * adds what was typed; a URL keeps its hostname; entries are lower-cased and
 * a duplicate is ignored. A chip the server would refuse is marked.
 */
export function AllowedSitesInput({ value, onChange, disabled, error, id }: AllowedSitesInputProps) {
  const [text, setText] = useState('');
  const full = value.length >= MAX_ALLOWED_DOMAINS;
  const add = (entries: string[]) => {
    const next = addDomains(value, entries);
    if (next.length !== value.length) onChange(next);
  };
  const commit = () => {
    if (text.trim()) add(splitDomains(text));
    setText('');
  };
  return (
    <Autocomplete
      multiple
      freeSolo
      id={id}
      options={[] as string[]}
      value={value}
      inputValue={text}
      disabled={disabled}
      clearOnBlur={false}
      // Enter adds what is typed (through the same normalisation); a removed chip arrives here too.
      onChange={(_, next, reason) => {
        if (reason === 'createOption') commit();
        else onChange(next.filter((d) => value.includes(d)));
      }}
      onInputChange={(_, next, reason) => {
        if (reason === 'reset') return;
        // A comma or a space ends an entry: everything before the last separator becomes chips.
        if (/[\s,;]/.test(next)) {
          const parts = next.split(/[\s,;]+/);
          const rest = /[\s,;]$/.test(next) ? '' : (parts.pop() ?? '');
          add(parts.filter(Boolean));
          setText(rest);
        } else setText(next);
      }}
      renderValue={(domains, getItemProps) =>
        domains.map((domain, index) => {
          const { key, ...props } = getItemProps({ index });
          return <Chip key={key} size="small" label={domain} color={isValidDomain(domain) ? 'default' : 'error'} {...props} />;
        })
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label="Allowed sites"
          placeholder={value.length === 0 ? 'Any site' : undefined}
          error={Boolean(error)}
          helperText={error ?? (full ? `${ALLOWED_SITES_HELP} (${MAX_ALLOWED_DOMAINS} at most.)` : ALLOWED_SITES_HELP)}
          slotProps={{
            ...params.slotProps,
            htmlInput: {
              ...params.slotProps.htmlInput,
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
              inputMode: 'url',
              onBlur: (e: FocusEvent<HTMLInputElement>) => {
                params.slotProps.htmlInput.onBlur?.(e);
                commit();
              },
              onPaste: (e: ClipboardEvent<HTMLInputElement>) => {
                const pasted = e.clipboardData.getData('text');
                if (!pasted) return;
                e.preventDefault();
                add(splitDomains(`${text} ${pasted}`));
                setText('');
              },
            },
          }}
        />
      )}
    />
  );
}
