// A schedule's own values for its task's parameters (#556): one field per
// parameter without a saved value, kept on the schedule; an active schedule
// cannot be saved while a required one is missing; a sensitive parameter is
// never preset, and the editor says its runs will wait.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleEditor } from '../components/ScheduleEditor';
import { draftFromSchedule, draftToItem, type ScheduleDraft } from '../schedule/draft';
import type { TaskParameter } from '../taskParams/model';
import { missingScheduleValues, scheduleValuesOk } from '../taskParams/ScheduleValues';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const PARAMS: TaskParameter[] = [
  { key: 'amount', label: 'Amount', type: 'money', required: true },
  { key: 'note', label: 'Note', type: 'text', required: false },
  { key: 'phone', label: 'Phone', type: 'phone', required: true, default: { value: '555-010-6020' } },
  { key: 'gift_code', label: 'Gift code', type: 'text', required: true, sensitive: true },
];

function preview(request: TestApiRequest) {
  const { cron, timezone } = request.body as { cron: string; timezone: string };
  return { valid: true, cron, timezone, description: `Runs on ${cron}`, next: ['2026-11-18T15:00:00.000Z'], intervalSeconds: null };
}

function mount(initial: ScheduleDraft) {
  const host = createTestPlatformHost({ permissions: ['tasks:read'], responses: { 'POST /schedules/preview': preview } });
  const onValidity = vi.fn<(ok: boolean) => void>();
  let latest = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <ScheduleEditor
        value={value}
        onChange={(d) => {
          latest = d;
          setValue(d);
        }}
        onValidity={onValidity}
        profileTimezone="UTC"
        parameters={PARAMS}
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
  return { onValidity, latest: () => latest };
}

const base: ScheduleDraft = { cron: '0 9 * * *', timezone: 'UTC', enabled: true, concurrency: 'skip', policyId: null };

describe('Values for this schedule', () => {
  it('asks for each parameter without a saved value and keeps them on the schedule', async () => {
    const { onValidity, latest } = mount(base);
    const group = screen.getByRole('region', { name: 'Values for this schedule' });
    expect(within(group).getByRole('textbox', { name: /^Amount/ })).toBeInTheDocument();
    expect(within(group).getByRole('textbox', { name: /^Note/ })).toBeInTheDocument();
    // A saved value needs nothing here.
    expect(within(group).queryByRole('textbox', { name: /^Phone/ })).not.toBeInTheDocument();
    // Active with a required value missing: cannot be saved.
    expect(within(group).getByText('Needed while this schedule is active')).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(false));

    fireEvent.change(within(group).getByRole('textbox', { name: /^Amount/ }), { target: { value: '25' } });
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(true));
    expect(latest().inputs).toEqual({ amount: '25' });
    expect(draftToItem(latest()).inputs).toEqual({ amount: '25' });
  });

  it('a paused schedule may lack a value; an invalid preset is never fine', async () => {
    const { onValidity } = mount({ ...base, enabled: false, inputs: { amount: 'ten' } });
    expect(await screen.findByText('Enter an amount such as 25 or 25.50')).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenLastCalledWith(false));
    expect(scheduleValuesOk(PARAMS, {}, false)).toBe(true);
    expect(scheduleValuesOk(PARAMS, {}, true)).toBe(false);
    expect(missingScheduleValues(PARAMS, { note: 'x' }).map((p) => p.key)).toEqual(['amount']);
  });

  it('says a sensitive parameter makes its runs wait for the owner', () => {
    mount(base);
    expect(screen.getByText('This task asks for Gift code every time, so a schedule will wait for you.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Gift code/)).not.toBeInTheDocument();
  });

  it('reads and writes the presets of a saved schedule, and leaves a schedule without them alone', () => {
    const saved = draftFromSchedule({ id: 's1', cron: '0 9 * * *', timezone: 'UTC', enabled: true, inputs: { amount: '25' } });
    expect(saved.inputs).toEqual({ amount: '25' });
    expect(draftToItem({ ...saved, inputs: {} }).inputs).toBeNull();
    expect(draftToItem(draftFromSchedule({ id: 's2', cron: '0 9 * * *', timezone: 'UTC', enabled: true, inputs: null }))).not.toHaveProperty('inputs');
  });
});
