// Tool families (E41.2, #699): what the model reads about each kind of tool it has, and the one rule for choosing between them. A family is a
// descriptor: generic, knowing nothing of browsers or connections. A toolset registers its families with the registry; the instructions list
// the families that have at least one tool offered, in rank order, so a run reads only about what it can use. Deterministic: the same
// families give the same bytes in every round, so the provider's prompt cache holds.
import type { AnyContext } from './run-context';

export interface ToolFamily<C extends AnyContext = AnyContext> {
  /** Stable id: 'browser', 'desktop', 'accounts', 'mcp:<connectionId>', later others. A tool names it in `RunnerTool.family`. */
  id: string;
  /** What the model reads as the family's name: "The browser", "The owner's accounts", an MCP server's label. */
  title: string;
  /** One or two sentences: what it is for and when to use it. Fixed text, or sanitised third-party text for an MCP server. */
  whenToUse: string;
  /** Order in the "Your tools" section: lower first. Structured families (accounts 10, mcp 20) before the browser (50) and the desktop (60). */
  rank: number;
  /** Longer how-to for the family (the browser's see and act sections). Emitted only when the family is offered. */
  sections?: readonly string[];
  /** The how-to for this run, when it depends on the run's policy (E54.1). Pure: identical in every round of a run. Replaces `sections`. */
  sectionsFor?(ctx: C): readonly string[];
  /** A per-run line for the round input ("c1 \"Work\" (Google, read and change: read mail, ...)"). Null: nothing to add. */
  toolbox?(ctx: C): string | null;
}

/** The rule for choosing between families, after the "Your tools" list. Fixed text: asserted on the model input. */
export const ROUTING_RULE = `How to choose a tool:
- First ask what the goal needs: something from the owner's accounts or added tools (mail, calendar, files, a service they connected), something on a website, or both.
- When one of the owner's accounts or added tools can do the job, or a part of it, use it. Do not open a website to do what a tool does: it is slower and can fail.
- Use the browser when the job is on a website, when no tool covers it, or when a tool failed and a page can finish it.
- Mix them when the goal needs both: get from each what it does best, and carry results across (facts as text, pictures and reports as attachments).
- Do not look up again what the goal or the earlier context already states.
- When two accounts or tools could do it and the owner did not say which, ask.`;

/** The first round's hint after "Nothing has been done yet.": family-neutral. */
export const FIRST_ROUND_HINT = 'Choose the tool that fits the goal.';
/** The hint of a host that gives none: what every run read before tool families. */
export const DEFAULT_FIRST_ROUND_HINT = 'Start by navigating or observing the page.';

/** The "Your tools" block: one line per family, in the order given. */
export function familiesBlock(families: readonly Pick<ToolFamily, 'title' | 'whenToUse'>[]): string {
  return `Your tools:\n${families.map((f) => `- ${f.title}: ${f.whenToUse}`).join('\n')}`;
}
