// What a browser run keeps between chunks and across a handoff (`runs.transcript`): the harness's fields, the browser toolset's, and the
// app's (saved logins, identity details, cards, memory proposals). Never secrets.
import type { BrowserMemory } from '../browser/context';
import type { Screen } from '../browser/vision';
import type { BudgetKey, StallState, Tier, UnknownStep } from '../harness';
import type { GateTarget } from '../browser/policy';
import type { SavedCardsMemory } from '../saved-cards';
import type { SavedIdentityMemory } from '../saved-identity';
import type { SavedLoginsMemory } from '../saved-logins';

/** What the run keeps between chunks and across a handoff (`runs.transcript`). Never secrets. */
export interface RunMemory extends BrowserMemory {
  /** Memories the runner proposed so far (#553), for the per-run cap. */
  proposals?: number;
  log: string[];
  /** A secret handoff whose value `type_handoff_secret` may type (once). */
  secretHandoffId?: string | null;
  /** The sensitive task parameter (#552) whose secret request is open, by key. */
  askingParam?: string | null;
  /** The secret handoff holding each sensitive task parameter's value (#552), by key; typed with `type_handoff_secret(parameter)`. */
  paramSecrets?: Record<string, string>;
  /** Before #550: a person approved one risky action. Read once from an older transcript as an approval of the next risky click. */
  confirmationGranted?: boolean;
  /**
   * The commitment a person approved (#550): the gate lets through the click on this target, not any later
   * risky click. Set only from a question that carries the gate's target; a null category is only ever an
   * approval read from a transcript written before #550 (it covers the next risky click, once, as it did then).
   * Cleared when the approved click is carried out.
   */
  confirmedTarget?: GateTarget | null;
  /** The commitment the gate last stopped (#550): the next confirmation the model asks for carries it as the question's `gate`. */
  gatePending?: GateTarget | null;
  /**
   * The approved confirmation (#540), until the action it allowed is carried out: the next
   * successful action is recorded in `runs.confirmed_actions`. `tries` counts failed actions;
   * five, or a new handoff, clear it.
   */
  pendingConfirmation?: { prompt: string; tries: number } | null;
  /** The prompt of the last request the run made (the question a confirmation approves). */
  askedPrompt?: string;
  /** Trace screenshots stored so far (#541), for the cap. */
  traceShots?: number;
  chunks: number;
  /** The provider refused images: the run continues without screenshots (#366). */
  visionOff?: boolean;
  /** The screen the next round shows the model (default: the page). */
  look?: Screen | null;
  /** Digests of the screenshots last shown to the model (never the images, #406). */
  shots?: string[];
  /** Budgets already warned about (#404): each is warned once per run, across jobs. */
  warned?: BudgetKey[];
  /** Warning lines the next round's input carries (#404). */
  pendingWarnings?: string[];
  /** Soft budgets (#537) already noticed as over their limit: each is noted and notified once per run, across jobs. */
  overNoticed?: BudgetKey[];
  /** The tier the run is on (#405); absent until the first advance. */
  tier?: Tier;
  /** Tier escalations so far (#405). */
  escalations?: number;
  /** The stall detector's state (#405): digests and normalised selectors only, never typed text or secrets. */
  stall?: StallState;
  /** Stalls since the run last escalated (or started): the first is nudged. */
  stallsHere?: number;
  /** Times a stall asked a person. */
  stallHandoffs?: number;
  /** Successful, progressing actions in a row (for de-escalation). */
  progressStreak?: number;
  /** The nudge the next round's input carries. */
  pendingNudge?: string;
  /** What an earlier job of the same chat did (#490): the follow-up's context, shown after the goal. Never a secret. */
  context?: string;
  /** Why the run is on a stronger tier, while it is (the activity shows it). */
  tierNote?: string | null;
  /** Saved logins (E37.3): the references handed out, the page last looked up, the sign-in attempt in progress. Never a value. */
  savedLogins?: SavedLoginsMemory;
  /** Saved identity details (E37.6): the references handed out, the page last looked up, the inputs filled from a provider. Never a value. */
  savedIdentity?: SavedIdentityMemory;
  /** Saved cards (E37.7): the references handed out, the page last looked up, the declared charge, the owner's approval and the phases of a payment. Never a card value. */
  savedCards?: SavedCardsMemory;
  /** "Save this login?" (E37.4b): the sign-in cards the fabric keeps a password for, and the sign-in the agent typed from one. Ids and an origin; never the password. */
  saveLogin?: SaveLoginMemory;
  /** `visionOff` was set because the tier's model has no vision (not because a call refused images). */
  visionOffByTier?: boolean;
  /** The highest step `seq` this memory already tells the model about (E38.3): a job that finds later rows reconciles them. */
  lastSeq?: number;
  /** Actions that may or may not have happened (E38.3): their target is asked again, and no saved approval covers it. Never a value. */
  unknownSteps?: UnknownStep[];
}

/** What a run remembers about offering to save a sign-in the owner typed by hand (E37.4b). */
export interface SaveLoginMemory {
  /** The `credentials` handoffs opened with `offer_save`: the fabric keeps their password for the provider (the newest five). */
  offerable?: string[];
  /** The sign-in the agent typed from one of them: its handoff and the page's origin as the fabric reported it when the password was typed. */
  signIn?: { handoffId: string; origin: string; offered: boolean } | null;
}

export type { RunOutcome } from '../harness';
