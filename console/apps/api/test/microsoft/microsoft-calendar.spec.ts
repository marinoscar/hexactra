// Outlook calendar through the fake Graph (E39.4, #602): explicit time zones, paging, free/busy for work and personal accounts, and
// the rule that nobody is emailed by surprise (NOTIFY_REQUIRED).
import { CapabilityError } from '../../src/connections/capabilities';
import { mergeBlocks } from '../../src/connections/microsoft/microsoft.calendar';
import { createHarness } from './harness';

const fail = async (p: Promise<unknown>): Promise<CapabilityError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CapabilityError) return e;
    throw e;
  }
  throw new Error('expected a failure');
};
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof CapabilityError ? e.code : `other:${(e as Error).name}`;
  }
};

function setup(kind: 'work' | 'personal' = 'work') {
  const h = createHarness();
  const a = h.addAccount({ email: 'person-a@example.test', kind });
  const c = h.connect(a);
  const cal = (signal?: AbortSignal) => h.hub.calendar(c.ctx(signal));
  const graph = (f?: (r: { method: string; path: string }) => boolean) => h.fake.calls((r) => r.host === 'graph.microsoft.com' && (!f || f(r)));
  return { h, a, c, cal, graph };
}

describe('calendars and events', () => {
  it('lists the calendars with the access this account has', async () => {
    const { a, cal } = setup();
    a.calendars.push({ id: 'CAL-2', name: 'Team', isDefault: false, canEdit: false, owner: 'person-b@example.test' }, { id: 'CAL-3', name: 'Mine too', isDefault: false, canEdit: true, owner: 'person-a@example.test' });
    expect(await cal().listCalendars()).toEqual([
      { id: 'CAL-default', name: 'Calendar', primary: true, timeZone: null, accessRole: 'owner' },
      { id: 'CAL-2', name: 'Team', primary: false, timeZone: null, accessRole: 'reader' },
      { id: 'CAL-3', name: 'Mine too', primary: false, timeZone: null, accessRole: 'owner' },
    ]);
  });

  it('asks for the window and UTC, and returns each instant with an offset, whatever zone the event was made in', async () => {
    const { a, cal, graph } = setup();
    a.addEvent({ subject: 'Standup', start: '2026-03-02T14:30:00Z', end: '2026-03-02T15:00:00Z', originalStartTimeZone: 'America/New_York', location: 'Room 1', body: 'agenda' });
    const page = await cal().listEvents({ from: '2026-03-02T00:00:00Z', to: '2026-03-03T00:00:00Z' });
    expect(page.items).toEqual([{ id: expect.any(String), calendarId: 'primary', title: 'Standup', description: 'agenda', location: 'Room 1', start: '2026-03-02T14:30:00Z', end: '2026-03-02T15:00:00Z', allDay: false, timeZone: 'America/New_York', status: 'confirmed', attendees: [], recurring: false, conferenceUrl: null, webUrl: expect.stringContaining('https://') }]);
    const req = graph((r) => r.path === '/me/calendar/calendarView')[0] as unknown as { query: Record<string, string>; headers: Record<string, string> };
    expect(req.query.startDateTime).toBe('2026-03-02T00:00:00Z');
    expect(req.query.endDateTime).toBe('2026-03-03T00:00:00Z');
    expect(req.headers.prefer).toContain('outlook.timezone="UTC"');
  });

  it('maps attendees, the organizer, responses, a join link, cancelled and recurring events, and an all-day event as a date', async () => {
    const { a, cal } = setup();
    a.addEvent({ subject: 'Planning', start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z', attendees: [{ address: 'person-a@example.test', response: 'organizer' }, { address: 'person-b@example.test', name: 'Person B', response: 'tentativelyAccepted' }, { address: 'person-c@example.test', response: 'none' }], joinUrl: 'https://teams.example.test/join/1', type: 'seriesMaster' });
    a.addEvent({ subject: 'Holiday', start: '2026-03-03T00:00:00Z', end: '2026-03-04T00:00:00Z', isAllDay: true });
    a.addEvent({ subject: 'Dropped', start: '2026-03-05T10:00:00Z', end: '2026-03-05T11:00:00Z', isCancelled: true });
    const items = (await cal().listEvents({ from: '2026-03-01T00:00:00Z', to: '2026-03-10T00:00:00Z' })).items;
    const planning = items.find((e) => e.title === 'Planning')!;
    expect(planning.attendees).toEqual([
      { address: 'person-a@example.test', name: null, response: 'accepted', organizer: true },
      { address: 'person-b@example.test', name: 'Person B', response: 'tentative', organizer: false },
      { address: 'person-c@example.test', name: null, response: 'needsAction', organizer: false },
    ]);
    expect(planning).toMatchObject({ conferenceUrl: 'https://teams.example.test/join/1', recurring: true });
    expect(items.find((e) => e.title === 'Holiday')).toMatchObject({ allDay: true, start: '2026-03-03', end: '2026-03-04' });
    expect(items.find((e) => e.title === 'Dropped')!.status).toBe('cancelled');
  });

  it('filters by text on the title (quotes doubled), reads another calendar through its own path, and pages', async () => {
    const { a, cal, graph } = setup();
    a.calendars.push({ id: 'CAL-2', name: 'Team', isDefault: false, canEdit: true, owner: 'person-a@example.test' });
    for (let i = 0; i < 3; i++) a.addEvent({ subject: `O'Brien sync ${i}`, start: `2026-03-0${i + 2}T10:00:00Z`, end: `2026-03-0${i + 2}T11:00:00Z`, calendarId: 'CAL-2' });
    a.addEvent({ subject: 'Unrelated', start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z', calendarId: 'CAL-2' });
    const q = { calendarId: 'CAL-2', from: '2026-03-01T00:00:00Z', to: '2026-03-10T00:00:00Z', text: "O'Brien", pageSize: 2 };
    const p1 = await cal().listEvents(q);
    expect(p1.items.map((e) => e.title)).toEqual(["O'Brien sync 0", "O'Brien sync 1"]);
    expect(p1.items[0]!.calendarId).toBe('CAL-2');
    const p2 = await cal().listEvents({ ...q, pageToken: p1.nextPageToken! });
    expect(p2.items.map((e) => e.title)).toEqual(["O'Brien sync 2"]);
    expect(p2.nextPageToken).toBeNull();
    const first = graph((r) => r.path === '/me/calendars/CAL-2/calendarView')[0] as unknown as { query: Record<string, string> };
    expect(first.query.$filter).toBe("contains(subject,'O''Brien')");
    expect(await code(cal().listEvents({ ...q, calendarId: undefined, pageToken: p1.nextPageToken! }))).toBe('INVALID_INPUT');
  });
});

describe('creating and changing events', () => {
  const base = { title: 'Review', start: '2026-03-02T09:30:00-05:00', end: '2026-03-02T10:30:00-05:00' };

  it('writes the wall time in the zone of the event with that zone named, and returns the instant', async () => {
    const { a, cal, graph } = setup();
    const e = await cal().createEvent({ ...base, timeZone: 'America/New_York', description: 'notes', location: 'Room 2' });
    expect(e).toMatchObject({ title: 'Review', start: '2026-03-02T14:30:00Z', end: '2026-03-02T15:30:00Z', timeZone: 'America/New_York', description: 'notes', location: 'Room 2' });
    const req = graph((r) => r.method === 'POST' && r.path === '/me/calendar/events')[0] as unknown as { json: Record<string, any> };
    expect(req.json.start).toEqual({ dateTime: '2026-03-02T09:30:00.0000000', timeZone: 'America/New_York' });
    expect(req.json.end).toEqual({ dateTime: '2026-03-02T10:30:00.0000000', timeZone: 'America/New_York' });
    expect(req.json.isAllDay).toBe(false);
    expect(a.events).toHaveLength(1);
  });

  it('defaults to UTC when no zone is named, and keeps an offset that is not the zone of the calendar', async () => {
    const { cal, graph } = setup();
    await cal().createEvent(base);
    const req = graph((r) => r.method === 'POST')[0] as unknown as { json: Record<string, any> };
    expect(req.json.start).toEqual({ dateTime: '2026-03-02T14:30:00.0000000', timeZone: 'UTC' });
  });

  it('creates an all-day event from dates, and refuses a date paired with a time', async () => {
    const { cal, graph } = setup();
    const e = await cal().createEvent({ title: 'Away', start: '2026-03-02', end: '2026-03-03' });
    expect(e).toMatchObject({ allDay: true, start: '2026-03-02', end: '2026-03-03' });
    expect((graph((r) => r.method === 'POST')[0] as unknown as { json: Record<string, any> }).json.isAllDay).toBe(true);
    expect(await code(cal().createEvent({ title: 'Mixed', start: '2026-03-02', end: '2026-03-03T10:00:00Z' }))).toBe('INVALID_INPUT');
    expect(await code(cal().createEvent({ ...base, timeZone: 'Not/AZone' }))).toBe('INVALID_INPUT');
  });

  it('writes into another calendar when asked, and returns the first event for a retried idempotency key', async () => {
    const { a, cal, graph } = setup();
    a.calendars.push({ id: 'CAL-2', name: 'Team', isDefault: false, canEdit: true, owner: 'person-a@example.test' });
    const first = await cal().createEvent({ ...base, calendarId: 'CAL-2', idempotencyKey: 'create-key-1' });
    const again = await cal().createEvent({ ...base, calendarId: 'CAL-2', idempotencyKey: 'create-key-1' });
    expect(again.id).toBe(first.id);
    expect(a.events).toHaveLength(1);
    expect(graph((r) => r.method === 'POST' && r.path === '/me/calendars/CAL-2/events')).toHaveLength(2);
    expect((graph((r) => r.method === 'POST')[0] as unknown as { json: Record<string, any> }).json.transactionId).toBe('create-key-1');
  });

  it('a create that fails with a 5xx is repeated safely (the transaction id makes it one event)', async () => {
    const { h, a, cal } = setup();
    h.fake.failAfter((r) => r.method === 'POST' && r.path === '/me/calendar/events', 504);
    const e = await cal().createEvent({ ...base, idempotencyKey: 'create-key-2' });
    expect(e.title).toBe('Review');
    expect(a.events).toHaveLength(1);
  });

  it('a video conference is a Teams meeting on a work account and not supported on a personal one', async () => {
    const work = setup('work');
    expect((await work.cal().createEvent({ ...base, conference: true })).conferenceUrl).toMatch(/^https:/);
    const personal = setup('personal');
    expect(await code(personal.cal().createEvent({ ...base, conference: true }))).toBe('NOT_SUPPORTED');
    expect(personal.h.fake.requests).toHaveLength(0);
  });

  describe('attendees are never emailed by surprise', () => {
    const attendees = [{ address: 'person-b@example.test', name: 'Person B' }];

    it('refuses to create an event with attendees unless notifying is allowed, and sends nothing', async () => {
      const { a, h, cal } = setup();
      for (const notifyAttendees of [undefined, false]) {
        const e = await fail(cal().createEvent({ ...base, attendees, notifyAttendees }));
        expect(e.code).toBe('NOTIFY_REQUIRED');
        expect(e.message).toMatch(/email the attendees/);
      }
      expect(h.fake.requests).toHaveLength(0);
      expect(a.events).toHaveLength(0);
      expect(a.invitations).toHaveLength(0);
    });

    it('creates it, and the invitation goes, when notifying is allowed', async () => {
      const { a, cal } = setup();
      const e = await cal().createEvent({ ...base, attendees, notifyAttendees: true });
      expect(e.attendees).toEqual([{ address: 'person-b@example.test', name: 'Person B', response: 'needsAction', organizer: false }]);
      expect(a.invitations).toEqual([{ eventId: e.id, kind: 'invite', to: ['person-b@example.test'] }]);
    });

    it('an event without attendees needs no permission to notify', async () => {
      const { a, cal } = setup();
      await cal().createEvent({ ...base });
      expect(a.invitations).toHaveLength(0);
    });

    it('refuses to change an event that has attendees, or to add some, unless notifying is allowed', async () => {
      const { a, cal, h } = setup();
      const withPeople = a.addEvent({ subject: 'Team', start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z', attendees: [{ address: 'person-b@example.test', response: 'none' }] });
      const alone = a.addEvent({ subject: 'Solo', start: '2026-03-03T10:00:00Z', end: '2026-03-03T11:00:00Z' });
      expect((await fail(cal().updateEvent(withPeople.id, { title: 'Team 2' }))).code).toBe('NOTIFY_REQUIRED');
      expect((await fail(cal().updateEvent(alone.id, { attendees }))).code).toBe('NOTIFY_REQUIRED');
      expect(h.fake.calls((r) => r.method === 'PATCH')).toHaveLength(0);
      expect(withPeople.subject).toBe('Team');
      expect(a.invitations).toHaveLength(0);
      // Without attendees, any change is fine; with permission, the update goes and the attendees are told.
      expect((await cal().updateEvent(alone.id, { title: 'Solo 2' })).title).toBe('Solo 2');
      expect((await cal().updateEvent(withPeople.id, { title: 'Team 2', notifyAttendees: true })).title).toBe('Team 2');
      expect(a.invitations).toEqual([{ eventId: withPeople.id, kind: 'update', to: ['person-b@example.test'] }]);
    });

    it('changes an event somebody else organizes without mailing anyone: only the organizer sends', async () => {
      const { a, cal } = setup();
      const theirs = a.addEvent({ subject: 'Theirs', start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z', organizer: 'person-b@example.test', isOrganizer: false, attendees: [{ address: 'person-a@example.test', response: 'accepted' }, { address: 'person-b@example.test', response: 'organizer' }] });
      expect((await cal().updateEvent(theirs.id, { description: 'my note' })).description).toBe('my note');
    });

    it('cancels an event with attendees only when notifying is allowed (the cancellation is what tells them), and deletes one without', async () => {
      const { a, cal } = setup();
      const withPeople = a.addEvent({ subject: 'Team', start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z', attendees: [{ address: 'person-b@example.test', response: 'none' }] });
      const alone = a.addEvent({ subject: 'Solo', start: '2026-03-03T10:00:00Z', end: '2026-03-03T11:00:00Z' });
      expect((await fail(cal().deleteEvent(withPeople.id, { notifyAttendees: false }))).code).toBe('NOTIFY_REQUIRED');
      expect(withPeople.isCancelled).toBe(false);
      expect(a.invitations).toHaveLength(0);
      await cal().deleteEvent(withPeople.id, { notifyAttendees: true });
      expect(withPeople.isCancelled).toBe(true);
      expect(a.invitations).toEqual([{ eventId: withPeople.id, kind: 'cancel', to: ['person-b@example.test'] }]);
      await cal().deleteEvent(alone.id, { notifyAttendees: false });
      expect(a.events.some((e) => e.id === alone.id)).toBe(false);
      expect(await code(cal().deleteEvent('missing', { notifyAttendees: false }))).toBe('NOT_FOUND');
    });
  });

  it('updates the fields given: title, notes cleared, location cleared, new times in a zone', async () => {
    const { a, cal, graph } = setup();
    const ev = a.addEvent({ subject: 'Old', body: 'notes', location: 'Here', start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z' });
    const e = await cal().updateEvent(ev.id, { title: 'New', description: null, location: null, start: '2026-03-02T12:00:00+01:00', end: '2026-03-02T13:00:00+01:00', timeZone: 'Europe/Paris' });
    expect(e).toMatchObject({ title: 'New', description: null, location: null, start: '2026-03-02T11:00:00Z', end: '2026-03-02T12:00:00Z' });
    const req = graph((r) => r.method === 'PATCH')[0] as unknown as { json: Record<string, any> };
    expect(req.json.start).toEqual({ dateTime: '2026-03-02T12:00:00.0000000', timeZone: 'Europe/Paris' });
    expect(req.json.attendees).toBeUndefined();
  });
});

describe('free and busy', () => {
  const win = { from: '2026-03-02T00:00:00Z', to: '2026-03-03T00:00:00Z' };

  it('work account: asks the schedule service and merges what is busy, ignoring free time', async () => {
    const { a, cal, graph } = setup('work');
    a.addEvent({ subject: 'a', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' });
    a.addEvent({ subject: 'b', start: '2026-03-02T09:30:00Z', end: '2026-03-02T11:00:00Z', showAs: 'tentative' });
    a.addEvent({ subject: 'free', start: '2026-03-02T12:00:00Z', end: '2026-03-02T13:00:00Z', showAs: 'free' });
    a.addEvent({ subject: 'later', start: '2026-03-02T15:00:00Z', end: '2026-03-02T16:00:00Z' });
    expect(await cal().freeBusy(win)).toEqual([
      { calendarId: 'primary', start: '2026-03-02T09:00:00Z', end: '2026-03-02T11:00:00Z' },
      { calendarId: 'primary', start: '2026-03-02T15:00:00Z', end: '2026-03-02T16:00:00Z' },
    ]);
    expect(graph((r) => r.path === '/me/calendar/getSchedule')).toHaveLength(1);
    expect((graph((r) => r.path === '/me/calendar/getSchedule')[0] as unknown as { json: Record<string, any> }).json.schedules).toEqual(['person-a@example.test']);
  });

  it('personal account: no schedule service, so the busy time is computed from the events and clipped to the window', async () => {
    const { a, cal, graph } = setup('personal');
    a.addEvent({ subject: 'a', start: '2026-03-01T23:00:00Z', end: '2026-03-02T01:00:00Z' });
    a.addEvent({ subject: 'b', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' });
    a.addEvent({ subject: 'free', start: '2026-03-02T12:00:00Z', end: '2026-03-02T13:00:00Z', showAs: 'free' });
    a.addEvent({ subject: 'cancelled', start: '2026-03-02T14:00:00Z', end: '2026-03-02T15:00:00Z', isCancelled: true });
    expect(await cal().freeBusy(win)).toEqual([
      { calendarId: 'primary', start: '2026-03-02T00:00:00Z', end: '2026-03-02T01:00:00Z' },
      { calendarId: 'primary', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' },
    ]);
    expect(graph((r) => r.path === '/me/calendar/getSchedule')).toHaveLength(0);
  });

  it('named calendars are read from their events, one answer per calendar, on any account', async () => {
    const { a, cal, graph } = setup('work');
    a.calendars.push({ id: 'CAL-2', name: 'Team', isDefault: false, canEdit: true, owner: 'person-a@example.test' });
    a.addEvent({ subject: 'team', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z', calendarId: 'CAL-2' });
    a.addEvent({ subject: 'mine', start: '2026-03-02T11:00:00Z', end: '2026-03-02T12:00:00Z' });
    const blocks = await cal().freeBusy({ ...win, calendarIds: ['CAL-2', 'CAL-default'] });
    expect(blocks).toEqual([
      { calendarId: 'CAL-2', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' },
      { calendarId: 'CAL-default', start: '2026-03-02T11:00:00Z', end: '2026-03-02T12:00:00Z' },
    ]);
    expect(graph((r) => r.path === '/me/calendar/getSchedule')).toHaveLength(0);
  });

  it('merges touching and overlapping blocks', () => {
    expect(mergeBlocks([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 9 }, { start: 9, end: 9 }])).toEqual([{ start: 1, end: 4 }, { start: 5, end: 9 }]);
  });
});
