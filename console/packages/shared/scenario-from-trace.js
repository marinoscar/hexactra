// A run trace (`hexactra.run-trace`, E35.1, #542) turned into the skeleton of a SCRIPTED replay scenario (E38.6, #587). Framework-free and
// dependency-free, so the CLI (`hexactra dev scenario-from-trace`) and the API's specs share one copy.
//
// It is a starting point a person finishes, not a recording of the web: a trace holds what the agent did (the actions with redacted
// arguments, the questions and answers, the result), never the page content of a step or the model's messages. So the fake site is
// GUESSED from the steps (a page per address visited, an element per selector clicked or typed into) and everything the trace cannot say is
// a `TODO` marker. Real sites are never copied: every host becomes `site-N.example.test` and every path `/page-N`. Masked values stay
// masked: the converter reads only the trace's already masked text, never a screenshot, and writes a typed value as `TODO` (a trace holds
// the length of what was typed, never the text).

const CHUNK = 6;
/** The tool a trace's action stands for. `null`: no tool maps to it, a TODO call says so. */
const TOOL = {
  navigate: 'navigate',
  new_tab: 'new_tab',
  back: 'go_back',
  tabs: 'tabs',
  elements: 'observe_elements',
  text: 'read_text',
  click: 'click',
  click_at: 'click_at',
  press: 'press_key',
  wait_for: 'wait_for',
  evaluate: 'run_javascript',
};

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} trace a parsed run trace file
 * @returns {{ scenario: object, todo: string[] }}
 */
function scenarioFromTrace(trace) {
  if (!isObject(trace) || trace.type !== 'hexactra.run-trace') throw new Error('not a run trace: its "type" is not "hexactra.run-trace"');
  if (!isObject(trace.run) || !Array.isArray(trace.steps)) throw new Error('not a run trace: it has no "run" or no "steps"');
  const todo = [];
  const run = trace.run;
  const steps = trace.steps;

  // Hosts and pages: invented, stable by first sight.
  const hosts = new Map();
  const pages = new Map();
  const pageUrl = (raw) => {
    let u;
    try {
      u = new URL(String(raw).replace(/ \(query removed\)$/, ''));
    } catch {
      return null;
    }
    if (!hosts.has(u.hostname)) hosts.set(u.hostname, `site-${hosts.size + 1}.example.test`);
    const key = `${u.hostname}${u.pathname}`;
    if (!pages.has(key)) pages.set(key, { url: `https://${hosts.get(u.hostname)}/${u.pathname === '/' ? '' : `page-${pages.size + 1}`}`, title: null, elements: new Map() });
    return pages.get(key);
  };

  let current = null;
  const startUrl = steps.find((s) => s.action === 'navigate' && isObject(s.args) && typeof s.args.url === 'string');
  if (startUrl) current = pageUrl(startUrl.args.url);

  const owner = [];
  const secrets = [];
  const script = [];
  let chunk = [];
  const flush = () => {
    if (chunk.length) script.push(chunk);
    chunk = [];
  };
  const elementOf = (selector, init) => {
    if (!current) current = pageUrl('https://site-1.example.test/') ?? null;
    if (!current.elements.has(selector)) current.elements.set(selector, { id: `el-${current.elements.size + 1}`, selector, tag: 'button', label: 'TODO label', ...init, on: [] });
    return current.elements.get(selector);
  };

  let skipped = 0;
  let confirmations = 0;
  for (const s of steps) {
    if (s.kind === 'handoff' && isObject(s.question)) {
      const q = s.question;
      flush();
      if (q.kind === 'confirmation') confirmations += 1;
      const answer = isObject(q.answer) ? q.answer : null;
      const rule = { when: { kind: q.kind, input: q.input } };
      if (!answer || answer.outcome !== 'completed') Object.assign(rule, { answer: 'decline' });
      else if (q.input === 'confirm') Object.assign(rule, { answer: answer.value === 'deny' ? 'deny' : 'approve' });
      else if (q.input === 'secret') {
        secrets.push('TODO-secret-value');
        Object.assign(rule, { answer: 'secret', value: 'TODO-secret-value' });
      } else if (q.input === 'credentials') {
        secrets.push('TODO-password-value');
        Object.assign(rule, { answer: 'credentials', value: 'TODO-username', password: 'TODO-password-value' });
      } else if (q.input === 'choice') Object.assign(rule, { answer: 'choice', value: typeof answer.value === 'string' ? answer.value : 'TODO' });
      else if (q.input === 'none' || q.input === 'takeover') Object.assign(rule, { answer: 'done' });
      else Object.assign(rule, { answer: 'text', value: typeof answer.value === 'string' ? answer.value : 'TODO' });
      if (!owner.some((r) => r.when.kind === rule.when.kind && r.when.input === rule.when.input && r.answer === rule.answer)) owner.push(rule);
      chunk.push({ tool: 'request_human', args: { kind: q.kind, prompt: clip(q.prompt, 300), input: q.input, ...(Array.isArray(q.options) ? { options: q.options.map((o) => ({ id: o.id, label: o.label, description: null })) } : {}) } });
      flush();
      continue;
    }
    if (s.kind === 'finish') {
      flush();
      script.push([{ tool: 'finish', args: { success: s.ok === true, result: clip(s.summary, 500) || 'TODO result' } }]);
      continue;
    }
    if (s.kind !== 'action' || typeof s.action !== 'string') continue;
    const args = isObject(s.args) ? s.args : {};
    const refused = typeof s.summary === 'string' && /paused by policy|refused by policy/.test(s.summary);
    // A step that failed for a reason the fake site cannot reproduce is left out; a refusal is a gate, which the harness reproduces.
    if (s.ok === false && !refused) {
      skipped += 1;
      continue;
    }
    if (s.action === 'navigate' || s.action === 'new_tab') {
      const page = typeof args.url === 'string' ? pageUrl(args.url) : null;
      if (page) {
        current = page;
        const title = typeof s.summary === 'string' ? /—\s*(.+)$/.exec(s.summary)?.[1] : null;
        if (title && !page.title) page.title = clip(title, 80);
        chunk.push({ tool: TOOL[s.action], args: { url: page.url } });
      }
    } else if (s.action === 'click') {
      const sel = typeof args.selector === 'string' ? args.selector : 'TODO-selector';
      // A click the gate stopped records what the page said it was: its label and the kind of commitment.
      const label = typeof args.label === 'string' ? args.label : null;
      const category = typeof args.category === 'string' ? args.category : null;
      const el = elementOf(sel, { ...(label ? { label } : {}), ...(category ? { commit: category } : {}) });
      if (label && el.label === 'TODO label') el.label = label;
      chunk.push({ tool: 'click', args: { selector: sel } });
    } else if (s.action === 'type') {
      const sel = typeof args.selector === 'string' ? args.selector : 'TODO-selector';
      const el = elementOf(sel, { tag: 'input', type: 'text', label: 'TODO label' });
      if (/typed the secret/.test(String(s.summary))) {
        el.type = 'password';
        el.secret = true;
        chunk.push({ tool: 'type_handoff_secret', args: { selector: sel } });
      } else {
        // A trace keeps the length of what was typed, never the text: it stays a TODO.
        const length = typeof args.text_length === 'number' ? args.text_length : null;
        chunk.push({ tool: 'type_text', args: { selector: sel, text: `TODO value${length === null ? '' : ` (${length} characters)`}` } });
      }
    } else if (TOOL[s.action]) {
      const mapped = { tool: TOOL[s.action] };
      if (s.action === 'press' && typeof args.key === 'string') mapped.args = { key: args.key };
      if (s.action === 'wait_for' && typeof args.selector === 'string') mapped.args = { selector: args.selector };
      if (s.action === 'text' && typeof args.selector === 'string') mapped.args = { selector: args.selector };
      if (s.action === 'evaluate') mapped.args = { script: 'TODO: the script of this step is not in the trace' };
      chunk.push(mapped);
    } else {
      chunk.push({ tool: `TODO:${s.action}` });
      todo.push(`step ${s.seq}: the action "${s.action}" has no tool in the script: map it by hand.`);
    }
    if (chunk.length >= CHUNK) flush();
  }
  flush();

  if (skipped) todo.push(`${skipped} failed step(s) were left out: the fake site does not reproduce a browser failure.`);
  const sitePages = {};
  for (const page of pages.values()) {
    sitePages[page.url] = {
      title: page.title ?? 'TODO title',
      text: 'TODO: what this page shows. The trace does not hold page content.',
      elements: [...page.elements.values()],
    };
  }
  if (Object.keys(sitePages).length === 0) {
    sitePages['https://site-1.example.test/'] = { title: 'TODO title', text: 'TODO: what this page shows.', elements: [] };
    todo.push('the trace opens no page: the site is empty.');
  }
  for (const page of Object.values(sitePages)) for (const el of page.elements) if (el.label === 'TODO label') todo.push(`${el.selector}: what is this element called on the page, and what does a click do (on)?`);
  todo.push('write what each click does (the "on" of each element): a goto, or state to set.', 'check the goal: replace any real name or amount with an invented one (Person A, 10.00).', 'rename the scenario and fill in its expectations.');

  const status = ['succeeded', 'failed', 'cancelled', 'paused', 'waiting_human'].includes(run.status) ? run.status : 'succeeded';
  if (status !== run.status) todo.push(`the run was ${String(run.status)} when exported: set expect.status.`);
  const policyId = isObject(trace.policy) && typeof trace.policy.id === 'string' && /^builtin:(economy|balanced|thorough|unlimited)$/.test(trace.policy.id) ? trace.policy.id : 'builtin:balanced';
  if (policyId !== (isObject(trace.policy) ? trace.policy.id : null)) todo.push('the run used a policy of its own: the scenario uses builtin:balanced.');
  const trigger = run.trigger === 'chat' || run.trigger === 'schedule' ? run.trigger : 'manual';
  const confirm = confirmations > 0 || (Array.isArray(run.confirmedActions) && run.confirmedActions.length > 0);

  const scenario = {
    $schema: './scenario.schema.json',
    name: `TODO name (from a trace): ${clip(String(run.goal ?? 'a run'), 50)}`,
    description: `A skeleton made from a run trace by "hexactra dev scenario-from-trace". Every TODO is something the trace could not say. ${todo.length} thing(s) to finish.`,
    goal: String(run.goal ?? 'TODO goal'),
    policy: policyId,
    trigger,
    task: { confirmRiskyActions: confirm, allowedDomains: [...hosts.values()] },
    site: { start: [...pages.values()][0]?.url ?? 'https://site-1.example.test/', state: {}, pages: sitePages },
    owner,
    secrets,
    script,
    expect: {
      status,
      mustAsk: confirm ? [{ kind: 'confirmation' }] : [],
      maxSteps: Math.max(10, steps.length * 2),
    },
  };
  return { scenario, todo };
}

exports.scenarioFromTrace = scenarioFromTrace;
