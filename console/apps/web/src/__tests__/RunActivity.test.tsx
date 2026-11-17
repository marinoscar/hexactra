import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ActionOverlay, activityElapsed, describeActivity, formatDuration, frameCaption, overlayBox, RunActivityBar, stallMessage, type RunActivity } from '../components/RunActivity';

const at = Date.parse('2026-11-16T18:13:00.000Z');
const acting: RunActivity = {
  phase: 'acting',
  action: 'click_at',
  args: { x: 612, y: 340 },
  reason: 'Enter the provided MileagePlus number.',
  startedAt: '2026-11-16T18:12:37.000Z',
  timeoutMs: 45_000,
};

describe('run activity (#379)', () => {
  it('formats durations', () => {
    expect(formatDuration(6_400)).toBe('6 s');
    expect(formatDuration(72_000)).toBe('1 min 12 s');
    expect(formatDuration(-5)).toBe('0 s');
  });

  it('describes each phase and the action target', () => {
    expect(describeActivity(acting)).toBe('Doing: click_at (612, 340)');
    expect(describeActivity({ phase: 'acting', action: 'type', args: { selector: '#member', text_length: 8 }, startedAt: '' })).toBe('Doing: type #member 8 characters');
    expect(describeActivity({ phase: 'acting', action: 'navigate', args: { url: 'https://www.united.com/en/us' }, startedAt: '' })).toBe('Doing: navigate https://www.united.com/en/us');
    expect(describeActivity({ phase: 'thinking', startedAt: '' })).toBe('Thinking about the next step');
    expect(describeActivity({ phase: 'looking', startedAt: '' })).toBe('Looking at the screen');
    expect(describeActivity({ phase: 'starting', startedAt: '' })).toBe('Starting the browser');
  });

  it('never reports a negative elapsed time', () => {
    expect(activityElapsed(acting, at)).toBe(23_000);
    expect(activityElapsed(acting, Date.parse(acting.startedAt) - 2_000)).toBe(0);
    expect(activityElapsed({ phase: 'thinking', startedAt: 'nope' }, at)).toBe(0);
  });

  it('warns only once an activity runs past the stall threshold', () => {
    expect(stallMessage(acting, at)).toBeNull();
    expect(stallMessage(acting, at + 24_000)).toBe('The agent has been waiting on the browser for 47 s (click_at). Take over to help it, or cancel the run.');
    expect(stallMessage({ phase: 'thinking', startedAt: acting.startedAt }, at + 24_000)).toBe('The model has been thinking for 47 s.');
  });

  it('says how old the frame is and when the browser stops answering', () => {
    expect(frameCaption(at - 2_000, false, at)).toEqual({ text: 'Live · updated 2 s ago', stale: false });
    expect(frameCaption(at - 47_000, false, at)).toEqual({ text: 'Last frame 47 s ago', stale: true });
    expect(frameCaption(at - 3_000, true, at)).toEqual({ text: 'Last frame 3 s ago: the browser is not answering', stale: true });
    expect(frameCaption(null, true, at).stale).toBe(true);
    expect(frameCaption(null, false, at)).toEqual({ text: 'Waiting for the first frame…', stale: false });
  });

  it('renders the action, its reason and the time against the timeout', () => {
    render(<RunActivityBar activity={acting} now={at} />);
    const bar = screen.getByRole('status', { name: 'Now' });
    expect(bar).toHaveTextContent('Doing: click_at (612, 340)');
    expect(bar).toHaveTextContent('Enter the provided MileagePlus number.');
    expect(bar).toHaveTextContent('23 s / 45 s');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows why the run is on a stronger model (#405)', () => {
    render(<RunActivityBar activity={{ ...acting, note: 'Escalated to Frontier (stuck: repeated click on #submit)' }} now={at} />);
    expect(screen.getByTestId('activity-note')).toHaveTextContent('Escalated to Frontier (stuck: repeated click on #submit)');
  });

  it('shows the stall banner past the threshold', () => {
    render(<RunActivityBar activity={acting} now={at + 24_000} />);
    expect(screen.getByRole('alert')).toHaveTextContent('waiting on the browser for 47 s');
  });
});

describe('where the agent acts (#381)', () => {
  const frame = { width: 1280, height: 720 };

  it('places a point and a box in percent of the frame, so it scales with the image', () => {
    expect(overlayBox({ x: 640, y: 360 }, frame)).toEqual({ left: '50.000%', top: '50.000%' });
    expect(overlayBox({ x: 0, y: 72, w: 320, h: 72 }, frame)).toEqual({ left: '0.000%', top: '10.000%', width: '25.000%', height: '10.000%' });
    // A box running off the frame is clipped to it.
    expect(overlayBox({ x: 1200, y: 700, w: 400, h: 100 }, frame)).toEqual({ left: '93.750%', top: '97.222%', width: '6.250%', height: '2.778%' });
  });

  it('places nothing without a target, before the frame loads, or off the frame', () => {
    expect(overlayBox(undefined, frame)).toBeNull();
    expect(overlayBox({ x: 1, y: 1 }, null)).toBeNull();
    expect(overlayBox({ x: 2000, y: 10 }, frame)).toBeNull();
  });

  it('draws the marker at the scaled position', () => {
    render(<ActionOverlay activity={{ ...acting, target: { x: 640, y: 180 } }} natural={frame} />);
    const marker = screen.getByRole('img', { name: 'The agent acts here: click_at' });
    expect(marker).toHaveStyle({ position: 'absolute', left: '50.000%', top: '25.000%' });
  });
});
