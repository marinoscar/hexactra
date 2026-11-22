// A minimal WebM muxer for run recordings (epic #755): one VP8 video track, with the duration, a seek head and cues, so a browser can
// seek the video. The frames come from the extension already encoded (recording-format.ts); this only puts them in a container.
//
// Layout: EBML header, then one Segment of known size holding SeekHead, Info, Tracks, the Clusters and Cues. A cluster starts at every
// key frame (the extension writes one at least every 2 s) and whenever a block's time would not fit its 16-bit offset.

import type { RecordedStream } from './recording-format';

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

const CODEC_IDS: Record<string, string> = { vp8: 'V_VP8', vp9: 'V_VP9' };
const MAX_BLOCK_OFFSET = 32_767;

function idBytes(id: number): Buffer {
  const len = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const b = Buffer.alloc(len);
  b.writeUIntBE(id, 0, len);
  return b;
}

/** An EBML size: the shortest variable-length integer that holds `n`. */
export function sizeBytes(n: number): Buffer {
  for (let len = 1; len <= 8; len++) {
    const max = 2 ** (7 * len) - 2; // all ones is reserved for "unknown"
    if (n <= max) {
      const b = Buffer.alloc(len);
      let v = BigInt(n) | (1n << BigInt(7 * len));
      for (let i = len - 1; i >= 0; i--) {
        b[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return b;
    }
  }
  throw new Error('element too large');
}

function el(id: number, ...body: Buffer[]): Buffer {
  const data = Buffer.concat(body);
  return Buffer.concat([idBytes(id), sizeBytes(data.length), data]);
}

function uintBytes(v: number, fixed?: number): Buffer {
  let len = fixed ?? 1;
  if (!fixed) while (len < 8 && v >= 2 ** (8 * len)) len++;
  const b = Buffer.alloc(len);
  let x = BigInt(Math.floor(v));
  for (let i = len - 1; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

const uint = (id: number, v: number, fixed?: number) => el(id, uintBytes(v, fixed));
const str = (id: number, s: string) => el(id, Buffer.from(s, 'utf8'));
function float(id: number, v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v, 0);
  return el(id, b);
}

function simpleBlock(rel: number, key: boolean, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0x81; // track 1
  head.writeInt16BE(rel, 1);
  head[3] = key ? 0x80 : 0x00;
  return el(ID.SimpleBlock, head, data);
}

/** The duration of a stream, in milliseconds: the last frame's time, plus one frame (100 ms) so the last picture shows. */
export function streamDurationMs(stream: RecordedStream): number {
  const last = stream.frames.at(-1);
  return last ? last.ts + 100 : 0;
}

/** Mux a recorded stream into one WebM file. */
export function muxWebm(stream: RecordedStream): Buffer {
  const codecId = CODEC_IDS[stream.codec.toLowerCase()];
  if (!codecId) throw new Error(`unsupported codec ${stream.codec}`);
  if (stream.frames.length === 0) throw new Error('the recording has no frames');

  const ebml = el(
    ID.EBML,
    uint(ID.EBMLVersion, 1),
    uint(ID.EBMLReadVersion, 1),
    uint(ID.EBMLMaxIDLength, 4),
    uint(ID.EBMLMaxSizeLength, 8),
    str(ID.DocType, 'webm'),
    uint(ID.DocTypeVersion, 2),
    uint(ID.DocTypeReadVersion, 2),
  );
  const info = el(ID.Info, uint(ID.TimecodeScale, 1_000_000), float(ID.Duration, streamDurationMs(stream)), str(ID.MuxingApp, 'hexactra'), str(ID.WritingApp, 'hexactra'));
  const tracks = el(
    ID.Tracks,
    el(
      ID.TrackEntry,
      uint(ID.TrackNumber, 1),
      uint(ID.TrackUID, 1),
      uint(ID.TrackType, 1),
      uint(ID.FlagLacing, 0),
      str(ID.CodecID, codecId),
      el(ID.Video, uint(ID.PixelWidth, stream.width), uint(ID.PixelHeight, stream.height)),
    ),
  );

  // Clusters: a new one at each key frame, or when the offset would overflow.
  const clusters: { time: number; bytes: Buffer }[] = [];
  let start = -1;
  let blocks: Buffer[] = [];
  const close = () => {
    if (start >= 0 && blocks.length) clusters.push({ time: start, bytes: el(ID.Cluster, uint(ID.Timecode, start), ...blocks) });
    blocks = [];
  };
  for (const f of stream.frames) {
    if (start < 0 || f.key || f.ts - start > MAX_BLOCK_OFFSET) {
      close();
      start = f.ts;
    }
    blocks.push(simpleBlock(f.ts - start, f.key, f.data));
  }
  close();

  // Positions are relative to the start of the Segment's data. The seek head's positions are fixed-width, so its size is known first.
  const seekEntry = (id: number, pos: number) => el(ID.Seek, el(ID.SeekID, idBytes(id)), uint(ID.SeekPosition, pos, 8));
  const seekHeadSize = el(ID.SeekHead, seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), seekEntry(ID.Cues, 0)).length;
  const infoPos = seekHeadSize;
  const tracksPos = infoPos + info.length;
  let pos = tracksPos + tracks.length;
  const cuePoints: Buffer[] = [];
  for (const c of clusters) {
    cuePoints.push(el(ID.CuePoint, uint(ID.CueTime, c.time), el(ID.CueTrackPositions, uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, pos))));
    pos += c.bytes.length;
  }
  const cuesPos = pos;
  const cues = el(ID.Cues, ...cuePoints);
  const seekHead = el(ID.SeekHead, seekEntry(ID.Info, infoPos), seekEntry(ID.Tracks, tracksPos), seekEntry(ID.Cues, cuesPos));
  const segment = el(ID.Segment, seekHead, info, tracks, ...clusters.map((c) => c.bytes), cues);
  return Buffer.concat([ebml, segment]);
}
