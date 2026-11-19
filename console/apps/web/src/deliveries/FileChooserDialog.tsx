// Choosing a spreadsheet or a folder in one of the owner's accounts (E39.10, #607): search by name, browse into folders, create a folder,
// paste a link, and, for a Google account, Google's own picker so that a file becomes usable under the narrow `drive.file` permission.
// The picker's script is loaded only when its button is pressed in this dialog.
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemIcon, ListItemText, Stack, TextField, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Connection } from '../connections/api';
import { createFolder, fileIdFromLink, listFiles, openPicker, registerPickedFile, type ConnectionFile } from '../connections/files';
import { loadGooglePicker, pickWithGoogle, PickerUnavailable, type PickerKind } from '../connections/googlePicker';

export interface FileChooserDialogProps {
  open: boolean;
  connection: Connection | null;
  kind: PickerKind;
  onChoose: (file: ConnectionFile) => void;
  onClose: () => void;
  /** Tests replace the script loader; the default adds Google's script. */
  loadPicker?: () => Promise<void>;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const TAP = { minHeight: { xs: 44, sm: 'auto' } } as const;

export function FileChooserDialog({ open, connection, kind, onChoose, onClose, loadPicker = loadGooglePicker }: FileChooserDialogProps) {
  const { api } = usePlatformHost();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [query, setQuery] = useState('');
  const [trail, setTrail] = useState<ConnectionFile[]>([]);
  const [items, setItems] = useState<ConnectionFile[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = trail[trail.length - 1] ?? null;
  const stale = useRef(0);
  const id = connection?.id;
  const googleDocs = connection?.provider === 'google' && connection.capabilities.some((c) => c === 'docs_read' || c === 'docs_write');

  const load = useCallback(
    async (opts: { pageToken?: string; append?: boolean } = {}) => {
      if (!id) return;
      const ticket = (stale.current += 1);
      setLoading(true);
      setError(null);
      try {
        // A folder is chosen among folders (and entered); a spreadsheet among spreadsheets and the folders that hold them.
        const page = await listFiles(api, id, { q: query.trim() || undefined, type: kind === 'folder' ? 'folder' : query.trim() ? 'spreadsheet' : 'any', folderId: query.trim() ? undefined : here?.id, pageToken: opts.pageToken });
        if (ticket !== stale.current) return;
        const shown = kind === 'folder' ? page.items.filter((f) => f.kind === 'folder') : page.items.filter((f) => f.kind === 'spreadsheet' || f.kind === 'folder');
        setItems((old) => (opts.append ? [...old, ...shown] : shown));
        setNext(page.nextPageToken);
      } catch (e) {
        if (ticket === stale.current) setError(errorText(e, 'Could not list the files'));
      } finally {
        if (ticket === stale.current) setLoading(false);
      }
    },
    [api, id, kind, query, here?.id],
  );

  useEffect(() => {
    if (!open) return;
    setTrail([]);
    setQuery('');
    setLink('');
    setNewFolder(null);
    setError(null);
  }, [open, id, kind]);

  // Search as the owner types (after a short pause), and when the folder changes.
  useEffect(() => {
    if (!open || !id) return;
    const t = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, id, query, here?.id, load]);

  const choose = (f: ConnectionFile) => {
    onChoose(f);
    onClose();
  };

  const pasted = async () => {
    const fileId = fileIdFromLink(link);
    if (!id || !fileId) return setError('That is not a link to a Google spreadsheet or file. Open the file in Google and copy the address from the browser.');
    setBusy(true);
    setError(null);
    try {
      choose(await registerPickedFile(api, id, fileId));
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(code === 'CONNECTION_PERMISSION_MISSING' ? 'This account cannot open that file. Pick it in Google Drive first.' : errorText(e, 'Could not open that file'));
    } finally {
      setBusy(false);
    }
  };

  const picker = async () => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const session = await openPicker(api, id);
      const picked = await pickWithGoogle(session, kind, loadPicker);
      if (picked) choose(await registerPickedFile(api, id, picked.id));
    } catch (e) {
      setError(
        e instanceof PickerUnavailable
          ? `${e.message} ${kind === 'spreadsheet' ? 'Paste the spreadsheet\'s link below instead, or search this account.' : 'Search this account, or create a folder here.'}`
          : errorText(e, 'Could not open Google\'s picker'),
      );
    } finally {
      setBusy(false);
    }
  };

  const makeFolder = async () => {
    if (!id || !newFolder?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const f = await createFolder(api, id, { name: newFolder.trim(), ...(here ? { parentId: here.id } : {}) });
      setNewFolder(null);
      setItems((old) => [f, ...old]);
    } catch (e) {
      setError(errorText(e, 'Could not create the folder'));
    } finally {
      setBusy(false);
    }
  };

  const canCreate = connection?.capabilities.includes('docs_write') === true;
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="file-chooser-title">
      <DialogTitle id="file-chooser-title">{kind === 'folder' ? 'Choose a folder' : 'Choose a spreadsheet'}{connection ? ` in ${connection.label}` : ''}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && (
            <Alert severity="error" role="alert">
              {error}
            </Alert>
          )}
          <TextField size="small" label={kind === 'folder' ? 'Search folders by name' : 'Search spreadsheets by name'} value={query} onChange={(e) => setQuery(e.target.value)} fullWidth />
          {trail.length > 0 && !query && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => setTrail((t) => t.slice(0, -1))} sx={TAP}>
                Back
              </Button>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {trail.map((t) => t.name).join(' / ')}
              </Typography>
            </Stack>
          )}
          <List dense disablePadding aria-label={kind === 'folder' ? 'Folders' : 'Spreadsheets and folders'} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 320, overflow: 'auto' }}>
            {items.map((f) => (
              <ListItemButton
                key={f.id}
                sx={{ minHeight: 44 }}
                onClick={() => {
                  if (f.kind === 'folder' && !query) setTrail((t) => [...t, f]);
                  else if (f.kind === 'folder') choose(f);
                  else choose(f);
                }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>{f.kind === 'folder' ? <FolderOutlinedIcon fontSize="small" /> : <TableChartOutlinedIcon fontSize="small" />}</ListItemIcon>
                <ListItemText primary={f.name} slotProps={{ primary: { sx: { overflowWrap: 'anywhere' } } }} />
              </ListItemButton>
            ))}
            {!loading && items.length === 0 && !error && (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" color="text.secondary">
                  {googleDocs ? 'Nothing here yet. With Google, the console sees only files it created and files you pick.' : 'Nothing found.'}
                </Typography>
              </Box>
            )}
            {loading && (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <CircularProgress size={20} aria-label="Loading" />
              </Box>
            )}
          </List>
          {next && (
            <Button size="small" onClick={() => void load({ pageToken: next, append: true })} sx={{ alignSelf: 'flex-start', ...TAP }}>
              Show more
            </Button>
          )}
          {kind === 'folder' && canCreate && (
            newFolder === null ? (
              <Button size="small" startIcon={<CreateNewFolderOutlinedIcon />} onClick={() => setNewFolder('')} sx={{ alignSelf: 'flex-start', ...TAP }}>
                New folder{here ? ` in ${here.name}` : ''}
              </Button>
            ) : (
              <Stack direction="row" spacing={1}>
                <TextField size="small" autoFocus label="Folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void makeFolder()} fullWidth />
                <Button variant="contained" disabled={busy || !newFolder.trim()} onClick={() => void makeFolder()} sx={TAP}>
                  Create
                </Button>
              </Stack>
            )
          )}
          {googleDocs && (
            <Box>
              <Button variant="outlined" disabled={busy} onClick={() => void picker()} sx={TAP}>
                Choose from Google Drive
              </Button>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                Opens Google&apos;s own file picker. Only the {kind === 'folder' ? 'folder' : 'file'} you choose becomes available to Hexactra.
              </Typography>
            </Box>
          )}
          {kind === 'spreadsheet' && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
              <TextField size="small" label="Or paste a link to the spreadsheet" value={link} onChange={(e) => setLink(e.target.value)} fullWidth />
              <Button variant="outlined" disabled={busy || !link.trim()} onClick={() => void pasted()} sx={TAP}>
                Use
              </Button>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} sx={TAP}>
          Cancel
        </Button>
        {kind === 'folder' && here && !query && (
          <Button variant="contained" onClick={() => choose(here)} sx={TAP}>
            Choose “{here.name}”
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
