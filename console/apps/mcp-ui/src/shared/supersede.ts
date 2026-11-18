// Only the newest card of a subject keeps polling (claude.com/docs, "Supersede
// older widget instances"): each card announces the server-minted key of the
// result that opened it (`card_key`: server time, then a counter) on a
// BroadcastChannel named after the run; a card that hears a younger one
// stops and says "Newer update below". The key comes from the server, never
// the client's clock, so a conversation reopened later elects the same card.
/** A supersession key minted by the server (`card_key`: server time, then a counter). */
export interface CardKey {
  created_at: number;
  seq: number;
}

interface Peer {
  instanceId: string;
  key: CardKey;
}

interface Message extends Peer {
  type: 'hello' | 'born';
}

export interface ChannelLike {
  postMessage(m: unknown): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type ChannelFactory = (name: string) => ChannelLike | null;

const defaultFactory: ChannelFactory = (name) => {
  try {
    return typeof BroadcastChannel === 'function' ? (new BroadcastChannel(name) as unknown as ChannelLike) : null;
  } catch {
    return null;
  }
};

/** Whether `other` is younger than `mine`: server time, then the counter, then the instance id (deterministic). */
export function isYounger(other: Peer, mine: Peer): boolean {
  if (other.key.created_at !== mine.key.created_at) return other.key.created_at > mine.key.created_at;
  if (other.key.seq !== mine.key.seq) return other.key.seq > mine.key.seq;
  return other.instanceId > mine.instanceId;
}

export class Supersession {
  private channel: ChannelLike | null = null;
  private readonly peers = new Map<string, Peer>();
  private me: Peer | null = null;

  constructor(
    private readonly onChange: (superseded: boolean) => void,
    private readonly factory: ChannelFactory = defaultFactory,
    /** The channel name before `:<subject>`, one per kind of card (the run card: `hexactra-run-card:<run id>`). */
    private readonly prefix = 'hexactra-run-card',
  ) {}

  /** Join the election of `subject` (a run id) with this card's key (again after "Run again" moves the card to another run). */
  join(subject: string, instanceId: string, key: CardKey): void {
    this.leave();
    this.me = { instanceId, key };
    this.channel = this.factory(`${this.prefix}:${subject}`);
    if (!this.channel) return;
    this.channel.onmessage = (ev) => this.receive(ev.data);
    this.post('hello');
    this.post('born');
  }

  leave(): void {
    this.channel?.close();
    this.channel = null;
    this.peers.clear();
    this.onChange(false);
  }

  private post(type: Message['type']): void {
    if (this.me) this.channel?.postMessage({ type, ...this.me } satisfies Message);
  }

  private receive(data: unknown): void {
    const m = data as Partial<Message> | null;
    if (!this.me || !m || typeof m.instanceId !== 'string' || m.instanceId === this.me.instanceId) return;
    if (!m.key || typeof m.key.created_at !== 'number' || typeof m.key.seq !== 'number') return;
    if (m.type === 'hello') this.post('born');
    this.peers.set(m.instanceId, { instanceId: m.instanceId, key: { created_at: m.key.created_at, seq: m.key.seq } });
    const me = this.me;
    this.onChange([...this.peers.values()].some((p) => isYounger(p, me)));
  }
}
