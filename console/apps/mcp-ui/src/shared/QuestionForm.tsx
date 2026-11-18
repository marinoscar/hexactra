// The typed answer form of one question inside a chat (#467): the run card's
// "Needs you" banner and the question card both render it. It mirrors the
// console's form (apps/web/src/components/QuestionAnswerForm.tsx) through the
// same answer rules (packages/shared/question-rules.js), with what a chat may
// and may not collect (the `mcp-app` channel: a person clicked, but is not
// signed in to Hexactra):
//
// - choice, multi_choice, text, number and a low-risk confirm: a form;
// - none: one acknowledgement button;
// - a high-risk confirm, a secret and a takeover: no answering control at
//   all, only the way to Hexactra. The server refuses them from this channel
//   anyway (question_card_answer, CHANNEL_RULES).
//
// Every string (prompt, labels, descriptions) is rendered as text.
import { chatAnswerMode, numberError, numberHint, selectionBounds, selectionHelp, selectionOk, textError, type RuleAnswer } from '@app/shared/question-rules';
import { useId, useMemo, useState, type FormEvent } from 'react';

import type { CardQuestion } from './question';

export interface QuestionFormProps {
  question: CardQuestion;
  /** Send the answer; resolves when the host and the server have answered. */
  onSubmit(answer: RuleAnswer): void | Promise<void>;
  /** Open the console: the inbox (`inbox`) or the desktop viewer (`viewer`). */
  onOpen(where: 'inbox' | 'viewer'): void;
  /** Every control is disabled (sending, sent, or a newer card took over). */
  disabled?: boolean;
  /** The server's sentence about the last answer, shown next to the controls. */
  error?: string | null;
}

export const SECRET_TEXT = 'For your security, codes and passwords are entered only in Hexactra.';
export const SIGNED_IN_TEXT = 'Open your Hexactra inbox to approve this.';
export const TAKEOVER_TEXT = 'The agent needs you to take over the browser.';

export function QuestionForm({ question: q, onSubmit, onOpen, disabled = false, error = null }: QuestionFormProps) {
  const uid = useId();
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const mode = chatAnswerMode(q);
  const options = q.options;
  const c = q.constraints;
  const bounds = selectionBounds(c, options.length);
  const fieldError = useMemo(() => (q.input === 'number' ? numberError(value, c) : q.input === 'text' ? textError(value, c) : null), [q.input, value, c]);

  const errorLine = error ? (
    <p className="field-error" role="alert">
      {error}
    </p>
  ) : null;

  if (mode === 'secret' || mode === 'signed_in' || mode === 'takeover') {
    const text = mode === 'secret' ? SECRET_TEXT : mode === 'signed_in' ? SIGNED_IN_TEXT : TAKEOVER_TEXT;
    return (
      <div className="qform">
        <p className="muted">{text}</p>
        {errorLine}
        <div className="row">
          <button type="button" className="btn primary" onClick={() => onOpen(mode === 'takeover' && q.viewerUrl ? 'viewer' : 'inbox')}>
            {mode === 'takeover' ? 'Open in Hexactra' : 'Open inbox'}
          </button>
        </div>
      </div>
    );
  }

  const send = (a: RuleAnswer) => {
    if (!disabled) void onSubmit(a);
  };
  const decline = (
    <button type="button" className="btn danger" disabled={disabled} onClick={() => send({ outcome: 'cancelled' })}>
      Decline
    </button>
  );

  if (mode === 'acknowledge') {
    return (
      <div className="qform">
        {errorLine}
        <div className="row">
          <button type="button" className="btn primary" disabled={disabled} onClick={() => send({ outcome: 'completed' })}>
            {q.kind === 'confirmation' ? 'Approve' : 'Done'}
          </button>
          {decline}
        </div>
      </div>
    );
  }

  if (q.input === 'confirm') {
    return (
      <div className="qform">
        {errorLine}
        <div className="row">
          <button type="button" className="btn primary" disabled={disabled} onClick={() => send({ outcome: 'completed', value: 'approve' })}>
            {q.confirmLabel || 'Approve'}
          </button>
          <button type="button" className="btn" disabled={disabled} onClick={() => send({ outcome: 'completed', value: 'deny' })}>
            {q.denyLabel || 'Deny'}
          </button>
          {decline}
        </div>
      </div>
    );
  }

  let ready = false;
  let field = null;
  const hintId = `${uid}-hint`;
  const errId = `${uid}-err`;
  switch (q.input) {
    case 'choice':
      ready = options.some((o) => o.id === value);
      field = (
        <fieldset className="options">
          <legend>Choose one</legend>
          {options.map((o) => (
            <label key={o.id} className="option">
              <input type="radio" name={`${uid}-choice`} value={o.id} checked={value === o.id} disabled={disabled} onChange={() => setValue(o.id)} />
              <span className="option-text">
                <span>{o.label}</span>
                {o.description ? <span className="muted option-desc">{o.description}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      );
      break;
    case 'multi_choice':
      ready = selectionOk(picked.length, bounds);
      field = (
        <fieldset className="options" aria-describedby={hintId}>
          <legend>{selectionHelp(bounds, options.length)}</legend>
          {options.map((o) => {
            const on = picked.includes(o.id);
            return (
              <label key={o.id} className="option">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled || (!on && picked.length >= bounds.max)}
                  onChange={() => setPicked((p) => (on ? p.filter((x) => x !== o.id) : [...p, o.id]))}
                />
                <span className="option-text">
                  <span>{o.label}</span>
                  {o.description ? <span className="muted option-desc">{o.description}</span> : null}
                </span>
              </label>
            );
          })}
          <p id={hintId} className="muted hint">
            {picked.length} of {bounds.max} selected{picked.length < bounds.min && bounds.min > 1 ? ` (at least ${bounds.min})` : ''}
          </p>
        </fieldset>
      );
      break;
    case 'text': {
      ready = value.trim() !== '' && !fieldError;
      const props = {
        id: `${uid}-text`,
        className: 'input',
        value,
        disabled,
        maxLength: c?.maxLength,
        autoComplete: 'off',
        'aria-invalid': fieldError ? true : undefined,
        'aria-describedby': `${hintId}${fieldError ? ` ${errId}` : ''}`,
        onInput: (e: { currentTarget: { value: string } }) => setValue(e.currentTarget.value),
      };
      field = (
        <div className="field">
          <label htmlFor={`${uid}-text`}>Your answer</label>
          {c?.multiline ? <textarea rows={3} {...props} /> : <input type="text" {...props} />}
          <p id={hintId} className="muted hint">
            {c?.maxLength ? `${value.length} / ${c.maxLength}` : ''}
          </p>
          {fieldError ? (
            <p id={errId} className="field-error" role="alert">
              {fieldError}
            </p>
          ) : null}
        </div>
      );
      break;
    }
    case 'number': {
      ready = value.trim() !== '' && !fieldError;
      field = (
        <div className="field">
          <label htmlFor={`${uid}-number`}>Number{c?.unit ? ` (${c.unit})` : ''}</label>
          <div className="with-unit">
            <input
              id={`${uid}-number`}
              className="input"
              type="number"
              inputMode="decimal"
              value={value}
              disabled={disabled}
              min={c?.min}
              max={c?.max}
              step={c?.step ?? 'any'}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={`${hintId}${fieldError ? ` ${errId}` : ''}`}
              onInput={(e: { currentTarget: { value: string } }) => setValue(e.currentTarget.value)}
            />
            {c?.unit ? (
              <span className="unit" aria-hidden="true">
                {c.unit}
              </span>
            ) : null}
          </div>
          <p id={hintId} className="muted hint">
            {numberHint(c)}
          </p>
          {fieldError ? (
            <p id={errId} className="field-error" role="alert">
              {fieldError}
            </p>
          ) : null}
        </div>
      );
      break;
    }
    default:
      return null;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || disabled) return;
    if (q.input === 'multi_choice') send({ outcome: 'completed', values: options.map((o) => o.id).filter((id) => picked.includes(id)) });
    else send({ outcome: 'completed', value: q.input === 'number' ? value.trim() : value });
  };

  return (
    <form className="qform" onSubmit={submit} noValidate>
      {field}
      {errorLine}
      <div className="row">
        <button type="submit" className="btn primary" disabled={disabled || !ready}>
          Send
        </button>
        {decline}
      </div>
    </form>
  );
}
