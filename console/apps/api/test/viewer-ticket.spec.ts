import { ViewerTicketService, VIEWER_SESSION_TTL_S } from '../src/fleet/viewer-ticket.service';
import { ticketFrom } from '../src/fleet/viewer.controller';

describe('ViewerTicketService', () => {
  const env = process.env.JWT_SECRET;
  beforeAll(() => (process.env.JWT_SECRET = 'test-jwt-secret-not-real-0123456789'));
  afterAll(() => (process.env.JWT_SECRET = env));

  it('exchanges a ticket once for a session cookie', () => {
    const s = new ViewerTicketService();
    const ticket = s.issueTicket();
    const session = s.exchange(ticket);
    expect(session).toMatch(/^c\./);
    expect(s.validSession(session!)).toBe(true);
    expect(s.exchange(ticket)).toBeNull();
    expect(s.cookieHeader(session!, true)).toBe(`hx_viewer=${session}; Path=/viewer/; Max-Age=${VIEWER_SESSION_TTL_S}; HttpOnly; SameSite=Strict; Secure`);
  });

  it('refuses forged, swapped, expired and foreign values', () => {
    const s = new ViewerTicketService();
    const ticket = s.issueTicket();
    expect(s.validSession(ticket)).toBe(false); // a ticket is not a session
    expect(s.exchange(ticket.slice(0, -2) + 'xx')).toBeNull();
    expect(s.exchange(undefined)).toBeNull();
    expect(s.exchange('t.1.a.b')).toBeNull();
    expect(s.exchange(ticket, Date.now() + 61_000)).toBeNull();
    process.env.JWT_SECRET = 'another-secret-entirely-0123456789';
    expect(new ViewerTicketService().exchange(s.issueTicket())).toBeNull();
    process.env.JWT_SECRET = 'test-jwt-secret-not-real-0123456789';
  });
});

describe('ticketFrom (the URI nginx forwards to viewer-auth)', () => {
  it('reads the ticket query parameter of the original viewer URL', () => {
    expect(ticketFrom('/viewer/local/vnc.html?ticket=t.1.a.b&autoconnect=1')).toBe('t.1.a.b');
    expect(ticketFrom('/viewer/local/vnc.html')).toBeUndefined();
    expect(ticketFrom(undefined)).toBeUndefined();
    expect(ticketFrom('/' + 'x'.repeat(5000))).toBeUndefined();
  });
});
