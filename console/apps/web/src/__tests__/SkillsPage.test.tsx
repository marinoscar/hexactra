// The Skills page (#1008) against canned API answers: the list, the explanation line, the form with its character count, Fill from a
// SKILL.md file (fills the form, saves nothing by itself), a secret refusal, archive with confirm, the switches, and the run page's
// "Skills read".
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { vi } from 'vitest';

import { SkillsRead } from '../pages/RunDetailPage';
import { SKILLS_EXPLANATION, SkillsAdminPage, SkillsPage } from '../pages/SkillsPage';
import { parseSkillFile, type Skill } from '../skills/api';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const READ = ['skills:read'];
const WRITE = ['skills:read', 'skills:write'];
const iso = '2026-11-18T10:00:00.000Z';
const SMS: Skill = {
  id: '55555555-5555-4555-8555-555555555555',
  name: 'Google Messages',
  description: 'How I send text messages from Google Messages on the web',
  body: 'Open messages.google.com. Start chat is top left.',
  sites: ['google.com'],
  enabled: true,
  archivedAt: null,
  lastUsedAt: null,
  useCount: 0,
  createdAt: iso,
  updatedAt: iso,
};

const reads = (list: Skill[]) => ({ 'GET /skills?archived=false': list, 'GET /skills?archived=all': list, 'GET /user-settings': { skills: { enabled: true } } });

function renderPage(host: ReturnType<typeof createTestPlatformHost>, page = <SkillsPage />) {
  return render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>{page}</MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

describe('SkillsPage (#1008)', () => {
  it('lists the skills with their sites and the explanation line; a reader cannot add', async () => {
    renderPage(createTestPlatformHost({ permissions: READ, responses: reads([SMS]) }));
    expect((await screen.findAllByText('Google Messages')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('google.com').length).toBeGreaterThan(0);
    expect(screen.getByTestId('skills-explanation')).toHaveTextContent(SKILLS_EXPLANATION);
    expect(SKILLS_EXPLANATION).toBe('A skill tells the agent how you want a kind of job done. It cannot allow a site, a payment or a recipient: those stay with your settings and approvals.');
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    // The text is not in the list.
    expect(screen.queryByText(/Start chat is top left/)).not.toBeInTheDocument();
  });

  it('Fill from a SKILL.md file fills the form and saves nothing until Save', async () => {
    const host = createTestPlatformHost({ permissions: WRITE, responses: { ...reads([]), 'POST /skills': (r: TestApiRequest) => ({ ...SMS, ...(r.body as object) }) } });
    renderPage(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a skill' }));
    const text = '---\nname: Google Messages\ndescription: "How I text"\nallowed-tools: Bash\n---\n# Texting\nStart chat is top left.\n\nSee [the guide](https://example.test) and scripts/send.sh.\n';
    const file = new File([text], 'SKILL.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByTestId('skill-file'), { target: { files: [file] } });
    await screen.findByText('Filled from SKILL.md. Check it, then press Save.');
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Google Messages');
    expect(screen.getByLabelText(/^When to use it/)).toHaveValue('How I text');
    expect((screen.getByLabelText(/^The text/) as HTMLTextAreaElement).value).toMatch(/^# Texting\nStart chat is top left\./);
    expect(screen.getByText(/Folders, scripts\/, references\/ and links are ignored/)).toBeInTheDocument();
    // Nothing was sent by filling.
    expect(host.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    fireEvent.change(screen.getByLabelText(/^Sites/), { target: { value: 'google.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === '/skills')).toBe(true));
    expect(host.requests.find((r) => r.method === 'POST')!.body).toMatchObject({ name: 'Google Messages', description: 'How I text', sites: ['google.com'] });
  });

  it('shows the character count and the refusal of a secret in the form', async () => {
    const host = createTestPlatformHost({
      permissions: WRITE,
      responses: { ...reads([]), 'POST /skills': () => {
          throw createTestApiError(400, 'The text looks like a password, code or other secret.', 'SKILL_SECRET', { issues: [{ field: 'body', reason: 'key', message: 'x' }] });
        },
      },
    });
    renderPage(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a skill' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Bank' } });
    fireEvent.change(screen.getByLabelText(/^When to use it/), { target: { value: 'How I pay' } });
    fireEvent.change(screen.getByLabelText(/^The text/), { target: { value: 'password: hunter22' } });
    expect(screen.getByText(/18 \/ 4,000 characters/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The text looks like a password, code or other secret.')).toBeInTheDocument();
  });

  it('switches a skill off and archives one after confirming', async () => {
    const host = createTestPlatformHost({ permissions: WRITE, responses: { ...reads([SMS]), [`PATCH /skills/${SMS.id}`]: { ...SMS, enabled: false }, [`POST /skills/${SMS.id}/archive`]: { ...SMS, archivedAt: iso } } });
    renderPage(host);
    const toggles = await screen.findAllByRole('switch', { name: 'Google Messages on' });
    fireEvent.click(toggles[0]!);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ enabled: false }));
    fireEvent.click(screen.getAllByText('Google Messages')[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === `/skills/${SMS.id}/archive`)).toBe(true));
  });

  it('the owner switch and the deployment switch save their settings', async () => {
    const host = createTestPlatformHost({ permissions: WRITE, responses: { ...reads([]), 'PATCH /user-settings': { skills: { enabled: false } } } });
    renderPage(host);
    const own = await screen.findByRole('switch', { name: 'Use my skills' });
    await waitFor(() => expect(own).not.toBeDisabled());
    fireEvent.click(own);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH' && r.path === '/user-settings')?.body).toEqual({ skills: { enabled: false } }));

    const admin = createTestPlatformHost({ permissions: ['system_settings:read', 'system_settings:write'], responses: { 'GET /system-settings': { version: 3 }, 'PATCH /system-settings': { version: 4, skills: { enabled: false } } } });
    renderPage(admin, <SkillsAdminPage />);
    const deploy = await screen.findByRole('switch', { name: 'Offer skills to runs and chats' });
    expect(deploy).toBeChecked();
    fireEvent.click(deploy);
    await waitFor(() => expect(admin.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ skills: { enabled: false } }));
  });
});

describe('parseSkillFile and "Skills read" (#1008)', () => {
  it('takes name and description from the front matter and the rest as the text; a file without front matter is all text', () => {
    expect(parseSkillFile('---\nname: A\ndescription: B\n---\nbody')).toEqual({ name: 'A', description: 'B', body: 'body' });
    expect(parseSkillFile('just text\n')).toEqual({ name: '', description: '', body: 'just text' });
  });

  it('the run page names the skills a run read, each a link', () => {
    render(
      <MemoryRouter>
        <SkillsRead skills={[{ id: SMS.id, name: 'Google Messages', archived: false }]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('skills-read')).toHaveTextContent('Skills read: Google Messages');
    expect(screen.getByRole('link', { name: 'Google Messages' })).toHaveAttribute('href', `/settings/skills?skill=${SMS.id}`);
  });
});
