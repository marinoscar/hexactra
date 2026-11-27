import AddIcon from '@mui/icons-material/Add';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormHelperText,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  SKILL_LIMITS,
  createSkill,
  deleteSkill,
  getSkillsOn,
  listSkills,
  parseSkillFile,
  setSkillArchived,
  setSkillsOn,
  updateSkill,
  type Skill,
  type SkillInput,
} from '../skills/api';
import { CardSkeleton, EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, ResponsiveList, toast, useApiAction, useBreakpoint, useConfirm, type Column } from '../ui';

/** The explanation line (exact text, #1008). */
export const SKILLS_EXPLANATION = 'A skill tells the agent how you want a kind of job done. It cannot allow a site, a payment or a recipient: those stay with your settings and approvals.';
export const FILE_NOTE = 'Reads one text file in your browser: the name and description from its front matter, the rest as the text. Folders, scripts/, references/ and links are ignored. Nothing is saved until you press Save.';

/** The longest file "Fill from a SKILL.md file" reads (a skill's text is at most 4,000 characters). */
const MAX_FILE_BYTES = 64 * 1024;

const parseSites = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

interface FormProps {
  open: boolean;
  skill: Skill | null;
  /** Without `skills:write` the form is read-only. */
  canWrite?: boolean;
  onClose: () => void;
  onSave: (input: SkillInput) => Promise<void>;
  /** Archive (or unarchive) and delete, offered when editing. */
  onArchive?: (skill: Skill) => Promise<void>;
  onDelete?: (skill: Skill) => Promise<void>;
}

/** Add or edit a skill: the name, when to use it, the text with a character count, the sites, and Fill from a SKILL.md file. */
export function SkillDialog({ open, skill, canWrite = true, onClose, onSave, onArchive, onDelete }: FormProps) {
  const { isPhone } = useBreakpoint();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [sites, setSites] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [filled, setFilled] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(skill?.name ?? '');
    setDescription(skill?.description ?? '');
    setBody(skill?.body ?? '');
    setSites((skill?.sites ?? []).join(', '));
    setError(null);
    setFilled(null);
  }, [open, skill]);

  const fill = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    if (picked.size > MAX_FILE_BYTES) {
      setError('That file is too large for a skill. A skill holds at most 4,000 characters.');
      return;
    }
    const parsed = parseSkillFile(await picked.text());
    if (parsed.name) setName(parsed.name.slice(0, SKILL_LIMITS.name));
    if (parsed.description) setDescription(parsed.description.slice(0, SKILL_LIMITS.description));
    setBody(parsed.body);
    setError(null);
    setFilled(`Filled from ${picked.name}. Check it, then press Save.`);
  };

  const siteList = parseSites(sites);
  const tooLong = body.length > SKILL_LIMITS.body;
  const invalid = !name.trim() || !description.trim() || !body.trim() || tooLong || siteList.length > SKILL_LIMITS.sites;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), description: description.trim(), body, sites: siteList });
    } catch (e) {
      setError(isPlatformApiError(e) || e instanceof Error ? e.message : 'Could not save the skill');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" fullScreen={isPhone} aria-labelledby="skill-dialog-title">
      <DialogTitle id="skill-dialog-title">{skill ? 'Edit skill' : 'Add a skill'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {!skill && (
            <Box>
              <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => void fill(e)} data-testid="skill-file" />
              <Button variant="outlined" startIcon={<UploadFileOutlinedIcon />} onClick={() => file.current?.click()} sx={{ minHeight: 44 }}>
                Fill from a SKILL.md file
              </Button>
              <FormHelperText>{FILE_NOTE}</FormHelperText>
            </Box>
          )}
          {filled && <Alert severity="info">{filled}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required slotProps={{ htmlInput: { maxLength: SKILL_LIMITS.name } }} helperText='What you call it, such as "Google Messages".' />
          <TextField
            label="When to use it"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            slotProps={{ htmlInput: { maxLength: SKILL_LIMITS.description } }}
            helperText="The agent is shown this line, not the text, and reads the text when the job fits."
          />
          <TextField
            label="The text"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            multiline
            minRows={6}
            error={tooLong}
            helperText={`${body.length.toLocaleString()} / ${SKILL_LIMITS.body.toLocaleString()} characters. Plain text or Markdown. Never a password, a code or a full card or account number.`}
          />
          <TextField
            label="Sites (optional)"
            value={sites}
            onChange={(e) => setSites(e.target.value)}
            error={siteList.length > SKILL_LIMITS.sites}
            helperText="Up to 10 sites this skill is about, such as google.com, separated by commas. A skill with sites is offered only to jobs on them."
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {skill && canWrite && onDelete && (
          <Button color="error" onClick={() => void onDelete(skill)}>
            Delete
          </Button>
        )}
        {skill && canWrite && onArchive && <Button onClick={() => void onArchive(skill)}>{skill.archivedAt ? 'Unarchive' : 'Archive'}</Button>}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>{canWrite ? 'Cancel' : 'Close'}</Button>
        {canWrite && (
          <Button variant="contained" onClick={() => void save()} disabled={invalid || saving}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** "Use my skills" (the owner's `skills.enabled`, on by default), saved as soon as it is switched. */
function SkillsSwitch({ disabled }: { disabled?: boolean }) {
  const { api } = usePlatformHost();
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getSkillsOn(api)
      .then((v) => live && setOn(v))
      .catch(() => live && setOn(true));
    return () => {
      live = false;
    };
  }, [api]);
  const toggle = async (next: boolean) => {
    const before = on;
    setOn(next);
    setError(null);
    try {
      setOn(await setSkillsOn(api, next));
    } catch {
      setOn(before);
      setError('Could not save this setting. Try again.');
    }
  };
  return (
    <>
      <FormControlLabel control={<Switch checked={on ?? true} disabled={disabled || on === null} onChange={(e) => void toggle(e.target.checked)} slotProps={{ input: { 'aria-describedby': 'skills-on-help' } }} />} label="Use my skills" />
      <FormHelperText id="skills-on-help" error={error !== null} sx={{ mt: -0.5 }}>
        {error ?? 'Off: your skills are kept, and no run or chat is offered one.'}
      </FormHelperText>
    </>
  );
}

/**
 * `/settings/skills` (#1008): the owner's playbooks for the agent. A list (name, when to use it, sites, last used, an on switch), the add
 * and edit form, archive and delete with a confirmation. Every value is rendered as plain text. Writes need `skills:write`.
 */
export function SkillsPage() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction();
  const canWrite = viewer.hasPermission('skills:write');
  const [params] = useSearchParams();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Skill | null | 'new'>(null);

  const load = useCallback(async () => {
    try {
      setSkills(await listSkills(api, showArchived));
    } catch (e) {
      action.setError(e instanceof Error ? e.message : 'Could not load your skills');
      setSkills([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, showArchived]);
  useEffect(() => {
    void load();
  }, [load]);

  // `?skill=<id>` (the run page's "Skills read" link) opens that skill.
  const wanted = params.get('skill');
  useEffect(() => {
    if (!wanted || !skills) return;
    const found = skills.find((s) => s.id === wanted);
    if (found) setEditing(found);
  }, [wanted, skills]);

  const save = async (input: SkillInput) => {
    if (editing === 'new') await createSkill(api, input);
    else if (editing) await updateSkill(api, editing.id, input);
    setEditing(null);
    toast('Skill saved');
    await load();
  };
  const toggleEnabled = async (s: Skill, enabled: boolean) => {
    await action.run('enable', () => updateSkill(api, s.id, { enabled }), 'Could not change the skill');
    await load();
  };
  const archive = async (s: Skill) => {
    if (!s.archivedAt) {
      const ok = await confirm({ title: 'Archive this skill?', body: 'It is kept, and no run or chat is offered it until you unarchive it.', confirmLabel: 'Archive' });
      if (!ok) return;
    }
    await action.run('archive', () => setSkillArchived(api, s.id, !s.archivedAt), 'Could not change the skill');
    await load();
  };
  const remove = async (s: Skill) => {
    const ok = await confirm({ title: 'Delete this skill?', body: 'It is deleted permanently. Runs that read it keep only its id.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    await action.run('delete', () => deleteSkill(api, s.id), 'Could not delete the skill');
    setEditing(null);
    await load();
  };

  const enabledSwitch = (s: Skill) => (
    <Switch
      checked={s.enabled}
      disabled={!canWrite || Boolean(s.archivedAt)}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => void toggleEnabled(s, e.target.checked)}
      slotProps={{ input: { 'aria-label': `${s.name} on` } }}
    />
  );
  const sitesOf = (s: Skill) => (s.sites.length ? s.sites.join(', ') : 'Any site');
  const lastUsed = (s: Skill) => (s.lastUsedAt ? <RelativeTime iso={s.lastUsedAt} /> : 'Not used yet');
  const nameOf = (s: Skill) => (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <Typography component="span" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
        {s.name}
      </Typography>
      {s.archivedAt && <Chip size="small" label="Archived" />}
    </Stack>
  );
  const columns: Column<Skill>[] = [
    { key: 'name', header: 'Name', width: 200, render: nameOf },
    { key: 'description', header: 'When to use it', grow: true, render: (s) => <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{s.description}</Typography> },
    { key: 'sites', header: 'Sites', render: sitesOf },
    { key: 'used', header: 'Last used', hideBelow: 'lg', render: lastUsed },
    { key: 'on', header: 'On', render: enabledSwitch },
  ];
  const card = (s: Skill) => (
    <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', gap: 1, alignItems: 'flex-start', minWidth: 0 }} data-testid={`skill-${s.id}`}>
      <Box sx={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setEditing(s)}>
        {nameOf(s)}
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {s.description}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {sitesOf(s)} · {lastUsed(s)}
        </Typography>
      </Box>
      {enabledSwitch(s)}
    </Paper>
  );

  const isEmpty = skills !== null && skills.length === 0 && !showArchived;
  const current = editing && editing !== 'new' ? editing : null;
  return (
    <PageContainer width="wide">
      <PageHeader
        title="Skills"
        subtitle="How you want the agent to do a kind of job, in your own words."
        back={{ to: '/settings', label: 'Settings' }}
        primary={{ key: 'add', label: 'Add', Icon: AddIcon, onClick: () => setEditing('new'), hidden: !canWrite }}
      />
      <Typography variant="body2" sx={{ mb: 2 }} data-testid="skills-explanation">
        {SKILLS_EXPLANATION}
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2, alignItems: { sm: 'flex-start' } }}>
        <Box sx={{ flex: 1 }}>
          <SkillsSwitch disabled={!canWrite} />
        </Box>
        <FormControlLabel control={<Switch checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />} label="Show archived" />
      </Stack>
      <ErrorBanner error={action.error} />
      {skills === null && <ListSkeleton />}
      {isEmpty && (
        <EmptyState
          Icon={MenuBookOutlinedIcon}
          title="No skills yet"
          body={
            <>
              For example: <q>Google Messages</q>, when to use it <q>How I send text messages from Google Messages on the web</q>, and the text: start chat is top left, short messages, first name only.
            </>
          }
          action={{ key: 'add', label: 'Add a skill', Icon: AddIcon, onClick: () => setEditing('new'), hidden: !canWrite }}
        />
      )}
      {skills !== null && !isEmpty && (
        <ResponsiveList aria-label="Skills" items={skills} columns={columns} renderCard={card} getKey={(s) => s.id} getLabel={(s) => s.name} onRowClick={(s) => setEditing(s)} />
      )}
      <SkillDialog
        open={editing !== null}
        skill={current}
        canWrite={canWrite}
        onClose={() => setEditing(null)}
        onSave={save}
        onArchive={async (k) => {
          setEditing(null);
          await archive(k);
        }}
        onDelete={remove}
      />
    </PageContainer>
  );
}

// ---- Administration ----

interface SystemSettingsDoc {
  version: number;
  skills?: { enabled?: boolean };
}

/** `/admin/settings/skills` (#1008): the deployment's switch, the `skills` namespace of the system settings; writes need `system_settings:write`. */
export function SkillsAdminPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const action = useApiAction();
  const [doc, setDoc] = useState<SystemSettingsDoc | null>(null);
  const { setError } = action;
  useEffect(() => {
    api
      .get<SystemSettingsDoc>('/system-settings')
      .then(setDoc)
      .catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : 'Could not load the settings'));
  }, [api, setError]);
  const on = doc?.skills?.enabled !== false;
  const toggle = async (enabled: boolean) => {
    if (!doc) return;
    try {
      const next = await api.patch<SystemSettingsDoc>('/system-settings', { skills: { enabled } }, { ifMatch: String(doc.version) });
      setDoc(next);
      setError(null);
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : e instanceof Error && e.message ? e.message : 'Could not save the settings');
    }
  };
  return (
    <PageContainer width="narrow">
      <PageHeader title="Skills" subtitle="Your users' written guidance for kinds of jobs, offered to their runs and chats when a job fits." back={{ to: '/admin/settings', label: 'Settings' }} />
      <ErrorBanner error={action.error} />
      {!doc && !action.error && <CardSkeleton />}
      {doc && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <FormControlLabel control={<Switch checked={on} disabled={!canWrite} onChange={(e) => void toggle(e.target.checked)} />} label="Offer skills to runs and chats" />
          <FormHelperText>On by default. Off: no run or chat is offered a skill; every user's skills are kept. A skill never grants a site, a payment or a recipient.</FormHelperText>
        </Paper>
      )}
    </PageContainer>
  );
}
