// The PDF report of a run (#543), from generated traces: the document
// definition (snapshot), the rendered file read back by a PDF library (text,
// pages, page size, outline, metadata), images in and out, the markers a
// reader relies on, and the time and memory of a large run.
import {
  REPORT_FOOTER_NOTE,
  REPORT_IMAGE_MAX_PX,
  REPORT_PARTIAL_BANNER,
  answerLabel,
  buildReportDefinition,
  imageSize,
  renderPdfBuffer,
  reportImage,
  timelineRows,
  type ReportDefinition,
} from '../src/tasks/run-report.pdf';
import { imageObjects, readPdf } from './helpers/pdf-read';
import { testJpeg, traceFixture } from './helpers/run-report-fixture';

/** The definition as data: pictures by size, functions by name, the footer of page 2 of 5. */
function normalized(def: ReportDefinition): unknown {
  const footer = typeof def.footer === 'function' ? def.footer(2, 5, { width: 595.28, height: 841.89, orientation: 'portrait' }) : def.footer;
  return JSON.parse(
    JSON.stringify({ ...def, footer }, (key, value: unknown) => {
      if (typeof value === 'function') return `[function ${key}]`;
      if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer') return `<${(value as { data: number[] }).data.length} bytes>`;
      return value;
    }),
  );
}

const allText = (pages: string[]) => pages.join('\n').replace(/\s+/g, ' ');

describe('buildReportDefinition', () => {
  it('matches the snapshot for a seeded run: 60 steps, 2 questions, 1 confirmed action, 6 images', () => {
    const trace = traceFixture();
    const def = buildReportDefinition(trace);
    expect(Object.keys(def.images)).toHaveLength(6);
    expect(normalized(def)).toMatchSnapshot();
  });

  it('is pure: the same trace gives the same definition, and the trace is not changed', () => {
    const trace = traceFixture();
    const before = JSON.stringify(trace);
    expect(normalized(buildReportDefinition(trace))).toEqual(normalized(buildReportDefinition(trace)));
    expect(JSON.stringify(trace)).toBe(before);
  });

  it('folds consecutive observations into one row, as the run page does', () => {
    const rows = timelineRows(traceFixture().steps);
    const observed = rows.filter((r) => r.kind === 'observed');
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((r) => r.kind === 'observed' && r.steps.length >= 2)).toBe(true);
  });

  it('names every answer in words, a withheld value as "Provided (not recorded)"', () => {
    const q = { id: 'q', kind: 'question', input: 'text', prompt: 'p', options: null, risk: null, status: 'answered' };
    const answer = (a: Record<string, unknown>) => ({ outcome: 'completed', valueWithheld: false, channel: 'web', answeredAt: null, ...a });
    expect(answerLabel({ ...q, kind: 'confirmation', input: 'confirm', answer: answer({ value: 'approve' }) })).toBe('Allowed');
    expect(answerLabel({ ...q, kind: 'confirmation', input: 'confirm', answer: answer({ value: 'deny' }) })).toBe('Declined');
    expect(answerLabel({ ...q, answer: answer({ outcome: 'cancelled' }) })).toBe('Declined');
    expect(answerLabel({ ...q, input: 'secret', answer: answer({ valueWithheld: true }) })).toBe('Provided (not recorded)');
    expect(answerLabel({ ...q, answer: answer({ value: 'Window seat' }) })).toBe('Provided: Window seat');
    expect(answerLabel({ ...q, input: 'choice', options: [{ id: 'a', label: 'Fare Alpha' }], answer: answer({ value: 'a' }) })).toBe('Chose: Fare Alpha');
    expect(answerLabel({ ...q, status: 'expired', answer: null })).toBe('Expired: not answered');
  });
});

describe('images', () => {
  it('reads the size of a JPEG and a PNG, and nothing else', () => {
    expect(imageSize(testJpeg(64, 40))).toEqual({ type: 'jpeg', width: 64, height: 40 });
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000280000001e0', 'hex');
    expect(imageSize(Buffer.concat([png, Buffer.alloc(8)]))).toEqual({ type: 'png', width: 640, height: 480 });
    expect(imageSize(Buffer.from('not an image'))).toBeNull();
  });

  it(`re-encodes a picture wider than ${REPORT_IMAGE_MAX_PX} px, and keeps a narrower one as stored`, () => {
    const wide = testJpeg(2400, 1200);
    const out = reportImage(wide.toString('base64'))!;
    expect([out.width, out.height]).toEqual([1600, 800]);
    expect(imageSize(out.bytes)).toEqual({ type: 'jpeg', width: 1600, height: 800 });
    const narrow = testJpeg(800, 500);
    expect(reportImage(narrow.toString('base64'))!.bytes.equals(narrow)).toBe(true);
  });

  it('a picture that cannot be read is named in its caption, not embedded', async () => {
    const trace = traceFixture({ images: 1 });
    const shot = trace.steps.find((s) => s.screenshot)!;
    shot.screenshot!.data = Buffer.from('not a jpeg').toString('base64');
    const def = buildReportDefinition(trace);
    expect(Object.keys(def.images)).toHaveLength(0);
    const pdf = await renderPdfBuffer(def);
    expect(allText(readPdf(pdf).text)).toContain('the picture could not be read');
  });
});

describe('the rendered PDF', () => {
  let pdf: Buffer;
  let read: ReturnType<typeof readPdf>;
  const trace = traceFixture({ imageSize: [1280, 800] });
  beforeAll(async () => {
    pdf = await renderPdfBuffer(buildReportDefinition(trace));
    read = readPdf(pdf);
  });

  it('opens, has a sensible page count, A4 pages and the metadata (no email)', () => {
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(read.pages).toBeGreaterThanOrEqual(4);
    expect(read.pages).toBeLessThanOrEqual(9);
    expect(read.sizes.every(([w, h]) => w === 595.28 && h === 841.89)).toBe(true);
    expect(read.info).toMatchObject({ Title: `Run report: ${trace.run.goal}`, Author: 'Hexactra' });
    expect(JSON.stringify(read.info)).not.toMatch(/@/);
  });

  it('holds the goal, each question, each answer label and the footer note on every page', () => {
    const text = allText(read.text);
    expect(text).toContain(trace.run.goal.replace(/\s+/g, ' ').slice(0, 40));
    expect(text).toContain('Book fare Alpha for $120.00?');
    expect(text).toContain('Enter the code sent to your phone');
    expect(text).toContain('Allowed');
    expect(text).toContain('Provided (not recorded)');
    read.text.forEach((page, i) => {
      expect(page).toContain(REPORT_FOOTER_NOTE);
      expect(page.replace(/\s+/g, ' ')).toContain(`Page ${i + 1} of ${read.pages}`);
    });
  });

  it('has an outline of its sections, and selectable text', () => {
    expect(read.outline).toEqual(['Run report', 'Outcome', 'Questions and answers', 'Budget', 'Timeline']);
  });

  it('embeds the six pictures with their captions', () => {
    expect(imageObjects(pdf)).toBe(6);
    expect(allText(read.text)).toContain('Step 12 · the screen when the agent asked for confirmation · 2 areas masked');
  });

  it('marks the failed step, the confirmed step box, a collapsed observation run and the guidance', () => {
    const text = allText(read.text);
    expect(text).toContain('Failed: The payment page did not load');
    expect(text).toContain('You confirmed 1 step that the run carried out');
    expect(text).toMatch(/\d+–\d+\. \d\d:\d\d:\d\d Observed the page \(\d+ steps\)/);
    expect(text).toContain('Your guidance');
  });

  it('screenshots=none leaves every image out', async () => {
    const none = await renderPdfBuffer(buildReportDefinition(trace, { screenshots: 'none' }));
    expect(imageObjects(none)).toBe(0);
    expect(none.length).toBeLessThan(pdf.length);
  });

  it('paper=letter changes the page size', async () => {
    const letter = readPdf(await renderPdfBuffer(buildReportDefinition(trace, { paper: 'letter', screenshots: 'none' })));
    expect(letter.sizes.every(([w, h]) => w === 612 && h === 792)).toBe(true);
  });
});

describe('what happened (#1047)', () => {
  const finding = { code: 'loop' as const, severity: 'warn' as const, title: 'The run went round in a loop', detail: 'Steps 3 to 9 repeated the same two actions.', seqFrom: 3, seqTo: 9, stepsSpent: 6, evidence: {} };

  it('lists the findings after the outcome, warnings named as such, with their steps', async () => {
    const trace = { ...traceFixture({ images: 0 }), formatVersion: 2 as const, findings: [finding, { ...finding, code: 'slow_start' as const, severity: 'info' as const, title: 'A slow start', detail: 'The first action came after 2 minutes.', seqFrom: 1, seqTo: 1 }] };
    const text = allText(readPdf(await renderPdfBuffer(buildReportDefinition(trace))).text);
    expect(text).toContain('What happened');
    expect(text).toContain('Warning: The run went round in a loop (steps 3 to 9).');
    expect(text).toContain('Note: A slow start (step 1).');
    expect(text.indexOf('What happened')).toBeGreaterThan(text.indexOf('Outcome'));
  });

  it('says so when the steps point to nothing, and has no section for a version 1 file or a live run', async () => {
    const none = allText(readPdf(await renderPdfBuffer(buildReportDefinition({ ...traceFixture({ images: 0 }), formatVersion: 2, findings: [] }))).text);
    expect(none).toContain('Nothing in the steps points to wasted effort.');
    const v1 = allText(readPdf(await renderPdfBuffer(buildReportDefinition(traceFixture({ images: 0 })))).text);
    expect(v1).not.toContain('What happened');
    const live = allText(readPdf(await renderPdfBuffer(buildReportDefinition({ ...traceFixture({ partial: true, status: 'running', images: 0 }), formatVersion: 2, findings: [finding] }))).text);
    expect(live).not.toContain('What happened');
  });
});

describe('outcomes and banners', () => {
  it('a soft (chat run) budget prints "not enforced"', async () => {
    const text = allText(readPdf(await renderPdfBuffer(buildReportDefinition(traceFixture({ soft: true, images: 0 })))).text);
    expect(text).toContain('Limits not enforced (chat run)');
    expect(text).toContain('Started from Chat');
  });

  it('a live run prints the partial banner and "In progress"', async () => {
    const text = allText(readPdf(await renderPdfBuffer(buildReportDefinition(traceFixture({ partial: true, status: 'running', images: 0 })))).text);
    expect(text).toContain(REPORT_PARTIAL_BANNER);
    expect(text).toContain('In progress');
    expect(text).toContain('Still running');
  });

  it('a failed run that carried out a confirmed step says so in its chip', async () => {
    const trace = traceFixture({ status: 'failed', images: 0 });
    trace.run.result = null;
    trace.run.error = 'The site logged the session out';
    const text = allText(readPdf(await renderPdfBuffer(buildReportDefinition(trace))).text);
    expect(text).toContain('Ended after a confirmed step');
    expect(text).toContain('Reason: The site logged the session out');
  });
});

describe('a large run', () => {
  it('renders 500 steps with 40 pictures in bounded time and memory', async () => {
    const trace = traceFixture({ steps: 500, images: 40, imageSize: [1280, 800] });
    // Layout is synchronous, so the peak resident set (maxRSS, in KB) is the measure, not a timer.
    const before = process.memoryUsage().rss;
    const started = Date.now();
    const pdf = await renderPdfBuffer(buildReportDefinition(trace));
    const ms = Date.now() - started;
    const peak = Math.max(process.resourceUsage().maxRSS * 1024, process.memoryUsage().rss);
    const grewMb = (peak - before) / (1024 * 1024);
    // The bound is 10 s and 300 MB on the reference stack; CI machines are slower and noisier.
    process.stdout.write(`large run report: ${ms} ms, ${Math.round(grewMb)} MB more resident memory, ${(pdf.length / 1024 / 1024).toFixed(1)} MB file\n`);
    expect(imageObjects(pdf)).toBe(40);
    expect(ms).toBeLessThan(20_000);
    expect(grewMb).toBeLessThan(300);
  }, 60_000);
});
