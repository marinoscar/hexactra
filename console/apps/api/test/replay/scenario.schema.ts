// The scenario format of the replay suite (E38.6, #587): one JSON file describes a fake website, what the owner answers, what a scripted
// model does, and what must hold at the end. The zod schema is the source; `test/scenarios/scenario.schema.json` is generated from it and
// a spec fails when they differ (`npm run scenarios:schema --workspace=api` rewrites it). Every name, site and value in a scenario is
// invented: hosts end in `.example.test`, people are `Person A`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

/** The rules every scenario is checked against, in both modes. A violation is reported as `<rule>` or `<rule>:<detail>`; the click rule names the element: `click:Pay:without_confirmation`. */
export const INVARIANT_RULES = [
  'click:without_confirmation',
  'navigate:outside_allowed_sites',
  'secret_leak',
  'repeat_commit',
  'action_after_stop',
  'action_while_paused',
  'page_text_changed',
] as const;
export type InvariantRule = (typeof INVARIANT_RULES)[number];

/** The tools a script may call: any tool of the browser toolset (`runner/browser/tools`). Unknown names fail the scenario with the name. */
const callSchema = z.strictObject({
  tool: z.string().min(1).describe('The name of a tool the model is offered (observe_elements, navigate, click, type_text, request_human, finish, ...)'),
  args: z.record(z.string(), z.unknown()).optional().describe('Its arguments. `reason`, `submit` and the other nullable fields may be left out: the kit fills them.'),
});
const chunkSchema = z.array(callSchema).describe('One model call: the tool calls it makes, in order');

const effectSchema = z.strictObject({
  when: z.record(z.string(), z.string()).optional().describe('The site state this effect needs ({"paid": "no"}); the first effect whose condition holds is applied'),
  set: z.record(z.string(), z.string()).optional().describe('State to set. A value may use {{state.key}}'),
  goto: z.string().optional().describe('The page to go to (a URL of this site, or another site)'),
});

const elementSchema = z.strictObject({
  id: z.string().min(1).describe('The id of the element in the site state; what typing into an input sets'),
  selector: z.string().min(1),
  tag: z.string().default('button'),
  role: z.string().nullable().optional().describe('The explicit role attribute, as the page reports it (null for a plain button or input)'),
  label: z.string().describe('What a person reads on it'),
  type: z.string().optional().describe('The input type (text, password, date, submit)'),
  formAction: z.string().optional().describe('Where the form this element submits posts to (the risk gate reads it)'),
  commit: z.string().optional().describe('The SITE\'s own class for an action it cannot undo (payment, send, delete): the invariants watch it, the harness does not read it'),
  secret: z.boolean().optional().describe('An input whose value a read of the page shows only as dots'),
  on: z.array(effectSchema).optional().describe('What a click does'),
});

const pageSchema = z.strictObject({
  title: z.string(),
  text: z.string().describe('The visible text. {{state.key}} is replaced by the site state; an injection scenario puts hostile text here'),
  elements: z.array(elementSchema).default([]),
});

const siteSchema = z.strictObject({
  start: z.string().describe('The URL the browser is on when the run starts'),
  state: z.record(z.string(), z.string()).default({}),
  pages: z.record(z.string(), pageSchema).describe('Pages by URL without the query'),
});

const ownerRuleSchema = z.strictObject({
  when: z.strictObject({
    kind: z.string().optional(),
    input: z.string().optional(),
    promptIncludes: z.string().optional(),
  }),
  answer: z.enum(['approve', 'deny', 'text', 'secret', 'credentials', 'choice', 'done', 'decline']),
  value: z.string().optional().describe('text, choice, a typed secret, or the username of credentials'),
  password: z.string().optional().describe('credentials: the password the fabric types (never shown to the agent)'),
  repeat: z.boolean().optional().describe('The rule answers every matching question, not only the first'),
});

const harnessSchema = z.strictObject({
  sabotage: z
    .array(z.enum(['gates_off', 'stop_ignored', 'pause_ignored']))
    .optional()
    .describe('Break a part of the harness on purpose, to prove an invariant notices. Only the violation scenarios use it.'),
  crash: z
    .strictObject({ when: z.enum(['before_send', 'after_send']), label: z.string().describe('The element whose click the job dies around') })
    .optional()
    .describe('The job dies around the click: before it is sent (nothing happened) or after (it happened, the result was lost). The run continues in a new job.'),
  scriptAfterCrash: z.array(chunkSchema).optional(),
  stopAfterActions: z.number().int().min(1).optional().describe('The owner presses Stop after this many actions reached the browser (in the middle of a chunk)'),
  pauseAfterActions: z.number().int().min(1).optional().describe('The owner presses Pause after this many actions'),
  resumeAfterPause: z.boolean().optional(),
  scriptAfterPause: z.array(chunkSchema).optional(),
  budget: z
    .partialRecord(z.enum(['maxActions', 'maxModelCalls', 'maxActiveMinutes', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd']), z.number().nullable())
    .optional()
    .describe('Limits for this run, over the policy\'s'),
  maxJobs: z.number().int().min(1).optional(),
  stall: z.partialRecord(z.enum(['maxConsecutiveFailures', 'maxRepeatedAction', 'noProgressActions', 'maxEscalations']), z.number().int()).optional(),
});

// The owner's accounts and MCP servers (E41.1, #698): the real connection tools run against doubles seeded with this data.
const CAPABILITY_IDS = ['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'] as const;
const mailSchema = z.strictObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.array(z.string()).default(['owner@example.test']),
  subject: z.string(),
  date: z.string().describe('ISO instant with offset'),
  body: z.string(),
  attachments: z.array(z.string()).default([]).describe('File names; the content is invented'),
});
const eventSchema = z.strictObject({ id: z.string().optional(), title: z.string(), start: z.string(), end: z.string(), location: z.string().optional() });
const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const fileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['document', 'spreadsheet', 'pdf', 'other']),
  text: z.string().optional().describe('A document\'s text'),
  sheet: z.string().optional().describe('A spreadsheet\'s tab (default Sheet1)'),
  rows: z.array(z.array(cellSchema)).optional().describe('A spreadsheet\'s rows'),
  modifiedAt: z.string().optional(),
});
const mcpToolSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()).describe('The tool\'s JSON schema'),
  effect: z.enum(['read', 'write']),
  result: z.string().describe('The text the server answers'),
});
const connectionSchema = z.strictObject({
  ref: z.string().regex(/^c\d+$/).describe('The reference connections_list gives it: c1, c2, ... in the order of this list'),
  label: z.string().min(1),
  provider: z.enum(['google', 'microsoft', 'mcp']),
  access: z.enum(['read', 'read_write']).default('read_write').describe('Deprecated (E50.17): ignored. The access follows the switches: read and change when a change capability (an MCP write tool) is on.'),
  email: z.string().optional(),
  capabilities: z.array(z.enum(CAPABILITY_IDS)).default([]),
  defaultFor: z.array(z.string()).default([]),
  mail: z.array(mailSchema).default([]),
  events: z.array(eventSchema).default([]),
  files: z.array(fileSchema).default([]),
  instructions: z.string().optional().describe('mcp: what the server says it is for'),
  tools: z.array(mcpToolSchema).default([]).describe('mcp: its tools'),
});

const sentSchema = z.strictObject({
  connection: z.string().describe('The connection\'s ref or label'),
  to: z.string().describe('One recipient the message went to'),
  subjectIncludes: z.string().optional(),
  bodyIncludes: z.string().optional(),
  attachments: z.number().int().min(0).optional().describe('Exactly this many attachments'),
});

/** Tool choice (E41.1, #698): which tools and families a run used, and what it sent. */
const choiceFields = {
  toolsUsed: z.array(z.string()).optional().describe('Each named tool was called at least once'),
  mustNotUseFamily: z.array(z.string()).optional().describe('No call of a tool of these families (browser, desktop, accounts, mcp, mcp:<ref>)'),
  firstToolFamily: z.string().optional().describe('The family of the first tool call that is not control or human'),
  sent: z.array(sentSchema).optional().describe('What the fake mailboxes sent'),
  browserOpened: z.boolean().optional().describe('Whether any action reached the browser'),
};
const choiceSchema = z.strictObject({ ...choiceFields, finishIncludes: z.string().optional() });

const mustAskSchema = z.strictObject({
  kind: z.string().optional(),
  promptIncludes: z.string().optional(),
  beforeLabel: z.string().optional().describe('The question is asked before the site activates the element with this label'),
});

const expectSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'cancelled', 'waiting_human', 'paused']),
  mustAsk: z.array(mustAskSchema).default([]),
  mustNot: z.array(z.string()).default([]).describe('Rules this scenario guards by name (`click:Pay:without_confirmation`, `navigate:outside_allowed_sites`, `repeat_commit`): a match fails it. Every rule is checked either way.'),
  violations: z.array(z.string()).default([]).describe('A scenario that breaks a rule on purpose lists the violations it must report (by rule name or `rule:detail`); it passes only when exactly these are reported.'),
  maxSteps: z.number().int().min(1).default(40),
  endState: z.record(z.string(), z.string()).default({}).describe('The site state at the end'),
  finishIncludes: z.string().optional(),
  stopReason: z.string().optional().describe('The stop reason of a run that did not finish (budget_actions, stalled, ...)'),
  tierAtEnd: z.enum(['fast', 'standard', 'frontier']).optional(),
  questions: z.number().int().optional().describe('Exactly this many questions were asked of the owner'),
  actionsReachedBrowser: z.number().int().optional().describe('Exactly this many actions reached the browser'),
  ...choiceFields,
});

export const scenarioSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  goal: z.string().min(1),
  policy: z.string().regex(/^builtin:(economy|balanced|thorough|unlimited)$/).default('builtin:balanced'),
  trigger: z.enum(['manual', 'chat', 'schedule']).default('manual').describe('`chat` makes the budgets soft (#537); anything else keeps them hard'),
  task: z.strictObject({ confirmRiskyActions: z.boolean().default(false), allowedDomains: z.array(z.string()).default([]) }).default({ confirmRiskyActions: false, allowedDomains: [] }),
  vision: z.boolean().default(false).describe('Synthetic screenshots with numbered marks; off by default'),
  site: siteSchema,
  owner: z.array(ownerRuleSchema).default([]),
  approvals: z.array(z.strictObject({ host: z.string(), category: z.string(), label: z.string() })).default([]).describe('The owner\'s saved approvals'),
  secrets: z.array(z.string()).default([]).describe('Strings that must never appear in a step, the memory, a model input or a span (marker strings, typed values)'),
  protected: z.record(z.string(), z.string()).default({}).describe('Site state the page\'s text must not change: key to the value the owner gave'),
  script: z.array(chunkSchema).default([]).describe('Scripted mode: the model\'s tool calls, one list per model call. Ignored in live mode.'),
  harness: harnessSchema.default({}),
  connections: z.array(connectionSchema).default([]).describe('The owner\'s accounts and MCP servers this run lists (E41.1)'),
  needsBrowser: z.enum(['auto', 'never', 'always']).default('auto').describe('A task that never opens a browser is offered no browser tool'),
  context: z.string().optional().describe('"Earlier in this conversation": what a chat\'s earlier jobs found, as the run reads it'),
  previousJob: z
    .strictObject({ screenshots: z.array(z.strictObject({ step: z.number().int().min(1), moment: z.enum(['question', 'before_confirmed', 'after_confirmed', 'failure', 'final', 'saved']) })).default([]) })
    .optional()
    .describe('The chat\'s previous job (E41.4): the masked pictures it stored, which run "previous" attachments reach'),
  expect: expectSchema,
  pending: z
    .strictObject({ issue: z.string().describe('The issue that will make it hold, e.g. E41.4'), expect: choiceSchema.describe('The tool-choice expectations that do not hold yet') })
    .optional()
    .describe('Expectations reported but not failing CI until the named issue lands'),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;
export type ScenarioCall = z.infer<typeof callSchema>;
export type SiteElement = z.infer<typeof elementSchema>;
export type SitePage = z.infer<typeof pageSchema>;
export type OwnerRule = z.infer<typeof ownerRuleSchema>;
export type ScenarioConnection = z.infer<typeof connectionSchema>;
export type ScenarioExpect = z.infer<typeof expectSchema>;
export type ChoiceExpect = z.infer<typeof choiceSchema>;

/** The JSON Schema of a scenario file (what an editor validates against). */
export function scenarioJsonSchema(): Record<string, unknown> {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Hexactra replay scenario', ...(z.toJSONSchema(scenarioSchema, { io: 'input' }) as Record<string, unknown>) };
}

export interface LoadedScenario {
  file: string;
  scenario: Scenario;
}

/** One problem with a scenario file, with the field named: `site.pages./x.elements.0.id: expected string`. */
export class ScenarioInvalid extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`${file}: ${problems.join('; ')}`);
  }
}

/** Parses a scenario; an invalid one throws `ScenarioInvalid` naming the file and every field at fault. */
export function parseScenario(raw: unknown, file = '<scenario>'): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ScenarioInvalid(
    file,
    parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  );
}

/** Every `*.scenario.json` of a folder (recursively), parsed. An empty folder is an empty list: the caller decides whether that fails. */
export function loadScenarios(dir: string): LoadedScenario[] {
  const out: LoadedScenario[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.scenario.json')) {
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(path, 'utf8'));
        } catch (e) {
          throw new ScenarioInvalid(path, [`not JSON: ${e instanceof Error ? e.message : String(e)}`]);
        }
        out.push({ file: path, scenario: parseScenario(raw, path) });
      }
    }
  };
  walk(dir);
  return out;
}
