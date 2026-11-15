import React, { useState, useEffect, useMemo } from 'react';
import { ControlPlaneClient, HandoffView, RespondHandoffRequest } from '@hexactra/sdk';

// Human handoffs pending on the control plane (`/v1/handoffs`), answered with
// the dashboard's operator token.

interface InboxProps {
  /** Origin of the control plane, e.g. http://127.0.0.1:8787. */
  apiBase: string;
  /** Operator or service token. */
  token: string;
}

/** The answer being edited for the selected handoff. */
interface Draft {
  value: string;
  values: string[];
}

const EMPTY_DRAFT: Draft = { value: '', values: [] };

export function HITLInbox({ apiBase, token }: InboxProps) {
  const client = useMemo(() => new ControlPlaneClient({ baseUrl: apiBase, token }), [apiBase, token]);
  const [pending, setPending] = useState<HandoffView[]>([]);
  const [selected, setSelected] = useState<HandoffView | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPending();
  }, [client]);

  const fetchPending = async () => {
    try {
      setLoading(true);
      setPending(await client.listHandoffs({ pending: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (handoff: HandoffView) => {
    setSelected(handoff);
    setDraft(EMPTY_DRAFT);
  };

  const respond = async (body: RespondHandoffRequest) => {
    if (!selected) return;
    try {
      await client.respondHandoff(selected.id, { ...body, channel: 'dashboard' });
      setSelected(null);
      setDraft(EMPTY_DRAFT);
      await fetchPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleSubmit = () => {
    if (!selected) return;
    switch (selected.input) {
      case 'none':
      case 'takeover':
        return respond({ outcome: 'completed' });
      case 'multi_choice':
        return respond({ outcome: 'completed', values: draft.values });
      default:
        return respond({ outcome: 'completed', value: draft.value });
    }
  };

  const handleDecline = () => respond({ outcome: 'cancelled' });

  const handleCancel = async () => {
    if (!selected) return;
    try {
      await client.cancelHandoff(selected.id);
      setSelected(null);
      await fetchPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const formatTimeRemaining = (expiresAt: string): string => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  };

  const toggleValue = (id: string) => {
    const values = draft.values.includes(id)
      ? draft.values.filter((v) => v !== id)
      : [...draft.values, id];
    setDraft({ ...draft, values });
  };

  const renderAnswerInput = () => {
    if (!selected) return null;
    const c = selected.constraints ?? {};
    switch (selected.input) {
      case 'text':
        return (
          <div className="form-group">
            <label htmlFor="answer-input">Answer:</label>
            {c.multiline ? (
              <textarea
                id="answer-input"
                className="secret-input-field"
                maxLength={c.max_length}
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              />
            ) : (
              <input
                id="answer-input"
                className="secret-input-field"
                maxLength={c.max_length}
                pattern={c.pattern}
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              />
            )}
          </div>
        );
      case 'secret':
        return (
          <div className="form-group">
            <label htmlFor="answer-input">Secret (password or code):</label>
            <input
              type="password"
              id="answer-input"
              className="secret-input-field"
              autoComplete="off"
              maxLength={c.max_length}
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            />
            <p className="security-note">
              Never shown back to the agent: the control plane types it into the page once.
            </p>
          </div>
        );
      case 'number':
        return (
          <div className="form-group">
            <label htmlFor="answer-input">Number{c.unit ? ` (${c.unit})` : ''}:</label>
            <input
              type="number"
              id="answer-input"
              className="secret-input-field"
              min={c.min}
              max={c.max}
              step={c.step}
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            />
          </div>
        );
      case 'choice':
        return (
          <div className="form-group">
            {(selected.choices ?? []).map((o) => (
              <label key={o.id} className="choice">
                <input
                  type="radio"
                  name="choice"
                  checked={draft.value === o.id}
                  onChange={() => setDraft({ ...draft, value: o.id })}
                />{' '}
                {o.label}
                {o.description ? <span className="label"> — {o.description}</span> : null}
              </label>
            ))}
          </div>
        );
      case 'multi_choice':
        return (
          <div className="form-group">
            {(selected.choices ?? []).map((o) => (
              <label key={o.id} className="choice">
                <input
                  type="checkbox"
                  checked={draft.values.includes(o.id)}
                  onChange={() => toggleValue(o.id)}
                />{' '}
                {o.label}
                {o.description ? <span className="label"> — {o.description}</span> : null}
              </label>
            ))}
          </div>
        );
      default:
        return null;
    }
  };

  const renderActions = () => {
    if (!selected) return null;
    if (selected.input === 'confirm') {
      return (
        <div className="actions">
          <button className="btn approve" onClick={() => respond({ outcome: 'completed', value: 'approve' })}>
            {selected.confirm_label || 'Approve'}
          </button>
          <button className="btn deny" onClick={() => respond({ outcome: 'completed', value: 'deny' })}>
            {selected.deny_label || 'Deny'}
          </button>
          <button className="btn expire" onClick={handleCancel}>
            Cancel request
          </button>
        </div>
      );
    }
    const ready =
      selected.input === 'none' ||
      selected.input === 'takeover' ||
      (selected.input === 'multi_choice' ? draft.values.length > 0 : draft.value !== '');
    return (
      <div className="actions">
        <button className="btn approve" onClick={handleSubmit} disabled={!ready}>
          {selected.input === 'none' || selected.input === 'takeover' ? 'Done' : 'Submit'}
        </button>
        <button className="btn deny" onClick={handleDecline}>
          Decline
        </button>
        <button className="btn expire" onClick={handleCancel}>
          Cancel request
        </button>
      </div>
    );
  };

  const renderDetails = () => {
    if (!selected) return null;
    return (
      <div className="request-details">
        <h3>Handoff details</h3>
        <div className="request-info">
          <div className="info-item">
            <span className="label">Prompt:</span>
            <span className="value">{selected.prompt}</span>
          </div>
          <div className="info-item">
            <span className="label">Kind:</span>
            <span className="value">{selected.kind}</span>
          </div>
          <div className="info-item">
            <span className="label">Answer:</span>
            <span className="value">{selected.input}</span>
          </div>
          {selected.page?.url ? (
            <div className="info-item">
              <span className="label">Page:</span>
              <span className="value">{selected.page.title || selected.page.url}</span>
            </div>
          ) : null}
          {selected.viewer_url ? (
            <div className="info-item">
              <span className="label">Browser:</span>
              <a className="value" href={selected.viewer_url} target="_blank" rel="noreferrer noopener">
                Open the remote browser
              </a>
            </div>
          ) : null}
          <div className="info-item">
            <span className="label">Session ID:</span>
            <span className="value">{selected.session_id}</span>
          </div>
          <div className="info-item">
            <span className="label">Expires in:</span>
            <span className={`value ${formatTimeRemaining(selected.expires_at) === 'Expired' ? 'expired' : ''}`}>
              {formatTimeRemaining(selected.expires_at)}
            </span>
          </div>
        </div>
        {renderAnswerInput()}
        {renderActions()}
      </div>
    );
  };

  return (
    <div className="hitl-inbox">
      <h2>Human-in-the-Loop Inbox</h2>

      {error && <div className="error-message">{error}</div>}

      <div className="inbox-content">
        <div className="requests-list">
          <h3>Pending handoffs ({pending.length})</h3>
          {loading ? (
            <p>Loading...</p>
          ) : pending.length === 0 ? (
            <p>No pending handoffs</p>
          ) : (
            <ul className="request-list">
              {pending.map((h) => (
                <li
                  key={h.id}
                  className={`request-item ${selected?.id === h.id ? 'selected' : ''}`}
                  onClick={() => handleSelect(h)}
                >
                  <div className="request-header">
                    <span className="kind">{h.kind}</span>
                    <span className={`status ${h.status}`}>{h.status}</span>
                  </div>
                  <p className="reason">{h.prompt}</p>
                  <p className="expires">Expires in: {formatTimeRemaining(h.expires_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="request-details-panel">
          {selected ? renderDetails() : <p>Select a handoff to view details</p>}
        </div>
      </div>

      <style>{`
        .hitl-inbox {
          padding: 20px;
          font-family: inherit;
        }
        .hitl-inbox h2 {
          margin-top: 0;
          font-family: var(--hx-display);
          color: var(--hx-text);
        }
        .error-message {
          background-color: var(--hx-warn-bg);
          color: var(--hx-warn-text);
          padding: 12px;
          border-radius: 4px;
          margin-bottom: 20px;
        }
        .inbox-content {
          display: flex;
          gap: 20px;
        }
        .requests-list, .request-details-panel {
          flex: 1;
        }
        .request-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .request-item {
          background-color: var(--hx-surface-2);
          border: 2px solid transparent;
          border-radius: 12px;
          padding: 16px;
          margin-bottom: 12px;
          cursor: pointer;
          transition: background-color 0.2s;
        }
        .request-item:hover {
          background-color: var(--hx-surface-2-hover);
        }
        .request-item.selected {
          background-color: var(--hx-selected);
          border-color: var(--hx-primary);
        }
        .request-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .kind {
          font-weight: bold;
          color: var(--hx-primary);
        }
        .status {
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 0.8em;
          font-weight: 600;
        }
        .status.pending {
          background-color: var(--hx-warn-bg);
          color: var(--hx-warn-text);
        }
        .status.approved {
          background-color: var(--hx-ok-bg);
          color: var(--hx-ok-text);
        }
        .status.rejected {
          background-color: var(--hx-surface-2-hover);
          color: var(--hx-muted);
        }
        .reason {
          margin: 0;
          color: var(--hx-text);
        }
        .expires {
          margin: 4px 0 0;
          font-size: 0.9em;
          color: var(--hx-muted);
        }
        .request-details {
          background-color: var(--hx-surface);
          border: 1px solid var(--hx-border);
          border-radius: 12px;
          padding: 20px;
        }
        .request-info {
          margin-bottom: 20px;
        }
        .info-item {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid var(--hx-border);
        }
        .info-item:last-child {
          border-bottom: none;
        }
        .label {
          font-weight: 500;
          color: var(--hx-muted);
        }
        .value {
          color: var(--hx-text);
        }
        .form-group {
          margin-bottom: 16px;
        }
        .choice {
          display: block;
          margin-bottom: 6px;
        }
        .form-group label {
          display: block;
          margin-bottom: 4px;
          font-weight: 500;
          color: var(--hx-text);
        }
        .secret-input-field {
          width: 100%;
          padding: 12px;
          background-color: var(--hx-surface);
          color: var(--hx-text);
          border: 1px solid var(--hx-border);
          border-radius: 8px;
          font-size: 1em;
        }
        .secret-input-field:focus {
          outline: none;
          border-color: var(--hx-primary);
          box-shadow: 0 0 0 3px var(--hx-focus);
        }
        .security-note {
          margin: 8px 0 0;
          font-size: 0.8em;
          color: var(--hx-muted);
        }
        .actions {
          display: flex;
          gap: 12px;
          margin-top: 20px;
        }
        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 1em;
          font-weight: 600;
          font-family: inherit;
          transition: background-color 0.2s;
        }
        .btn:hover {
          opacity: 0.9;
        }
        .btn.approve {
          background-color: var(--hx-primary);
          color: var(--hx-on-primary);
        }
        .btn.deny {
          background-color: var(--hx-danger);
          color: var(--hx-on-danger);
        }
        .btn.expire {
          background-color: var(--hx-surface-2);
          color: var(--hx-text);
        }
        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
