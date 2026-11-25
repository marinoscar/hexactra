// The answer rules of a typed question (E26, #467): what a valid answer is
// for each input type and its constraints, and which inputs may be answered
// where. Framework-free and dependency-free, so the web app's form
// (apps/web/src/components/QuestionAnswerForm.tsx), the MCP Apps widgets
// (apps/mcp-ui) and the API's channel rules
// (apps/api/src/questions/channels/channel-rules.ts) apply one copy.
//
// Constraints use the REST contract's names (camelCase: maxLength, pattern,
// multiline, min, max, step, unit, minSelections, maxSelections).

/** Why a number does not fit its constraints, or null (an empty field is not an error yet). */
function numberError(raw, c) {
  const v = String(raw ?? '').trim();
  if (v === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(v)) return 'Enter a number';
  const n = Number(v);
  if (c && c.min !== undefined && c.min !== null && n < c.min) return `At least ${c.min}`;
  if (c && c.max !== undefined && c.max !== null && n > c.max) return `At most ${c.max}`;
  if (c && c.step !== undefined && c.step !== null) {
    const k = (n - (c.min ?? 0)) / c.step;
    if (Math.abs(k - Math.round(k)) > 1e-9) return `In steps of ${c.step}`;
  }
  return null;
}

/** Why a text answer does not fit its constraints, or null (an empty field is not an error yet). */
function textError(v, c) {
  if (v === '' || v === undefined || v === null) return null;
  if (c && c.maxLength !== undefined && c.maxLength !== null && v.length > c.maxLength) return `At most ${c.maxLength} characters`;
  if (!(c && c.multiline) && /[\r\n]/.test(v)) return 'One line only';
  if (c && c.pattern) {
    try {
      if (!new RegExp(`^(?:${c.pattern})$`, 'u').test(v)) return 'This does not have the expected format';
    } catch {
      return null;
    }
  }
  return null;
}

/** How many options a multi_choice answer must hold: `minSelections` (default 1) to `maxSelections` (default every option). */
function selectionBounds(c, optionCount) {
  const min = c && typeof c.minSelections === 'number' ? c.minSelections : 1;
  const max = c && typeof c.maxSelections === 'number' ? c.maxSelections : optionCount;
  return { min, max };
}

/** Whether `count` picked options are a valid multi_choice answer. */
function selectionOk(count, bounds) {
  return count >= bounds.min && count <= bounds.max;
}

/** The instruction above a multi_choice: "Choose 2", "Choose one or more", "Choose between 1 and 3". */
function selectionHelp(bounds, optionCount) {
  if (bounds.min === bounds.max) return `Choose ${bounds.min}`;
  if (bounds.max >= optionCount && bounds.min <= 1) return 'Choose one or more';
  return `Choose between ${bounds.min} and ${bounds.max}`;
}

/** The hint under a number field: "min 0 · max 50 · step 0.5", or '' with no constraint. */
function numberHint(c) {
  if (!c) return '';
  return [c.min !== undefined && c.min !== null ? `min ${c.min}` : '', c.max !== undefined && c.max !== null ? `max ${c.max}` : '', c.step !== undefined && c.step !== null ? `step ${c.step}` : '']
    .filter(Boolean)
    .join(' · ');
}

/**
 * Whether an answer is valid for the question (outcome `completed`), or the
 * sentence that says why not. Declining (`cancelled`) is always valid.
 */
function answerError(q, answer) {
  if (!answer || answer.outcome === 'cancelled') return null;
  const c = q.constraints || null;
  const options = q.options || [];
  switch (q.input) {
    case 'text': {
      const v = typeof answer.value === 'string' ? answer.value : '';
      if (v.trim() === '') return 'Enter an answer';
      return textError(v, c);
    }
    case 'number': {
      const v = answer.value === undefined || answer.value === null ? '' : String(answer.value);
      if (v.trim() === '') return 'Enter a number';
      return numberError(v, c);
    }
    case 'choice':
      return options.some((o) => o.id === answer.value) ? null : 'Choose one of the options';
    case 'multi_choice': {
      const values = Array.isArray(answer.values) ? answer.values : [];
      if (values.some((v) => !options.some((o) => o.id === v)) || new Set(values).size !== values.length) return 'Choose among the options';
      const b = selectionBounds(c, options.length);
      return selectionOk(values.length, b) ? null : selectionHelp(b, options.length);
    }
    case 'confirm':
      return answer.value === 'approve' || answer.value === 'deny' ? null : 'Approve or deny';
    default:
      return null;
  }
}

/** Whether a form (#552) holds a sensitive field. */
function formHasSensitive(q) {
  return Array.isArray(q.fields) && q.fields.some((f) => f && f.sensitive === true);
}

/** Whether the answer is a secret or approves a risky action: only a channel that signs the person in may record it. */
function needsSignedIn(q) {
  // "Save this login?" (E37.4b) writes to the owner's vault: only where the console signs the person in.
  if (q.input === 'save_login') return true;
  // A scan (#924) shows a live picture of the owner's screen, often a sign-in code: only where the console signs the person in.
  if (q.input === 'scan') return true;
  if (q.input === 'form') return formHasSensitive(q);
  return q.input === 'secret' || q.input === 'credentials' || (q.input === 'confirm' && q.risk !== 'low');
}

/** Whether the answer is public: a channel that does not sign the person in (a webhook, a chat) may collect it. */
function isPublicAnswer(q) {
  switch (q.input) {
    case 'choice':
    case 'multi_choice':
    case 'text':
    case 'number':
      return true;
    case 'confirm':
      return q.risk === 'low';
    case 'form':
      // A task run's missing values (#552): public unless a field is sensitive.
      return !formHasSensitive(q);
    default:
      return false;
  }
}

/**
 * How a question is answered in an AI app's chat (the MCP Apps question card,
 * #467), where a person clicks but is not signed in to Hexactra:
 * - `form`: a typed form (choice, multi_choice, text, number, low-risk confirm);
 * - `acknowledge`: one button (`none`);
 * - `signed_in`: a high-risk confirmation, approved only in Hexactra;
 * - `secret`: a code, a password or a sign-in (`credentials`), entered only in Hexactra;
 * - `takeover`: done in the browser itself (the desktop viewer).
 * A scan (#924) is `signed_in`: its live picture is shown only in Hexactra.
 */
function chatAnswerMode(q) {
  if (q.input === 'secret' || q.input === 'credentials') return 'secret';
  // A memory proposal and "Save this login?" are answered only in Hexactra, signed in.
  if (q.input === 'memory' || q.input === 'save_login' || q.input === 'scan') return 'signed_in';
  if (q.input === 'takeover') return 'takeover';
  if (q.input === 'none') return 'acknowledge';
  // A task run's form (#552) is filled in Hexactra, or relayed field by field with inbox_answer.
  if (q.input === 'form') return 'signed_in';
  if (isPublicAnswer(q)) return 'form';
  return 'signed_in';
}

/** The answer in words, for "Sent: …" (an option's label, the confirm label, a number with its unit); never a secret. */
function answerLabel(q, answer) {
  if (!answer || answer.outcome === 'cancelled') return 'Declined';
  const label = (id) => {
    const o = (q.options || []).find((x) => x.id === id);
    return o ? o.label : id;
  };
  if (q.input === 'secret') return 'A secret (not shown)';
  if (q.input === 'credentials') return 'A sign-in (not shown)';
  if (q.input === 'save_login') return 'Saved';
  if (q.input === 'form') return 'Provided';
  if (Array.isArray(answer.values)) return answer.values.map(label).join(', ');
  if (answer.value === undefined || answer.value === null) return q.input === 'takeover' || q.input === 'scan' ? 'Done' : 'Acknowledged';
  const v = String(answer.value);
  if (q.input === 'choice') return label(v);
  if (q.input === 'confirm') return v === 'approve' ? q.confirmLabel || 'Approve' : q.denyLabel || 'Deny';
  if (q.input === 'number' && q.constraints && q.constraints.unit) return `${v} ${q.constraints.unit}`;
  return v;
}

exports.numberError = numberError;
exports.textError = textError;
exports.selectionBounds = selectionBounds;
exports.selectionOk = selectionOk;
exports.selectionHelp = selectionHelp;
exports.numberHint = numberHint;
exports.answerError = answerError;
exports.needsSignedIn = needsSignedIn;
exports.isPublicAnswer = isPublicAnswer;
exports.chatAnswerMode = chatAnswerMode;
exports.answerLabel = answerLabel;
