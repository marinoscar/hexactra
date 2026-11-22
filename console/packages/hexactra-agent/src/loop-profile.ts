// What a toolset gives the loop (E38.5): the instructions, the tools and gates, and how a round is shown to the model. The loop itself
// knows nothing about browsers: a toolset with no screens returns no images and the loop behaves the same.
import type { GatePipeline } from './gate-pipeline';
import type { AnyContext } from './run-context';
import type { ToolRegistry } from './registry';
import type { RunOutcome } from './types';
import type { PageState } from './stall';
import type { VisionNotes } from './tiers';

/** What the model sees at the start of a round besides the text: the screens, and a digest of the page for the stall detector. */
export interface Observation {
  /** The images to send, oldest first; empty when the round has none. Opaque to the loop. */
  images: unknown[];
  /** The page as the stall detector sees it: a digest of what is on it, never the image (#405). */
  page: PageState | null;
  /** The address of what the model is looking at, for the owner's ask rules on this site. */
  url: string | null;
}

export const NO_OBSERVATION: Observation = { images: [], page: null, url: null };

export interface LoopProfile<C extends AnyContext = AnyContext> {
  /** The system instructions, identical in every round of a run (the provider caches them). */
  instructions: string;
  /**
   * Called at each chunk boundary, after Stop, Pause, the budgets and the hop are checked (E46.18): a host may finish the run's remaining work
   * another way (the Knowledge Graph resumes a saved procedure's next segment). An outcome ends the loop; null goes on. Absent: nothing changes.
   */
  betweenChunks?(ctx: C): Promise<RunOutcome | null>;
  registry: ToolRegistry<C>;
  pipeline: GatePipeline<C>;
  visionNotes: VisionNotes;
  /** Before each chunk: takes the screens when the model can see them. Must not throw: a failure is a note in the log. */
  observe(ctx: C): Promise<Observation>;
  /** The round's text and status as the model input: text alone, or text with the images. */
  assembleInput(text: string, observation: Observation, status: string): unknown;
  /** Lines of the stable prefix between the earlier-conversation context and the progress log (for a browser: the allowed sites). */
  contextLines(ctx: C): string[];
  /** The words of a `guidance` step: the owner's message, masked and cut. */
  summarizeGuidance(note: string): string;
  /**
   * The model stopped talking without calling `finish`. A toolset that needs a structured result (task outputs, E39.5) returns what to ask
   * for (the nudge the next round carries, and the note recorded in the trace), counting its own attempts in the memory; null takes the
   * model's answer as the result.
   */
  beforeImplicitFinish?(ctx: C): { nudge: string; note: string } | null;
  /** A line the wrap-up call's input carries after the budget's own words (what else `finish` should give), or ''. */
  wrapUpNote?(ctx: C): string;
  /** The memory block about the owner (#553): information for the model, after the goal. '' without memories. */
  aboutOwner: string;
  /** Lines for the volatile tail of a round, after the steps used (E41.4: the pictures the agent can attach). Never in the stable prefix. */
  statusLines?(ctx: C): Promise<string[]>;
  /** What the first round says after "Nothing has been done yet." (E41.2): family-neutral. Absent: the default sentence. */
  firstRoundHint?(ctx: C): string;
}
