// E45.4 (#759): the recording stream reader and the WebM muxer. The structure is checked here; when ffmpeg is on the machine, a real VP8
// clip is encoded, run through the reader and the muxer, and ffprobe must read the result as a seekable WebM of the right length.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RecordingFormatError, SEGMENT_GAP_MS, readRecording, writeRecording } from '../src/recordings/recording-format';
import { muxWebm, sizeBytes, streamDurationMs } from '../src/recordings/webm';

const frame = (key: boolean, ts: number, n = 4) => ({ key, ts, data: Buffer.alloc(n, ts % 251) });

describe('the recording stream (#759)', () => {
  it('reads what the extension writes, across part boundaries', () => {
    const bytes = writeRecording(1280, 720, 'vp8', [frame(true, 0), frame(false, 100), frame(true, 2000)]);
    const s = readRecording(Buffer.concat([bytes.subarray(0, 7), bytes.subarray(7)]));
    expect(s).toMatchObject({ width: 1280, height: 720, codec: 'vp8', segments: 1 });
    expect(s.frames.map((f) => [f.key, f.ts])).toEqual([[true, 0], [false, 100], [true, 2000]]);
  });

  it('continues the timeline after a restart, and drops a cut last record', () => {
    const a = writeRecording(1280, 720, 'vp8', [frame(true, 0), frame(false, 500)]);
    const b = writeRecording(1280, 720, 'vp8', [frame(true, 0), frame(false, 300)]);
    const s = readRecording(Buffer.concat([a, b.subarray(0, b.length - 2)]));
    expect(s.segments).toBe(2);
    expect(s.frames.map((f) => f.ts)).toEqual([0, 500, 500 + SEGMENT_GAP_MS]);
  });

  it('refuses bytes that are not a recording', () => {
    expect(() => readRecording(Buffer.from([1, 0, 0, 0]))).toThrow(RecordingFormatError);
    expect(() => readRecording(Buffer.alloc(0))).toThrow(RecordingFormatError);
  });
});

describe('the WebM muxer (#759)', () => {
  it('writes EBML sizes in the shortest form', () => {
    expect(sizeBytes(0)).toEqual(Buffer.from([0x80]));
    expect(sizeBytes(126)).toEqual(Buffer.from([0xfe]));
    expect(sizeBytes(127)).toEqual(Buffer.from([0x40, 0x7f]));
  });

  it('writes a WebM with the EBML header, the codec, the duration and one cue per cluster', () => {
    const stream = readRecording(writeRecording(640, 360, 'vp8', [frame(true, 0), frame(false, 100), frame(true, 2000), frame(false, 40_000)]));
    const webm = muxWebm(stream);
    expect(webm.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(webm.includes(Buffer.from('webm'))).toBe(true);
    expect(webm.includes(Buffer.from('V_VP8'))).toBe(true);
    // Clusters at 0, 2000, and a new one at 40000 (past the 16-bit block offset).
    const clusterId = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
    let clusters = 0;
    for (let at = webm.indexOf(clusterId); at >= 0; at = webm.indexOf(clusterId, at + 1)) clusters++;
    expect(clusters).toBe(3);
    expect(streamDurationMs(stream)).toBe(40_100);
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
  (hasFfmpeg ? it : it.skip)('makes a real VP8 clip that ffprobe reads as a seekable WebM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hxr-'));
    const ivf = join(dir, 'clip.ivf');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '4', '-c:v', 'libvpx', '-g', '20', '-f', 'ivf', ivf]);
    // IVF: a 32-byte header, then 12-byte frame headers (size, pts) and the frames.
    const raw = readFileSync(ivf);
    const frames: { key: boolean; ts: number; data: Buffer }[] = [];
    for (let at = 32; at + 12 <= raw.length; ) {
      const size = raw.readUInt32LE(at);
      const pts = Number(raw.readBigUInt64LE(at + 4));
      const data = raw.subarray(at + 12, at + 12 + size);
      frames.push({ key: (data[0]! & 1) === 0, ts: pts * 100, data });
      at += 12 + size;
    }
    expect(frames.length).toBeGreaterThan(30);
    const stream = readRecording(writeRecording(320, 240, 'vp8', frames));
    const out = join(dir, 'recording.webm');
    writeFileSync(out, muxWebm(stream));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', out]).toString()) as {
      format: { format_name: string; duration: string };
      streams: { codec_name: string; width: number; height: number }[];
    };
    expect(probe.format.format_name).toContain('webm');
    expect(probe.streams[0]).toMatchObject({ codec_name: 'vp8', width: 320, height: 240 });
    expect(Number(probe.format.duration)).toBeCloseTo(4, 0);
    // Seekable: a frame at 3 s decodes without reading from the start.
    const seek = spawnSync('ffmpeg', ['-loglevel', 'error', '-ss', '3', '-i', out, '-frames:v', '1', '-f', 'null', '-']);
    expect(seek.status).toBe(0);
    // Every frame decodes.
    const count = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out]).toString().trim();
    expect(Number(count)).toBe(frames.length);
  });
});
