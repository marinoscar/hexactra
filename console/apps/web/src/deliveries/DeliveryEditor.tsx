// The editor of one delivery (E39.10, #607): a dialog with the settings of its kind (email, spreadsheet row, folder, webhook), a "when",
// the checks that mirror the server's, and, for an email, the confirmation of addresses that are not the owner's. It edits a working copy:
// nothing changes in the form until Done, and nothing is sent until the task is saved.
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  IconButton,
  InputLabel,
  ListSubheader,
  Menu,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useMemo, useState, type ReactNode } from 'react';

import type { Connection } from '../connections/api';
import type { ConnectionFile } from '../connections/files';
import type { TaskOutput } from '../taskOutputs/model';
import { effectiveKeys } from '../taskOutputs/model';
import { FileChooserDialog } from './FileChooserDialog';
import {
  DEFAULT_NAME_TEMPLATE,
  DEFAULT_SUBJECT,
  KIND_ADD_LABEL,
  RUN_FIELDS,
  RUN_FIELD_LABEL,
  WHEN_LABEL,
  WHEN_ORDER,
  connectionFits,
  draftProblems,
  exampleName,
  fillFromOutputs,
  placeholderMenu,
  sampleRow,
  sampleValue,
  splitAddresses,
  type ColumnSource,
  type DeliveryDraft,
  type DeliveryWhen,
  type DraftProblems,
  type EmailConfig,
  type FolderConfig,
  type Screenshots,
  type SheetColumn,
  type SheetRowConfig,
  type WebhookConfig,
} from './drafts';
import { confirmRecipient, needsConfirming, recipientState, type RecipientRecord } from './recipients';

export interface EditorContext {
  outputs: readonly TaskOutput[];
  connections: readonly Connection[];
  taskName: string;
  /** The owner's own addresses: usable at once. */
  own: readonly string[];
  /** The addresses the owner confirmed. */
  recipients: readonly RecipientRecord[];
  onRecipientConfirmed: (record: RecipientRecord) => void;
  /** Tests replace the picker's script loader. */
  loadPicker?: () => Promise<void>;
}

export interface DeliveryEditorProps {
  open: boolean;
  draft: DeliveryDraft | null;
  isNew: boolean;
  ctx: EditorContext;
  onSave: (draft: DeliveryDraft) => void;
  onClose: () => void;
}

const TAP = { minHeight: { xs: 44, sm: 'auto' } } as const;
const TITLE: Record<DeliveryDraft['kind'], string> = { email: 'Email the result', sheet_row: 'Add a row to a spreadsheet', folder: 'Save files to a folder', webhook: 'Send to a web address' };

interface BodyProps<C> {
  config: C;
  set: (next: C) => void;
  problems: DraftProblems;
  ctx: EditorContext;
  disabled?: boolean;
}

/** A menu that puts a placeholder at the end of a text field. */
function PlaceholderMenu({ outputs, onPick, label }: { outputs: readonly TaskOutput[]; onPick: (token: string) => void; label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button size="small" onClick={(e) => setAnchor(e.currentTarget)} aria-haspopup="menu" sx={{ alignSelf: 'flex-start', ...TAP }}>
        {label}
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {placeholderMenu(outputs).map((p) => (
          <MenuItem
            key={p.token}
            sx={{ minHeight: 44 }}
            onClick={() => {
              setAnchor(null);
              onPick(p.token);
            }}
          >
            {p.label}
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              {p.token}
            </Typography>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Email

function AddressesField({ label, value, onChange, options, error, helper, ctx, testId }: { label: string; value: string[]; onChange: (next: string[]) => void; options: readonly string[]; error?: string; helper?: ReactNode; ctx: EditorContext; testId: string }) {
  return (
    <Autocomplete
      multiple
      freeSolo
      autoSelect
      options={options as string[]}
      value={value}
      onChange={(_e, next) => onChange([...new Set((next as string[]).flatMap((v) => splitAddresses(v)))])}
      renderValue={(tags, getItemProps) =>
        tags.map((tag, index) => {
          const { key, ...itemProps } = getItemProps({ index });
          const state = recipientState(tag, ctx.own, ctx.recipients);
          return <Chip key={key} size="small" label={tag} color={state === 'own' || state === 'confirmed' ? 'default' : 'warning'} variant={state === 'own' || state === 'confirmed' ? 'filled' : 'outlined'} {...itemProps} />;
        })
      }
      renderInput={(params) => <TextField {...params} label={label} error={Boolean(error)} helperText={error ?? helper} slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, 'data-testid': testId, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, inputMode: 'email' } }} />}
    />
  );
}

function EmailBody({ config: c, set, problems, ctx, disabled }: BodyProps<EmailConfig>) {
  const mailers = ctx.connections.filter((x) => connectionFits(x, 'email') || (c.via !== 'console' && x.id === c.via.connectionId));
  const unconfirmed = [...c.to, ...(c.cc ?? [])].filter((a) => ['unconfirmed', 'unsubscribed'].includes(recipientState(a, ctx.own, ctx.recipients)));
  const [more, setMore] = useState(Boolean(c.cc?.length) || c.includeSensitive);
  const subjectShown = c.subject ?? '';
  return (
    <Stack spacing={2}>
      <FormControl size="small" disabled={disabled} error={Boolean(problems.connection)}>
        <InputLabel id="email-from-label">Send from</InputLabel>
        <Select
          labelId="email-from-label"
          label="Send from"
          value={c.via === 'console' ? 'console' : c.via.connectionId}
          onChange={(e) => set({ ...c, via: e.target.value === 'console' ? 'console' : { connectionId: e.target.value } })}
        >
          <MenuItem value="console">The console (its own email sender)</MenuItem>
          {mailers.map((m) => (
            <MenuItem key={m.id} value={m.id}>
              {m.label} ({m.accountEmail})
            </MenuItem>
          ))}
        </Select>
        {problems.connection && <FormHelperText>{problems.connection}</FormHelperText>}
      </FormControl>
      <AddressesField
        label="To"
        value={c.to}
        onChange={(to) => set({ ...c, to })}
        options={ctx.own}
        error={problems.to}
        ctx={ctx}
        testId="email-to"
        helper={unconfirmed.length > 0 ? (
          <Box component="span" data-testid="confirm-hint">
            You&apos;ll be asked to confirm {unconfirmed.length === 1 ? 'this address' : 'these addresses'}: {unconfirmed.join(', ')}
          </Box>
        ) : 'Type an address and press Enter. Your own addresses are offered first.'}
      />
      <TextField
        label="Subject"
        value={subjectShown}
        placeholder={DEFAULT_SUBJECT}
        onChange={(e) => set({ ...c, subject: e.target.value })}
        error={Boolean(problems.subject)}
        helperText={problems.subject ?? 'Leave empty for the usual subject. Add details with the menu below.'}
        disabled={disabled}
        fullWidth
      />
      <PlaceholderMenu outputs={ctx.outputs} label="Add a detail to the subject" onPick={(t) => set({ ...c, subject: `${subjectShown || ''}${t}` })} />
      <FormControl component="fieldset" error={Boolean(problems.attach)} disabled={disabled}>
        <FormLabel component="legend">Attach</FormLabel>
        <Stack>
          <FormControlLabel sx={TAP} control={<Checkbox checked={c.attach.pdf} onChange={(e) => set({ ...c, attach: { ...c.attach, pdf: e.target.checked } })} />} label="The PDF report" />
          <FormControlLabel sx={TAP} control={<Checkbox checked={c.attach.json} onChange={(e) => set({ ...c, attach: { ...c.attach, json: e.target.checked } })} />} label="The JSON trace" />
          <FormControl size="small" sx={{ maxWidth: 320, mt: 1 }}>
            <InputLabel id="email-shots-label">Screenshots</InputLabel>
            <Select labelId="email-shots-label" label="Screenshots" value={c.attach.screenshots} onChange={(e) => set({ ...c, attach: { ...c.attach, screenshots: e.target.value as Screenshots } })}>
              <MenuItem value="none">None</MenuItem>
              <MenuItem value="final">The last picture</MenuItem>
              <MenuItem value="all">Every step</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <FormHelperText>{problems.attach ?? 'Attachments are always the masked versions: nothing hidden in the run is sent.'}</FormHelperText>
      </FormControl>
      <FormControlLabel sx={TAP} control={<Switch checked={c.includeOutputs} onChange={(e) => set({ ...c, includeOutputs: e.target.checked })} disabled={disabled} />} label="Include the values the agent captured" />
      <Box>
        <Button size="small" onClick={() => setMore((m) => !m)} aria-expanded={more} sx={TAP}>
          More
        </Button>
        <Collapse in={more}>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <AddressesField label="Also copy (Cc)" value={c.cc ?? []} onChange={(cc) => set({ ...c, cc })} options={ctx.own} error={problems.cc} ctx={ctx} testId="email-cc" helper="Each address gets its own message." />
            <FormControlLabel
              sx={TAP}
              control={<Switch checked={c.includeSensitive} onChange={(e) => set({ ...c, includeSensitive: e.target.checked })} disabled={disabled} />}
              label="Include values marked sensitive"
            />
            {c.includeSensitive && <Alert severity="warning">Values you marked sensitive will be written in the email as they are. They are never in the subject.</Alert>}
          </Stack>
        </Collapse>
      </Box>
    </Stack>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Spreadsheet row

const sourceValue = (s: ColumnSource): string => (s.kind === 'output' ? `output:${s.key}` : `field:${s.field}`);
const sourceOf = (v: string): ColumnSource => (v.startsWith('output:') ? { kind: 'output', key: v.slice(7) } : { kind: 'field', field: v.slice(6) as (typeof RUN_FIELDS)[number] });

function ColumnRow({ index, count, col, outputs, error, set, move, remove, disabled }: { index: number; count: number; col: SheetColumn; outputs: { key: string; label: string }[]; error?: string; set: (c: SheetColumn) => void; move: (by: -1 | 1) => void; remove: () => void; disabled?: boolean }) {
  const known = outputs.some((o) => col.value.kind === 'output' && o.key === col.value.key);
  return (
    <Box component="li" sx={{ listStyle: 'none' }} data-testid={`column-${index}`}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField size="small" label={`Header ${index + 1}`} value={col.header} onChange={(e) => set({ ...col, header: e.target.value })} error={Boolean(error)} helperText={error} disabled={disabled} sx={{ flex: 1 }} />
        <FormControl size="small" sx={{ flex: 1 }} disabled={disabled}>
          <InputLabel id={`col-src-${index}`}>Value {index + 1}</InputLabel>
          <Select labelId={`col-src-${index}`} label={`Value ${index + 1}`} value={sourceValue(col.value)} onChange={(e) => set({ ...col, value: sourceOf(String(e.target.value)) })}>
            {outputs.length > 0 && <ListSubheader>Captured values</ListSubheader>}
            {outputs.map((o) => (
              <MenuItem key={o.key} value={`output:${o.key}`}>
                {o.label}
              </MenuItem>
            ))}
            {col.value.kind === 'output' && !known && <MenuItem value={sourceValue(col.value)}>{col.value.key} (no longer defined)</MenuItem>}
            <ListSubheader>About the run</ListSubheader>
            {RUN_FIELDS.map((f) => (
              <MenuItem key={f} value={`field:${f}`}>
                {RUN_FIELD_LABEL[f]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Stack direction="row">
          <IconButton aria-label={`Move column ${index + 1} up`} disabled={disabled || index === 0} onClick={() => move(-1)} sx={{ minWidth: 44, minHeight: 44 }}>
            <ArrowUpwardIcon fontSize="small" />
          </IconButton>
          <IconButton aria-label={`Move column ${index + 1} down`} disabled={disabled || index === count - 1} onClick={() => move(1)} sx={{ minWidth: 44, minHeight: 44 }}>
            <ArrowDownwardIcon fontSize="small" />
          </IconButton>
          <IconButton aria-label={`Remove column ${index + 1}`} disabled={disabled} onClick={remove} sx={{ minWidth: 44, minHeight: 44 }}>
            <DeleteOutlinedIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>
    </Box>
  );
}

function SheetBody({ config: c, set, problems, ctx, disabled, labels, setLabel }: BodyProps<SheetRowConfig> & { labels?: DeliveryDraft['labels']; setLabel: (l: DeliveryDraft['labels']) => void }) {
  const accounts = ctx.connections.filter((x) => connectionFits(x, 'sheet_row') || x.id === c.connectionId);
  const account = ctx.connections.find((x) => x.id === c.connectionId) ?? null;
  const [choosing, setChoosing] = useState(false);
  const [more, setMore] = useState(Boolean(c.sheet) || c.includeSensitive);
  const named = ctx.outputs.filter((o) => o.label.trim() !== '');
  const keys = effectiveKeys(named);
  const outputs = named.map((o, i) => ({ key: keys[i]!, label: o.label.trim() }));
  const setColumns = (columns: SheetColumn[]) => set({ ...c, columns });
  const preview = sampleRow(c.columns, ctx.outputs, ctx.taskName);
  const choose = (f: ConnectionFile) => {
    set({ ...c, fileId: f.id, createIfMissing: false });
    setLabel({ ...labels, file: f.name });
  };
  return (
    <Stack spacing={2}>
      <FormControl size="small" disabled={disabled} error={Boolean(problems.connection)}>
        <InputLabel id="sheet-account-label">Account</InputLabel>
        <Select
          labelId="sheet-account-label"
          label="Account"
          value={c.connectionId}
          onChange={(e) => {
            set({ ...c, connectionId: String(e.target.value), fileId: undefined });
            setLabel({ ...labels, file: undefined });
          }}
        >
          {accounts.map((a) => (
            <MenuItem key={a.id} value={a.id}>
              {a.label} ({a.accountEmail})
            </MenuItem>
          ))}
        </Select>
        {problems.connection && <FormHelperText>{problems.connection}</FormHelperText>}
        {accounts.length === 0 && <FormHelperText>No connected account is allowed to change documents. Switch it on under Connections.</FormHelperText>}
      </FormControl>
      <FormControl component="fieldset" error={Boolean(problems.file)} disabled={disabled || !c.connectionId}>
        <FormLabel component="legend">Spreadsheet</FormLabel>
        <RadioGroup
          value={c.createIfMissing && !c.fileId ? 'new' : 'existing'}
          onChange={(e) => (e.target.value === 'new' ? set({ ...c, createIfMissing: true, fileId: undefined }) : set({ ...c, createIfMissing: false }))}
        >
          <FormControlLabel value="existing" control={<Radio />} label="One that already exists" sx={TAP} />
          <FormControlLabel value="new" control={<Radio />} label="Create a new spreadsheet" sx={TAP} />
        </RadioGroup>
        {c.createIfMissing && !c.fileId ? (
          <TextField size="small" label="Title of the new spreadsheet" value={c.newTitle ?? ''} onChange={(e) => set({ ...c, newTitle: e.target.value })} helperText="Created the first time a run sends. Leave empty to use the task's name." disabled={disabled} sx={{ mt: 1 }} />
        ) : (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2" data-testid="chosen-file" sx={{ overflowWrap: 'anywhere' }}>
              {c.fileId ? (labels?.file ?? 'A spreadsheet is chosen') : 'None chosen yet'}
            </Typography>
            <Button variant="outlined" size="small" onClick={() => setChoosing(true)} disabled={disabled || !c.connectionId} sx={TAP}>
              {c.fileId ? 'Change' : 'Choose a spreadsheet'}
            </Button>
          </Stack>
        )}
        {problems.file && <FormHelperText>{problems.file}</FormHelperText>}
      </FormControl>
      <Box>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle2" component="h3">
            Columns
          </Typography>
          <Button size="small" onClick={() => setColumns(fillFromOutputs(ctx.outputs, c.columns))} disabled={disabled || named.length === 0} sx={TAP}>
            Fill from outputs
          </Button>
        </Stack>
        {problems.columns && <Alert severity="error">{problems.columns}</Alert>}
        <Stack component="ol" spacing={1.5} sx={{ m: 0, p: 0 }} aria-label="Columns">
          {c.columns.map((col, i) => (
            <ColumnRow
              key={i}
              index={i}
              count={c.columns.length}
              col={col}
              outputs={outputs}
              error={problems[`column:${i}`]}
              disabled={disabled}
              set={(next) => setColumns(c.columns.map((x, j) => (j === i ? next : x)))}
              move={(by) => {
                const next = [...c.columns];
                const [m] = next.splice(i, 1);
                next.splice(i + by, 0, m!);
                setColumns(next);
              }}
              remove={() => setColumns(c.columns.filter((_x, j) => j !== i))}
            />
          ))}
        </Stack>
        <Button size="small" startIcon={<AddIcon />} onClick={() => setColumns([...c.columns, { header: '', value: { kind: 'field', field: 'status' } }])} disabled={disabled || c.columns.length >= 50} sx={{ mt: 1, ...TAP }}>
          Add a column
        </Button>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
          A &ldquo;Run ID&rdquo; column is added last. It is how a retry avoids adding the same row twice.
        </Typography>
      </Box>
      {c.columns.length > 0 && (
        <Box sx={{ overflowX: 'auto' }} aria-label="Preview of a row" data-testid="row-preview">
          <Typography variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
            What a row will look like
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                {c.columns.map((col, i) => (
                  <TableCell key={i}>{col.header || '(no header)'}</TableCell>
                ))}
                <TableCell>Run ID</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <TableRow>
                {preview.map((v, i) => (
                  <TableCell key={i} sx={{ maxWidth: 160, overflowWrap: 'anywhere' }}>
                    {v}
                  </TableCell>
                ))}
                <TableCell>…</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Box>
      )}
      <Box>
        <Button size="small" onClick={() => setMore((m) => !m)} aria-expanded={more} sx={TAP}>
          More
        </Button>
        <Collapse in={more}>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField size="small" label="Sheet (tab) name" value={c.sheet ?? ''} onChange={(e) => set({ ...c, sheet: e.target.value })} helperText="Leave empty for the first sheet." disabled={disabled} />
            <FormControlLabel sx={TAP} control={<Switch checked={c.includeSensitive} onChange={(e) => set({ ...c, includeSensitive: e.target.checked })} disabled={disabled} />} label="Write values marked sensitive as they are" />
          </Stack>
        </Collapse>
      </Box>
      <FileChooserDialog open={choosing} connection={account} kind="spreadsheet" onChoose={choose} onClose={() => setChoosing(false)} loadPicker={ctx.loadPicker} />
    </Stack>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Folder

function FolderBody({ config: c, set, problems, ctx, disabled, labels, setLabel }: BodyProps<FolderConfig> & { labels?: DeliveryDraft['labels']; setLabel: (l: DeliveryDraft['labels']) => void }) {
  const inAccount = c.target !== 'storage';
  const accounts = ctx.connections.filter((x) => connectionFits(x, 'folder') || (inAccount && x.id === (c.target as { connectionId: string }).connectionId));
  const connectionId = inAccount ? (c.target as { connectionId: string }).connectionId : '';
  const account = ctx.connections.find((x) => x.id === connectionId) ?? null;
  const [choosing, setChoosing] = useState(false);
  const sample = useMemo(() => {
    const outputs: Record<string, string> = {};
    const named = ctx.outputs.filter((o) => o.label.trim() !== '');
    effectiveKeys(named).forEach((k, i) => (outputs[k] = sampleValue(named[i]!)));
    return { task: ctx.taskName || 'Your task', date: '2026-11-18', status: 'succeeded', outputs };
  }, [ctx.outputs, ctx.taskName]);
  const example = exampleName(c.nameTemplate, sample);
  const files = c.files;
  return (
    <Stack spacing={2}>
      <FormControl component="fieldset" disabled={disabled}>
        <FormLabel component="legend">Where</FormLabel>
        <RadioGroup
          value={inAccount ? 'account' : 'storage'}
          onChange={(e) => {
            if (e.target.value === 'storage') set({ ...c, target: 'storage' });
            else set({ ...c, target: { connectionId: accounts[0]?.id ?? '', folderId: '' } });
          }}
        >
          <FormControlLabel value="storage" control={<Radio />} label="Hexactra storage" sx={TAP} />
          <FormControlLabel value="account" control={<Radio />} label="A folder in one of my accounts" sx={TAP} disabled={accounts.length === 0} />
        </RadioGroup>
        {accounts.length === 0 && <FormHelperText>No connected account is allowed to change documents.</FormHelperText>}
      </FormControl>
      {inAccount && (
        <>
          <FormControl size="small" disabled={disabled} error={Boolean(problems.connection)}>
            <InputLabel id="folder-account-label">Account</InputLabel>
            <Select labelId="folder-account-label" label="Account" value={connectionId} onChange={(e) => { set({ ...c, target: { connectionId: String(e.target.value), folderId: '' } }); setLabel({ ...labels, folder: undefined }); }}>
              {accounts.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {a.label} ({a.accountEmail})
                </MenuItem>
              ))}
            </Select>
            {problems.connection && <FormHelperText>{problems.connection}</FormHelperText>}
          </FormControl>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2" data-testid="chosen-folder" color={problems.folder ? 'error' : undefined} sx={{ overflowWrap: 'anywhere' }}>
              {(c.target as { folderId: string }).folderId ? (labels?.folder ? `Folder “${labels.folder}”` : 'A folder is chosen') : (problems.folder ?? 'No folder chosen yet')}
            </Typography>
            <Button variant="outlined" size="small" onClick={() => setChoosing(true)} disabled={disabled || !connectionId} sx={TAP}>
              {(c.target as { folderId: string }).folderId ? 'Change' : 'Choose a folder'}
            </Button>
          </Stack>
        </>
      )}
      <FormControl component="fieldset" error={Boolean(problems.files)} disabled={disabled}>
        <FormLabel component="legend">Which files</FormLabel>
        <FormControlLabel sx={TAP} control={<Checkbox checked={files.pdf} onChange={(e) => set({ ...c, files: { ...files, pdf: e.target.checked } })} />} label="The PDF report" />
        <FormControlLabel sx={TAP} control={<Checkbox checked={files.json} onChange={(e) => set({ ...c, files: { ...files, json: e.target.checked } })} />} label="The JSON trace" />
        <FormControl size="small" sx={{ maxWidth: 320, mt: 1 }}>
          <InputLabel id="folder-shots-label">Screenshots</InputLabel>
          <Select labelId="folder-shots-label" label="Screenshots" value={files.screenshots} onChange={(e) => set({ ...c, files: { ...files, screenshots: e.target.value as Screenshots } })}>
            <MenuItem value="none">None</MenuItem>
            <MenuItem value="final">The last picture</MenuItem>
            <MenuItem value="all">Every step</MenuItem>
          </Select>
        </FormControl>
        <FormHelperText>{problems.files ?? 'Files are always the masked versions.'}</FormHelperText>
      </FormControl>
      <TextField
        label="File name"
        value={c.nameTemplate}
        onChange={(e) => set({ ...c, nameTemplate: e.target.value })}
        placeholder={DEFAULT_NAME_TEMPLATE}
        error={Boolean(problems.nameTemplate)}
        helperText={problems.nameTemplate ?? (
          <Box component="span" data-testid="name-example">
            Example: {example || '(empty)'}
            {files.pdf ? '.pdf' : files.json ? '.json' : ''}
          </Box>
        )}
        disabled={disabled}
      />
      <PlaceholderMenu outputs={ctx.outputs} label="Add a detail to the name" onPick={(t) => set({ ...c, nameTemplate: `${c.nameTemplate}${t}` })} />
      <FileChooserDialog
        open={choosing}
        connection={account}
        kind="folder"
        onChoose={(f) => {
          set({ ...c, target: { connectionId, folderId: f.id } });
          setLabel({ ...labels, folder: f.name });
        }}
        onClose={() => setChoosing(false)}
        loadPicker={ctx.loadPicker}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Webhook

function WebhookBody({ config: c, set, problems, disabled }: BodyProps<WebhookConfig>) {
  const [more, setMore] = useState(c.includeSensitive);
  return (
    <Stack spacing={2}>
      <TextField label="Web address" value={c.url} onChange={(e) => set({ ...c, url: e.target.value })} placeholder="https://hooks.example.test/run" error={Boolean(problems.url)} helperText={problems.url ?? 'An https address on the public internet. Each message is signed so the receiver can check it came from Hexactra.'} disabled={disabled} fullWidth />
      <FormControlLabel sx={TAP} control={<Switch checked={c.includeOutputs} onChange={(e) => set({ ...c, includeOutputs: e.target.checked })} disabled={disabled} />} label="Include the values the agent captured" />
      <FormControlLabel sx={TAP} control={<Switch checked={c.includeReportLink} onChange={(e) => set({ ...c, includeReportLink: e.target.checked })} disabled={disabled} />} label="Include a link to the PDF report (valid for 7 days)" />
      <Typography variant="body2" color="text.secondary">
        Web addresses you already registered under Settings → Webhooks receive every finished run without being added here.
      </Typography>
      <Box>
        <Button size="small" onClick={() => setMore((m) => !m)} aria-expanded={more} sx={TAP}>
          More
        </Button>
        <Collapse in={more}>
          <FormControlLabel sx={{ mt: 1, ...TAP }} control={<Switch checked={c.includeSensitive} onChange={(e) => set({ ...c, includeSensitive: e.target.checked })} disabled={disabled} />} label="Include values marked sensitive" />
          {c.includeSensitive && <Alert severity="warning">Values you marked sensitive will be sent as they are.</Alert>}
        </Collapse>
      </Box>
    </Stack>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// The dialog

export function DeliveryEditor({ open, draft, isNew, ctx, onSave, onClose }: DeliveryEditorProps) {
  const { api } = usePlatformHost();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [work, setWork] = useState<DeliveryDraft | null>(draft);
  const [attempted, setAttempted] = useState(false);
  const [confirming, setConfirming] = useState<{ address: string; state: 'unconfirmed' | 'unsubscribed' }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Start from the delivery each time the dialog opens for another one.
  const [lastKey, setLastKey] = useState<string | null>(draft?.key ?? null);
  if (open && draft && draft.key !== lastKey) {
    setLastKey(draft.key);
    setWork(draft);
    setAttempted(false);
    setConfirming(null);
    setError(null);
  }
  const problems = useMemo(() => (work ? draftProblems(work, ctx) : {}), [work, ctx]);
  if (!work) return null;
  const set = (config: DeliveryDraft['config']) => setWork((w) => (w ? { ...w, config, disabledReason: undefined } : w));
  const setLabel = (labels: DeliveryDraft['labels']) => setWork((w) => (w ? { ...w, labels } : w));
  const shown = attempted ? problems : {};

  const finish = (d: DeliveryDraft) => {
    onSave({ ...d, disabledReason: undefined });
    onClose();
  };

  const done = () => {
    setAttempted(true);
    if (Object.keys(problems).length > 0) return;
    if (work.kind === 'email' && work.enabled) {
      const c = work.config as EmailConfig;
      const todo = needsConfirming([...c.to, ...(c.cc ?? [])], ctx.own, ctx.recipients);
      if (todo.length > 0) return setConfirming(todo);
    }
    finish(work);
  };

  const confirmAll = async () => {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      for (const { address } of confirming) ctx.onRecipientConfirmed(await confirmRecipient(api, address));
      setConfirming(null);
      finish(work);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not confirm the address');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open && confirming === null} onClose={onClose} fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="delivery-editor-title">
        <DialogTitle id="delivery-editor-title">{isNew ? TITLE[work.kind] : `Edit: ${KIND_ADD_LABEL[work.kind]}`}</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {attempted && Object.keys(problems).length > 0 && (
              <Alert severity="error" role="alert">
                Fix the highlighted fields first.
              </Alert>
            )}
            {work.kind === 'email' && <EmailBody config={work.config as EmailConfig} set={set} problems={shown} ctx={ctx} />}
            {work.kind === 'sheet_row' && <SheetBody config={work.config as SheetRowConfig} set={set} problems={shown} ctx={ctx} labels={work.labels} setLabel={setLabel} />}
            {work.kind === 'folder' && <FolderBody config={work.config as FolderConfig} set={set} problems={shown} ctx={ctx} labels={work.labels} setLabel={setLabel} />}
            {work.kind === 'webhook' && <WebhookBody config={work.config as WebhookConfig} set={set} problems={shown} ctx={ctx} />}
            <FormControl size="small" sx={{ maxWidth: 320 }}>
              <InputLabel id="delivery-when-label">Send</InputLabel>
              <Select labelId="delivery-when-label" label="Send" value={work.when} onChange={(e) => setWork({ ...work, when: e.target.value as DeliveryWhen })}>
                {WHEN_ORDER.map((w) => (
                  <MenuItem key={w} value={w}>
                    {WHEN_LABEL[w]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} sx={TAP}>
            Cancel
          </Button>
          <Button variant="contained" onClick={done} sx={TAP}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={open && confirming !== null} onClose={busy ? undefined : () => setConfirming(null)} fullWidth maxWidth="xs" aria-labelledby="confirm-address-title">
        <DialogTitle id="confirm-address-title">{confirming && confirming.length === 1 ? 'Send reports to this address?' : 'Send reports to these addresses?'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {error && <Alert severity="error">{error}</Alert>}
            <Typography>
              {confirming?.length === 1 ? 'This address is not yours:' : 'These addresses are not yours:'}
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              {confirming?.map((a) => (
                <li key={a.address} style={{ overflowWrap: 'anywhere' }}>
                  <strong>{a.address}</strong>
                  {a.state === 'unsubscribed' ? ' (they stopped the emails)' : ''}
                </li>
              ))}
            </Box>
            <Typography variant="body2" color="text.secondary">
              Hexactra will email run reports there, with your task&apos;s results. The first message tells them it comes from you and how to stop it. Only you can confirm an address, and only here.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          <Button onClick={() => setConfirming(null)} disabled={busy} sx={TAP}>
            Back
          </Button>
          <Button
            onClick={() => {
              setConfirming(null);
              finish({ ...work, enabled: false });
            }}
            disabled={busy}
            sx={TAP}
          >
            Save switched off
          </Button>
          <Button variant="contained" onClick={() => void confirmAll()} disabled={busy} sx={TAP}>
            Confirm and keep it on
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
