// The schedule editor (#425): the builder emits the cron expression, the
// summary comes from `POST /schedules/preview`, an expression the server
// refuses blocks saving, and the time zone, overlap rule and policy override
// are part of the draft.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScheduleEditor, type ScheduleDraft } from '../components/ScheduleEditor';
import { ScheduleSummary } from '../components/ScheduleSummary';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';
import { OWN_ID, POLICIES } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const PROFILE = 'America/Costa_Rica';
const NEXT = ['2026-11-18T15:00:00.000Z', '2026-11-19T15:00:00.000Z', '2026-11-20T15:00:00.000Z', '2026-11-23T15:00:00.000Z', '2026-11-24T15:00:00.000Z'];
const catalog = { policies: POLICIES, defaultId: 'builtin:balanced', byId: (id: string | null | undefined) => POLICIES.find((p) => p.id === id) };

/** The preview route: words for the expressions the tests use, a refusal for `nope`. */
function preview(request: TestApiRequest) {
  const { cron, timezone } = request.body as { cron: string; timezone: string };
  if (cron.startsWith('nope')) return { valid: false, code: 'INVALID_CRON', message: 'The cron expression is not valid: unknown alias nope' };
  if (timezone === 'Mars/Olympus') return { valid: false, code: 'INVALID_TIMEZONE', message: 'Unknown time zone' };
  const description = cron === '0 9 * * 1-5' ? 'Monday to Friday at 09:00' : `Runs on ${cron}`;
  return { valid: true, cron, timezone, description, next: NEXT, intervalSeconds: null };
}

const draft = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({ cron: '0 9 * * *', timezone: PROFILE, enabled: true, concurrency: 'skip', policyId: null, ...over });

function mount(initial: ScheduleDraft, options: { catalog?: typeof catalog; taskPolicyId?: string | null; previewRoute?: unknown } = {}) {
  const host = createTestPlatformHost({ permissions: ['tasks:read'], responses: { 'POST /schedules/preview': options.previewRoute ?? preview } });
  const onChange = vi.fn<(d: ScheduleDraft) => void>();
  const onValidity = vi.fn<(ok: boolean) => void>();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <ScheduleEditor
        value={value}
        onChange={(d) => {
          onChange(d);
          setValue(d);
        }}
        onValidity={onValidity}
        profileTimezone={PROFILE}
        catalog={options.catalog}
        taskPolicyId={options.taskPolicyId}
      />
    );
  }
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  const last = () => onChange.mock.calls.at(-1)?.[0];
  const previews = () => host.requests.filter((r) => r.path === '/schedules/preview').map((r) => r.body as { cron: string; timezone: string; count: number });
  return { host, onChange, onValidity, last, previews };
}

const mode = (name: string) => screen.getByRole('button', { name });
const summary = () => screen.getByLabelText('Schedule summary');

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('ScheduleEditor: the builder', () => {
  it('Weekly + Weekdays + 09:00 emits 0 9 * * 1-5, with the sentence and five next runs from the preview', async () => {
    const { last, previews, onValidity } = mount(draft());
    fireEvent.click(mode('Weekly'));
    fireEvent.click(screen.getByRole('button', { name: 'Weekdays' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:00' } });
    expect(last()).toMatchObject({ cron: '0 9 * * 1-5', timezone: PROFILE });
    // Real toggle buttons, Monday first, named in full.
    const days = within(screen.getByRole('group', { name: 'Days of the week' })).getAllByRole('button');
    expect(days.map((b) => b.getAttribute('aria-label'))).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    expect(days.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true', 'true', 'true', 'false', 'false']);

    expect(await within(summary()).findByText(`Monday to Friday at 09:00 · ${PROFILE}`)).toBeInTheDocument();
    expect(summary()).toHaveAttribute('aria-live', 'polite');
    const runs = within(screen.getByRole('list', { name: 'Next runs' })).getAllByRole('listitem');
    expect(runs).toHaveLength(5);
    // In the schedule's zone (15:00 UTC is 09:00 in Costa Rica); the first is also relative.
    expect(runs[0]).toHaveTextContent(/9:00/);
    expect(runs[0]!.textContent).toMatch(/\(.+\)$/);
    expect(runs[1]!.textContent).not.toMatch(/\(/);
    expect(previews().at(-1)).toEqual({ cron: '0 9 * * 1-5', timezone: PROFILE, count: 5 });
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(true));
  });

  it('toggling a day off and on changes the expression; no day at all is an error shown at once and never emitted', async () => {
    const { last, onChange, onValidity, previews } = mount(draft({ cron: '0 9 * * 1' }));
    expect(mode('Weekly')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    expect(last()?.cron).toBe('0 9 * * 1,3');
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    const calls = onChange.mock.calls.length;
    expect(within(summary()).getByText('Choose at least one day.')).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(false));
    expect(onChange.mock.calls.length).toBe(calls);
    expect(last()?.cron).toBe('0 9 * * 1');
    fireEvent.click(screen.getByRole('button', { name: 'Weekends' }));
    expect(last()?.cron).toBe('0 9 * * 0,6');
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(true));
    // Nothing was asked of the server for the incomplete spec.
    await within(summary()).findByText(/Runs on 0 9 \* \* 0,6/);
    expect(previews().every((p) => p.cron.split(' ').length === 5)).toBe(true);
  });

  it.each([
    ['*/15 * * * *', 'Minutes'],
    ['30 */2 * * *', 'Hourly'],
    ['0 9,17 * * *', 'Daily'],
    ['0 9 * * 1-5', 'Weekly'],
    ['0 8 1,15 * *', 'Monthly'],
    ['0 9 1 1 *', 'Advanced'],
    ['0 9 * * MON-FRI', 'Advanced'],
  ])('opens %s in %s', (cron, label) => {
    const { onChange } = mount(draft({ cron }));
    expect(mode(label)).toHaveAttribute('aria-pressed', 'true');
    if (label === 'Minutes') expect(screen.getByRole('combobox', { name: 'Minutes between runs' })).toHaveTextContent('15');
    if (label === 'Advanced') expect(screen.getByLabelText('Cron expression')).toHaveValue(cron);
    // Opening a schedule changes nothing.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Minutes and Hourly', () => {
    const { last } = mount(draft());
    fireEvent.click(mode('Minutes'));
    expect(last()?.cron).toBe('*/15 * * * *');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Minutes between runs' }));
    fireEvent.click(screen.getByRole('option', { name: '30' }));
    expect(last()?.cron).toBe('*/30 * * * *');
    fireEvent.click(mode('Hourly'));
    expect(last()?.cron).toBe('0 * * * *');
    fireEvent.change(screen.getByLabelText('Minute of the hour'), { target: { value: '45' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Hours between runs' }));
    fireEvent.click(screen.getByRole('option', { name: '6' }));
    expect(last()?.cron).toBe('45 */6 * * *');
    fireEvent.change(screen.getByLabelText('Minute of the hour'), { target: { value: '75' } });
    expect(within(summary()).getByText('The minute must be a number from 0 to 59.')).toBeInTheDocument();
    expect(last()?.cron).toBe('45 */6 * * *');
  });

  it('Daily: a second time at the same minute joins the expression; a different minute asks for a second schedule', () => {
    const { last } = mount(draft({ cron: '0 9 * * *' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a time' }));
    expect(last()?.cron).toBe('0 9,10 * * *');
    fireEvent.change(screen.getByLabelText('Time 2'), { target: { value: '17:00' } });
    expect(last()?.cron).toBe('0 9,17 * * *');
    fireEvent.change(screen.getByLabelText('Time 2'), { target: { value: '17:30' } });
    expect(within(summary()).getByText(/must share the same minute.*Add a second schedule/)).toBeInTheDocument();
    expect(last()?.cron).toBe('0 9,17 * * *');
    fireEvent.click(screen.getByRole('button', { name: 'Remove time 2' }));
    expect(last()?.cron).toBe('0 9 * * *');
    // Up to four times.
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Add a time' }));
    expect(last()?.cron).toBe('0 9,10,11,12 * * *');
    expect(screen.queryByRole('button', { name: 'Add a time' })).not.toBeInTheDocument();
  });

  it('Monthly: up to five days, a note for days short months lack, arrow keys move in the grid', () => {
    const { last } = mount(draft({ cron: '30 8 1 * *' }));
    const grid = screen.getByRole('group', { name: 'Days of the month' });
    expect(within(grid).getAllByRole('button')).toHaveLength(31);
    fireEvent.click(within(grid).getByRole('button', { name: 'Day 15' }));
    expect(last()?.cron).toBe('30 8 1,15 * *');
    expect(within(grid).getByRole('button', { name: 'Day 15' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/Months without that day are skipped/)).not.toBeInTheDocument();
    fireEvent.click(within(grid).getByRole('button', { name: 'Day 31' }));
    expect(screen.getByText(/Months without that day are skipped/)).toBeInTheDocument();
    for (const d of [5, 10]) fireEvent.click(within(grid).getByRole('button', { name: `Day ${d}` }));
    expect(last()?.cron).toBe('30 8 1,5,10,15,31 * *');
    // A sixth is not taken.
    fireEvent.click(within(grid).getByRole('button', { name: 'Day 20' }));
    expect(last()?.cron).toBe('30 8 1,5,10,15,31 * *');
    expect(screen.getByText(/Up to 5 days\. Remove one/)).toBeInTheDocument();

    const day8 = within(grid).getByRole('button', { name: 'Day 8' });
    day8.focus();
    fireEvent.keyDown(day8, { key: 'ArrowDown' });
    expect(within(grid).getByRole('button', { name: 'Day 15' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(within(grid).getByRole('button', { name: 'Day 16' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(within(grid).getByRole('button', { name: 'Day 31' })).toHaveFocus();
    // One tab stop: the focused day.
    expect(within(grid).getAllByRole('button').filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it('changing mode keeps the time: Daily 14:30 → Weekly 14:30 → Advanced shows the expression', () => {
    const { last } = mount(draft({ cron: '30 14 * * *' }));
    fireEvent.click(mode('Weekly'));
    expect(last()?.cron).toBe('30 14 * * 1-5');
    fireEvent.click(mode('Advanced'));
    expect(screen.getByLabelText('Cron expression')).toHaveValue('30 14 * * 1-5');
    expect(last()?.cron).toBe('30 14 * * 1-5');
  });
});

describe('ScheduleEditor: Advanced', () => {
  it('echoes the five fields, and an expression the server refuses shows its message and is not valid', async () => {
    const { onValidity, last } = mount(draft({ cron: '0 9 1 1 *' }));
    await within(summary()).findByText(/Runs on 0 9 1 1 \*/);
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(true));
    expect([0, 1, 2, 3, 4].map((i) => screen.getByTestId(`cron-field-${i}`).textContent)).toEqual(['0', '9', '1', '1', '*']);

    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: 'nope 9 * * *' } });
    expect(screen.getByTestId('cron-field-0')).toHaveTextContent('nope');
    expect(await within(summary()).findByText('The cron expression is not valid: unknown alias nope')).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText('Cron expression')).toBeInvalid();

    // Four fields: a local message, at once, and the draft keeps the last five-field text.
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 9 * *' } });
    expect(within(summary()).getByText(/5 fields.*has 4/)).toBeInTheDocument();
    expect(last()?.cron).toBe('nope 9 * * *');
    expect(onValidity).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 9 * * 1-5' } });
    expect(await within(summary()).findByText(/Monday to Friday at 09:00/)).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(true));
    expect(last()?.cron).toBe('0 9 * * 1-5');
  });

  it('typing is debounced: one request for the settled text', async () => {
    const { previews } = mount(draft({ cron: '0 9 1 1 *' }));
    await within(summary()).findByText(/Runs on 0 9 1 1 \*/);
    const before = previews().length;
    for (const text of ['0 9 1 2 *', '0 9 1 3 *', '0 9 1 4 *']) fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: text } });
    await within(summary()).findByText(/Runs on 0 9 1 4 \*/);
    expect(previews().slice(before).map((p) => p.cron)).toEqual(['0 9 1 4 *']);
  });

  it('a preview that fails does not block a spec that passed local validation', async () => {
    const { onValidity } = mount(draft({ cron: '0 9 * * 1-5' }), {
      previewRoute: () => {
        throw createTestApiError(503, 'unavailable');
      },
    });
    expect(await within(summary()).findByText(/Could not check this schedule/)).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(true));
  });

  it('Advanced → a builder mode: an expression the builder reads moves over; one it cannot asks first', async () => {
    const { last } = mount(draft({ cron: '0 9 1 1 *' }));
    fireEvent.click(mode('Daily'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This expression cannot be shown in the builder. Replace it with a daily schedule?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mode('Advanced')).toHaveAttribute('aria-pressed', 'true');
    expect(last()).toBeUndefined();

    fireEvent.click(mode('Daily'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(last()?.cron).toBe('0 9 * * *'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mode('Daily')).toHaveAttribute('aria-pressed', 'true');

    // An expression typed in Advanced that is a weekly schedule opens in Weekly without a question.
    fireEvent.click(mode('Advanced'));
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '15 7 * * 1,2,3,4,5' } });
    fireEvent.click(mode('Weekly'));
    await waitFor(() => expect(last()?.cron).toBe('15 7 * * 1-5'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Time')).toHaveValue('07:15');
  });
});

describe('ScheduleEditor: time zone, overlap, policy, active', () => {
  it('shows the profile zone; Change sets another; the hint appears and its button goes back', async () => {
    const { last, previews } = mount(draft());
    expect(screen.getByText(PROFILE).closest('p')).toHaveTextContent(`Time zone: ${PROFILE} (from your profile)`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const input = await screen.findByRole('combobox', { name: 'Time zone' });
    input.focus();
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: 'Europe/Madr' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Europe/Madrid' }));
    expect(last()?.timezone).toBe('Europe/Madrid');
    expect(screen.getByRole('alert')).toHaveTextContent(`This schedule uses Europe/Madrid; your profile is ${PROFILE}.`);
    expect(screen.getByText('Europe/Madrid', { selector: 'strong' }).closest('p')).not.toHaveTextContent('from your profile');
    await waitFor(() => expect(previews().at(-1)?.timezone).toBe('Europe/Madrid'));
    fireEvent.click(screen.getByRole('button', { name: 'Use my profile time zone' }));
    expect(last()?.timezone).toBe(PROFILE);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an existing schedule in another zone shows the hint on opening', () => {
    mount(draft({ id: 'sc1', timezone: 'Europe/Madrid' }));
    expect(screen.getByRole('alert')).toHaveTextContent(`This schedule uses Europe/Madrid; your profile is ${PROFILE}.`);
  });

  it('a zone the server refuses is not valid', async () => {
    const { onValidity } = mount(draft({ timezone: 'Mars/Olympus' }));
    expect(await within(summary()).findByText('Unknown time zone')).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(false));
  });

  it('the overlap choice sends skip or queue', () => {
    const { last } = mount(draft());
    const group = screen.getByRole('radiogroup', { name: 'If the previous run is still going' });
    expect(within(group).getByRole('radio', { name: 'Skip this run (recommended)' })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'Start another run anyway' }));
    expect(last()?.concurrency).toBe('queue');
    fireEvent.click(within(group).getByRole('radio', { name: 'Skip this run (recommended)' }));
    expect(last()?.concurrency).toBe('skip');
  });

  it('the Active switch pauses and resumes', () => {
    const { last } = mount(draft());
    fireEvent.click(screen.getByRole('switch', { name: 'Active' }));
    expect(last()?.enabled).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Paused' }));
    expect(last()?.enabled).toBe(true);
  });

  it('the policy override: absent without a catalog; with one, names the task policy, sends an id, and null for "Task\'s policy"', async () => {
    mount(draft());
    expect(screen.queryByRole('combobox', { name: 'Policy override' })).not.toBeInTheDocument();
    document.body.innerHTML = '';

    const { last } = mount(draft(), { catalog, taskPolicyId: OWN_ID });
    const select = screen.getByRole('combobox', { name: 'Policy override' });
    expect(select).toHaveTextContent("Task's policy (Careful shopping)");
    expect(screen.getByText("Scheduled runs use the task's policy unless you choose another here.")).toBeInTheDocument();
    fireEvent.mouseDown(select);
    fireEvent.click(await screen.findByRole('option', { name: 'Economy' }));
    expect(last()?.policyId).toBe('builtin:economy');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Policy override' }));
    fireEvent.click(await screen.findByRole('option', { name: /Task's policy/ }));
    expect(last()?.policyId).toBeNull();
  });

  it('a task that follows the default: "Task\'s policy" names the default policy', () => {
    mount(draft(), { catalog, taskPolicyId: null });
    expect(screen.getByRole('combobox', { name: 'Policy override' })).toHaveTextContent("Task's policy (Balanced)");
  });
});

describe('ScheduleEditor on a phone', () => {
  it('the mode selector is a Select, days are single letters with full names, and More options is collapsed by default', () => {
    restore = mockViewport(360);
    const { last } = mount(draft({ cron: '0 9 * * 1-5' }), { catalog });
    const repeats = screen.getByRole('combobox', { name: 'Repeats' });
    expect(repeats).toHaveTextContent('Weekly');
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
    const days = within(screen.getByRole('group', { name: 'Days of the week' })).getAllByRole('button');
    expect(days.map((b) => b.textContent)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(days[2]).toHaveAccessibleName('Wednesday');
    // The summary stays visible; the options are behind "More options".
    expect(summary()).toBeVisible();
    const more = screen.getByRole('button', { name: 'More options' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    fireEvent.click(more);
    expect(screen.getByRole('radiogroup', { name: 'If the previous run is still going' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Policy override' })).toBeInTheDocument();

    fireEvent.mouseDown(repeats);
    fireEvent.click(screen.getByRole('option', { name: 'Monthly' }));
    expect(last()?.cron).toBe('0 9 1 * *');
  });

  it.each<[string, Partial<ScheduleDraft>]>([
    ['a policy override', { policyId: 'builtin:economy' }],
    ['another time zone', { timezone: 'Europe/Madrid' }],
    ['concurrency queue', { concurrency: 'queue' }],
  ])('More options starts open for a draft with %s', (_name, over) => {
    restore = mockViewport(390);
    mount(draft(over), { catalog });
    expect(screen.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radiogroup', { name: 'If the previous run is still going' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Policy override' })).toBeInTheDocument();
  });
});

describe('ScheduleSummary', () => {
  const base = { cron: '0 9 * * 1-5', timezone: PROFILE, enabled: true, nextRunAt: new Date(Date.now() + 3 * 3_600_000 + 60_000).toISOString(), consecutiveFailures: 0, description: 'Monday to Friday at 09:00' };
  const show = (schedule: Parameters<typeof ScheduleSummary>[0]['schedule'], withCatalog = true) =>
    render(<ScheduleSummary schedule={schedule} catalog={withCatalog ? catalog : undefined} profileTimezone={PROFILE} />).container;

  it('the sentence and the next run; no zone when it is the profile zone', () => {
    const row = show(base);
    expect(row).toHaveTextContent('Monday to Friday at 09:00');
    expect(row).not.toHaveTextContent(PROFILE);
    expect(row).toHaveTextContent(/next in 3 h/);
    expect(row).not.toHaveTextContent('failed in a row');
  });
  it('the zone when it differs, Paused, and the failure warning from three in a row', () => {
    const row = show({ ...base, timezone: 'Europe/Madrid', enabled: false, consecutiveFailures: 3 });
    expect(row).toHaveTextContent('Monday to Friday at 09:00 · Europe/Madrid');
    expect(row).toHaveTextContent('Paused');
    expect(row).not.toHaveTextContent('next');
    expect(row).toHaveTextContent('3 failed in a row');
    expect(show({ ...base, consecutiveFailures: 2 })).not.toHaveTextContent('failed in a row');
  });
  it('the policy override by name, "unavailable" for an unknown id, and the expression when there is no sentence', () => {
    expect(show({ ...base, policyId: 'builtin:economy' })).toHaveTextContent('Monday to Friday at 09:00 · policy: Economy');
    expect(show({ ...base, policyId: 'gone' })).toHaveTextContent('policy: unavailable');
    expect(show({ ...base, policyId: 'builtin:economy' }, false)).toHaveTextContent('policy: unavailable');
    expect(show({ ...base, description: undefined })).toHaveTextContent('0 9 * * 1-5');
  });
});
