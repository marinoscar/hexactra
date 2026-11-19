// The context the browser tools are written against (E38.5): the harness context, a memory with the browser's fields, and the browser
// toolset's own state and hooks. The host builds it; the tools reach the page, the site list and the gates only through it.
import type { GateTarget, HarnessMemory, RunContext } from '../harness';
import type { BrowserPort } from './browser-port';
import type { ScreenshotWindow } from './context-settings';
import type { TargetFacts } from './policy';
import type { Screen, ScreenMark, ScreenView } from './vision';

/** What the browser toolset keeps in `runs.transcript`, beside the harness's fields. Never secrets. */
export interface BrowserMemory extends HarnessMemory {
  /** A secret handoff whose value `type_handoff_secret` may type (once). */
  secretHandoffId?: string | null;
  /** The sensitive task parameter (#552) whose secret request is open, by key. */
  askingParam?: string | null;
  /** The secret handoff holding each sensitive task parameter's value (#552), by key. */
  paramSecrets?: Record<string, string>;
  /** The screen the next round shows the model (default: the page). */
  look?: Screen | null;
  /** Digests of the screenshots last shown to the model (never the images, #406). */
  shots?: string[];
}

/** What the browser tools learned about the page, for the length of one job. */
export interface BrowserState {
  /** What observe_elements last said about each selector: the gate's fallback facts when the page cannot be asked (#550). */
  labels: Map<string, TargetFacts>;
  /** The numbered marks of the last page screenshot. */
  marks: Map<number, ScreenMark>;
  /** The last screen the model was shown. */
  view: ScreenView | null;
}

/** The sites the run may open: the task's list and the AI app's list. A URL must pass both. */
export interface SiteList {
  allowed(url: string): boolean;
  /** How the model reads the list: "shop.example.test; the app's: …". Empty when any site is allowed. */
  text: string;
}

/**
 * Inputs filled from a provider (an identity detail, a saved login's password) are never read back (E37.6): the harness has no idea
 * which they are, so the host tells the toolset. `NO_MASKING` is the answer of a run that fills nothing.
 */
export interface ReadMasking {
  /** The selectors filled from a provider on the page now on screen; [] without a call when nothing was filled. */
  filledNow(): Promise<string[]>;
  /** What a read of `selector` returns when it is a filled input or holds one: the marker, else null. */
  maskedText(selector: string, filled: string[]): Promise<string | null>;
  maskElements(elements: Array<Record<string, unknown>>, filled: string[]): Promise<Array<Record<string, unknown>>>;
  /** Whether a script's result could read a filled input's value: the value is then hidden. */
  hidesScript(script: string): boolean;
  /** What stands in for a value the model must not read. */
  marker: string;
  /** Runs `fn` (a screenshot) with every filled input covered; nothing is captured if the cover cannot be drawn. */
  covered<T>(fn: (covered: string[]) => Promise<T>): Promise<T>;
  /** Whether something filled or typed into a frame is on the page: a desktop picture could not cover it. */
  anyCoverable(): Promise<boolean>;
  /** The view with the marks of the covered inputs masked. */
  maskView(view: ScreenView, covered: string[]): Promise<ScreenView>;
}

export const NO_MASKING: ReadMasking = {
  filledNow: async () => [],
  maskedText: async () => null,
  maskElements: async (els) => els,
  hidesScript: () => false,
  marker: '[filled from your saved details]',
  covered: (fn) => fn([]),
  anyCoverable: async () => false,
  maskView: async (view) => view,
};

/** What the host adds around a click and around risk: a saved card's approval, and reasons to confirm beyond the task's own. */
export interface BrowserHooks {
  /** An approval besides the owner's confirmation covers this target (a saved card's approval for its pay button). */
  covers?(target: GateTarget): boolean;
  /** Before a click such an approval covers: its intent is saved first. True: `payEnd` follows. */
  payBegin?(target: GateTarget | null): Promise<boolean>;
  /** After that click: whether it was carried out. */
  payEnd?(carriedOut: boolean): Promise<void>;
  /** A saved approval of the owner must not apply to this target (a payment that may have happened, an unknown attempt, an app that asks first). */
  savedApprovalBlocked?(target: GateTarget): boolean;
  /** The owner's own secret was typed with `type_handoff_secret` (not a task parameter): remember which sign-in, so it can be offered for saving. */
  secretTyped?(info: { handoffId: string }): Promise<void>;
}

export interface BrowserExt {
  browser: BrowserPort;
  sites: SiteList;
  state: BrowserState;
  shotWindow: ScreenshotWindow;
  /** Most characters of one page observation sent to the model (#406). */
  observationChars: number;
  /** Whether the task asks for confirmation before commitments, now. Read each time: it can turn on mid-run (an unattended sign-in, a typed card). */
  confirmRisky(): boolean;
  /** Sensitive task parameters (#552) `type_handoff_secret` may type by name. */
  sensitiveParams(): { key: string; label: string }[];
  masking: ReadMasking;
  hooks: BrowserHooks;
}

export type BrowserContext = RunContext<BrowserMemory, BrowserExt>;
