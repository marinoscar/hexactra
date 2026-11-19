// The chat thread's pure parts (#486): merging, rows, and the words of the header and the list.
import { describe, expect, it } from 'vitest';

import { UNTITLED_CHAT, chatSubtitle, chatTitle, clarifyOptions, dayLabel, lastSeq, mergeMessages, previewLine, threadRows } from '../components/chatThread';
import type { ChatMessage } from '../types/chat';

const message = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${seq}`, seq, role: 'user', kind: 'text', text: `message ${seq}`, runId: null, meta: null, createdAt: '2026-11-17T10:00:00Z', ...over });

describe('mergeMessages', () => {
  it('keeps one row per seq, oldest first, and the newest copy of a row that arrives twice', () => {
    const merged = mergeMessages([message(1), message(3)], [message(2), message(3, { text: 'edited' }), message(1)]);
    expect(merged.map((m) => [m.seq, m.text])).toEqual([[1, 'message 1'], [2, 'message 2'], [3, 'edited']]);
    expect(lastSeq(merged)).toBe(3);
  });

  it('returns the same array when nothing arrived, and 0 as the last seq of an empty thread', () => {
    const prev = [message(1)];
    expect(mergeMessages(prev, [])).toBe(prev);
    expect(lastSeq([])).toBe(0);
  });
});

describe('clarifyOptions', () => {
  it('reads up to four non-empty strings from a clarify message, and nothing from any other', () => {
    expect(clarifyOptions(message(1, { kind: 'clarify', meta: { options: ['4:30 PM', '', 7, '7:30 PM', 'a', 'b', 'c'] } }))).toEqual(['4:30 PM', '7:30 PM', 'a', 'b']);
    expect(clarifyOptions(message(1, { kind: 'clarify', meta: null }))).toEqual([]);
    expect(clarifyOptions(message(1, { kind: 'clarify', meta: { options: 'no' } }))).toEqual([]);
    expect(clarifyOptions(message(1, { kind: 'text', meta: { options: ['x'] } }))).toEqual([]);
  });
});

describe('threadRows', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');

  it('puts a day separator before the first message of each day, in the profile time zone', () => {
    const rows = threadRows([message(1, { createdAt: '2026-11-10T10:00:00Z' }), message(2, { createdAt: '2026-11-17T23:30:00Z' }), message(3, { createdAt: '2026-11-18T09:00:00Z' }), message(4, { createdAt: '2026-11-18T10:00:00Z' })], 'UTC', now);
    expect(rows.map((r) => (r.type === 'day' ? r.label : r.message.seq))).toEqual(['Tue, Nov 10, 2026', 1, 'Yesterday', 2, 'Today', 3, 4]);
    // 23:30 UTC on the 17th is already the 18th in Madrid: one day, not two.
    expect(threadRows([message(2, { createdAt: '2026-11-17T23:30:00Z' }), message(3, { createdAt: '2026-11-18T09:00:00Z' })], 'Europe/Madrid', now).filter((r) => r.type === 'day')).toHaveLength(1);
  });

  it('labels today and yesterday', () => {
    expect(dayLabel('2026-11-18T01:00:00Z', 'UTC', now)).toBe('Today');
    expect(dayLabel('2026-11-17T01:00:00Z', 'UTC', now)).toBe('Yesterday');
  });
});

describe('the words of the header and the list', () => {
  it('names an untitled chat', () => {
    expect(chatTitle({ title: '  ' })).toBe(UNTITLED_CHAT);
    expect(chatTitle(null)).toBe(UNTITLED_CHAT);
    expect(chatTitle({ title: 'Cinema' })).toBe('Cinema');
  });

  it('says what is happening: archived first, then the run, then thinking', () => {
    expect(chatSubtitle({ chat: { status: 'archived' }, thinking: true, run: { status: 'running' } })).toBe('Archived');
    expect(chatSubtitle({ chat: { status: 'active' }, thinking: true, run: { status: 'running' } })).toBe('Working in the browser…');
    expect(chatSubtitle({ chat: { status: 'active' }, thinking: false, run: { status: 'paused' } })).toBe('Paused');
    expect(chatSubtitle({ chat: { status: 'active' }, thinking: false, run: { status: 'waiting_human' } })).toBe('Waiting for you');
    expect(chatSubtitle({ chat: { status: 'active' }, thinking: false, run: { status: 'queued' } })).toBe('Starting the browser…');
    expect(chatSubtitle({ chat: { status: 'active' }, thinking: true, run: { status: 'succeeded' } })).toBe('Thinking…');
    expect(chatSubtitle({ chat: { status: 'active' }, thinking: false, run: null })).toBe('');
  });

  it('previews the last message of a chat', () => {
    expect(previewLine({ preview: null })).toBe('No messages yet');
    expect(previewLine({ preview: { role: 'user', kind: 'text', text: 'Book it' } })).toBe('You: Book it');
    expect(previewLine({ preview: { role: 'assistant', kind: 'text', text: 'Which showing?' } })).toBe('Which showing?');
    expect(previewLine({ preview: { role: 'assistant', kind: 'run', text: 'Book 2 seats' } })).toBe('Started: Book 2 seats');
    expect(previewLine({ preview: { role: 'assistant', kind: 'result', text: 'Booked' } })).toBe('Result: Booked');
    expect(previewLine({ preview: { role: 'assistant', kind: 'task_draft', text: '' } })).toBe('Drafted a task');
  });
});
