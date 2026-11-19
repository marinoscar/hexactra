// Outlook calendar through Microsoft Graph (E39.4, #602): the `CalendarCapability` for a Microsoft account.
//
// Times: every request asks for `Prefer: outlook.timezone="UTC"`, so what comes back is UTC and is returned as an instant with `Z`;
// what is written is the wall time of the instant in the event's zone (the `timeZone` of the event, else UTC) together with that zone,
// so the event keeps the zone the caller meant. An all-day event is a date.
//
// NOTIFICATIONS. Graph emails the attendees when an event that has any is created, changed or cancelled, and offers no general "do not
// notify" switch (found in the documentation, to be confirmed on a real account: docs/decisions/connections-auth.md, experiment matrix).
// The interface says an agent must not email people by side effect, so a change that would notify while `notifyAttendees` is false is
// REFUSED with NOTIFY_REQUIRED before any request that could send, instead of emailing anyone by surprise.
import { randomUUID } from 'node:crypto';

import {
  CapabilityError,
  notifyAttendeesOf,
  pageSizeOf,
  type BusyBlock,
  type CalendarCapability,
  type CalendarEvent,
  type CalendarInfo,
  type CapabilityContext,
  type DeleteEventOptions,
  type EventPatch,
  type EventQuery,
  type FreeBusyQuery,
  type NewEvent,
  type Page,
} from '../capabilities';
import { GraphClient, decodePageToken, encodePageToken } from './graph-client';
import { RESPONSE_TIME_ZONE } from './microsoft.constants';
import { instantOf, isPersonal, odataString, seg, wallTime } from './microsoft.support';

type G = Record<string, unknown>;

const EVENT_FIELDS = 'id,subject,body,location,start,end,isAllDay,isCancelled,originalStartTimeZone,responseStatus,attendees,organizer,type,onlineMeeting,onlineMeetingUrl,webLink,isOrganizer';
const PREFER_UTC = `outlook.timezone="${RESPONSE_TIME_ZONE}"`;
const PREFER_TEXT = 'outlook.body-content-type="text"';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

const RESPONSE: Record<string, 'accepted' | 'declined' | 'tentative' | 'needsAction'> = { accepted: 'accepted', organizer: 'accepted', declined: 'declined', tentativelyAccepted: 'tentative', notResponded: 'needsAction', none: 'needsAction' };

function mapEvent(e: G, calendarId: string): CalendarEvent {
  const allDay = e.isAllDay === true;
  const startAt = instantOf((e.start as G | undefined)?.dateTime);
  const endAt = instantOf((e.end as G | undefined)?.dateTime);
  const organizer = str(((e.organizer as G | undefined)?.emailAddress as G | undefined)?.address).toLowerCase();
  const online = e.onlineMeeting as G | null | undefined;
  const joinUrl = str(online?.joinUrl) || str(e.onlineMeetingUrl);
  const status = e.isCancelled === true ? 'cancelled' : str((e.responseStatus as G | undefined)?.response) === 'tentativelyAccepted' ? 'tentative' : 'confirmed';
  return {
    id: str(e.id),
    calendarId,
    title: str(e.subject),
    description: str((e.body as G | undefined)?.content) || null,
    location: str((e.location as G | undefined)?.displayName) || null,
    start: allDay ? (startAt ?? '').slice(0, 10) : (startAt ?? ''),
    end: allDay ? (endAt ?? '').slice(0, 10) : (endAt ?? ''),
    allDay,
    timeZone: str(e.originalStartTimeZone) || null,
    status,
    attendees: (Array.isArray(e.attendees) ? (e.attendees as G[]) : [])
      .map((a) => ({ address: str((a.emailAddress as G | undefined)?.address), name: str((a.emailAddress as G | undefined)?.name) || null, response: RESPONSE[str((a.status as G | undefined)?.response)] ?? ('needsAction' as const), organizer: str((a.emailAddress as G | undefined)?.address).toLowerCase() === organizer && organizer !== '' }))
      .filter((a) => a.address !== ''),
    recurring: str(e.type) !== '' && str(e.type) !== 'singleInstance',
    conferenceUrl: joinUrl || null,
    webUrl: str(e.webLink) || null,
  };
}

/** Busy intervals, sorted and merged when they touch or overlap. */
export function mergeBlocks(blocks: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...blocks].filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

export class MicrosoftCalendar implements CalendarCapability {
  constructor(
    private readonly g: GraphClient,
    private readonly ctx: CapabilityContext,
  ) {}

  private eventsBase(calendarId?: string): string {
    return calendarId && calendarId !== 'primary' ? `/me/calendars/${seg(calendarId)}` : '/me/calendar';
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const res = (await this.g.json<G>(this.ctx, { op: 'calendar.list', method: 'GET', path: '/me/calendars', query: { $top: '50', $select: 'id,name,isDefaultCalendar,canEdit,owner' }, capability: 'calendar_read' })) ?? {};
    const me = this.ctx.connection.accountEmail.toLowerCase();
    return ((Array.isArray(res.value) ? res.value : []) as G[]).map((c) => ({
      id: str(c.id),
      name: str(c.name),
      primary: c.isDefaultCalendar === true,
      timeZone: null,
      accessRole: str((c.owner as G | undefined)?.address).toLowerCase() === me ? ('owner' as const) : c.canEdit === true ? ('writer' as const) : ('reader' as const),
    }));
  }

  async listEvents(q: EventQuery): Promise<Page<CalendarEvent>> {
    const size = pageSizeOf(q);
    const base = `${this.eventsBase(q.calendarId)}/calendarView`;
    const path = q.pageToken
      ? decodePageToken(q.pageToken, `${base}?`)
      : base;
    const query = q.pageToken
      ? undefined
      : { startDateTime: q.from, endDateTime: q.to, $top: String(size), $orderby: 'start/dateTime', $select: EVENT_FIELDS, ...(q.text?.trim() ? { $filter: `contains(subject,'${odataString(q.text.trim())}')` } : {}) };
    const res = (await this.g.json<G>(this.ctx, { op: 'calendar.events', method: 'GET', path, query, headers: { Prefer: `${PREFER_UTC}, ${PREFER_TEXT}` }, capability: 'calendar_read' })) ?? {};
    return {
      items: ((Array.isArray(res.value) ? res.value : []) as G[]).slice(0, size).map((e) => mapEvent(e, q.calendarId ?? 'primary')),
      nextPageToken: encodePageToken(res['@odata.nextLink'], this.g.baseUrl),
    };
  }

  async freeBusy(q: FreeBusyQuery): Promise<BusyBlock[]> {
    // `getSchedule` for the account itself on work and school accounts; everything else (personal accounts, or named calendars) from the events.
    if (!isPersonal(this.ctx) && !q.calendarIds) {
      const res = (await this.g.json<G>(this.ctx, {
        op: 'calendar.schedule',
        method: 'POST',
        path: '/me/calendar/getSchedule',
        json: { schedules: [this.ctx.connection.accountEmail], startTime: { dateTime: wallTime(q.from, 'UTC'), timeZone: 'UTC' }, endTime: { dateTime: wallTime(q.to, 'UTC'), timeZone: 'UTC' }, availabilityViewInterval: 30 },
        headers: { Prefer: `outlook.timezone="UTC"` },
        repeatable: true,
        capability: 'calendar_read',
      })) ?? {};
      const items = (((Array.isArray(res.value) ? res.value : []) as G[])[0]?.scheduleItems ?? []) as G[];
      const blocks = items
        .filter((i) => str(i.status) !== 'free')
        .map((i) => ({ start: Date.parse(instantOf((i.start as G | undefined)?.dateTime) ?? ''), end: Date.parse(instantOf((i.end as G | undefined)?.dateTime) ?? '') }))
        .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));
      return mergeBlocks(blocks).map((b) => ({ calendarId: 'primary', start: new Date(b.start).toISOString().replace(/\.\d{3}Z$/, 'Z'), end: new Date(b.end).toISOString().replace(/\.\d{3}Z$/, 'Z') }));
    }
    const out: BusyBlock[] = [];
    for (const calendarId of q.calendarIds ?? ['primary']) {
      const blocks: { start: number; end: number }[] = [];
      let path = `${this.eventsBase(calendarId)}/calendarView`;
      let query: Record<string, string> | undefined = { startDateTime: q.from, endDateTime: q.to, $top: '50', $select: 'start,end,showAs,isCancelled,isAllDay' };
      for (let page = 0; page < 20; page++) {
        const res = (await this.g.json<G>(this.ctx, { op: 'calendar.busy', method: 'GET', path, query, headers: { Prefer: PREFER_UTC }, capability: 'calendar_read' })) ?? {};
        for (const e of (Array.isArray(res.value) ? res.value : []) as G[]) {
          if (e.isCancelled === true || str(e.showAs) === 'free') continue;
          const start = Date.parse(instantOf((e.start as G | undefined)?.dateTime) ?? '');
          const end = Date.parse(instantOf((e.end as G | undefined)?.dateTime) ?? '');
          // An event may begin before or end after the window: only the part inside counts.
          if (Number.isFinite(start) && Number.isFinite(end)) blocks.push({ start: Math.max(start, Date.parse(q.from)), end: Math.min(end, Date.parse(q.to)) });
        }
        const next = encodePageToken(res['@odata.nextLink'], this.g.baseUrl);
        if (!next) break;
        path = decodePageToken(next, `${this.eventsBase(calendarId)}/calendarView?`);
        query = undefined;
      }
      for (const b of mergeBlocks(blocks)) out.push({ calendarId, start: new Date(b.start).toISOString().replace(/\.\d{3}Z$/, 'Z'), end: new Date(b.end).toISOString().replace(/\.\d{3}Z$/, 'Z') });
    }
    return out;
  }

  private time(value: string, tz: string | undefined): { dateTime: string; timeZone: string } {
    return isDate(value) ? { dateTime: `${value}T00:00:00.0000000`, timeZone: 'UTC' } : { dateTime: wallTime(value, tz), timeZone: tz ?? 'UTC' };
  }

  async createEvent(e: NewEvent): Promise<CalendarEvent> {
    const attendees = e.attendees ?? [];
    // Refused before anything is sent: nobody is emailed by surprise.
    if (attendees.length > 0 && !notifyAttendeesOf(e)) throw new CapabilityError('NOTIFY_REQUIRED');
    if (e.conference && isPersonal(this.ctx)) throw new CapabilityError('NOT_SUPPORTED', { reason: 'CONFERENCE' });
    const allDay = isDate(e.start);
    if (allDay !== isDate(e.end)) throw new CapabilityError('INVALID_INPUT', { issues: ['end'] });
    const json = {
      subject: e.title,
      ...(e.description ? { body: { contentType: 'text', content: e.description } } : {}),
      ...(e.location ? { location: { displayName: e.location } } : {}),
      start: this.time(e.start, e.timeZone),
      end: this.time(e.end, e.timeZone),
      isAllDay: allDay,
      ...(attendees.length ? { attendees: attendees.map((a) => ({ type: 'required', emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } })) } : {}),
      ...(e.conference ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
      // Graph's own duplicate guard: a retried create with the same transaction id returns the first event.
      transactionId: e.idempotencyKey ?? randomUUID(),
    };
    const res = (await this.g.json<G>(this.ctx, { op: 'calendar.create', method: 'POST', path: `${this.eventsBase(e.calendarId)}/events`, json, headers: { Prefer: `${PREFER_UTC}, ${PREFER_TEXT}`, 'client-request-id': randomUUID() }, repeatable: true, capability: 'calendar_write' })) as G;
    return mapEvent(res, e.calendarId ?? 'primary');
  }

  /** The event's attendees and whether this account organizes it: what decides whether a change would send mail. */
  private async notifyInfo(id: string): Promise<{ others: number; organizer: boolean }> {
    const cur = (await this.g.json<G>(this.ctx, { op: 'calendar.get', method: 'GET', path: `/me/events/${seg(id)}`, query: { $select: 'attendees,isOrganizer' }, capability: 'calendar_read' })) as G;
    const me = this.ctx.connection.accountEmail.toLowerCase();
    const others = (Array.isArray(cur.attendees) ? (cur.attendees as G[]) : []).filter((a) => str((a.emailAddress as G | undefined)?.address).toLowerCase() !== me).length;
    return { others, organizer: cur.isOrganizer !== false };
  }

  async updateEvent(id: string, patch: EventPatch): Promise<CalendarEvent> {
    const notify = notifyAttendeesOf(patch);
    if (!notify) {
      if ((patch.attendees ?? []).length > 0) throw new CapabilityError('NOTIFY_REQUIRED');
      const info = await this.notifyInfo(id);
      if (info.others > 0 && info.organizer) throw new CapabilityError('NOTIFY_REQUIRED');
    }
    const json: Record<string, unknown> = {};
    if (patch.title !== undefined) json.subject = patch.title;
    if (patch.description !== undefined) json.body = { contentType: 'text', content: patch.description ?? '' };
    if (patch.location !== undefined) json.location = { displayName: patch.location ?? '' };
    if (patch.start !== undefined) json.start = this.time(patch.start, patch.timeZone);
    if (patch.end !== undefined) json.end = this.time(patch.end, patch.timeZone);
    if (patch.start !== undefined && patch.end !== undefined) json.isAllDay = isDate(patch.start);
    if (patch.attendees !== undefined) json.attendees = patch.attendees.map((a) => ({ type: 'required', emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));
    const res = (await this.g.json<G>(this.ctx, { op: 'calendar.update', method: 'PATCH', path: `/me/events/${seg(id)}`, json, headers: { Prefer: `${PREFER_UTC}, ${PREFER_TEXT}`, 'client-request-id': randomUUID() }, repeatable: true, capability: 'calendar_write' })) as G;
    return mapEvent(res, patch.calendarId ?? 'primary');
  }

  async deleteEvent(id: string, opts: DeleteEventOptions): Promise<void> {
    const info = await this.notifyInfo(id);
    const sends = info.others > 0 && info.organizer;
    if (sends && !opts.notifyAttendees) throw new CapabilityError('NOTIFY_REQUIRED');
    // An organizer's cancellation is what tells the attendees; deleting the event outright would not.
    if (sends) await this.g.request(this.ctx, { op: 'calendar.cancel', method: 'POST', path: `/me/events/${seg(id)}/cancel`, json: {}, accept: 'none', capability: 'calendar_write' });
    else await this.g.request(this.ctx, { op: 'calendar.delete', method: 'DELETE', path: `/me/events/${seg(id)}`, accept: 'none', capability: 'calendar_write' });
  }
}
