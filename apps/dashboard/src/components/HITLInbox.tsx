import React, { useState, useEffect } from 'react';
import {
  InteractionRequest,
  InteractionStatus,
  InteractionKind,
} from '@hexactra/sdk';

// Types for the inbox UI
interface InboxItem extends InteractionRequest {
  id: string;
  sessionId: string;
  reason: string;
  details: Record<string, unknown>;
  createdAt: string;
  kind: InteractionKind;
  status: InteractionStatus;
  expiresAt: string;
  ownerId?: string;
}

interface InboxProps {
  apiBase: string;
  authHeader: string;
}

export function HITLInbox({ apiBase, authHeader }: InboxProps) {
  const [pendingRequests, setPendingRequests] = useState<InboxItem[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<InboxItem | null>(null);
  const [response, setResponse] = useState<{ status: InteractionStatus; secret?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch pending requests on mount
  useEffect(() => {
    fetchPendingRequests();
  }, []);

  const fetchPendingRequests = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${apiBase}/hitl/pending`, {
        headers: {
          Authorization: authHeader,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch pending requests: ${res.statusText}`);
      }

      const data = await res.json();
      setPendingRequests(data.requests || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectRequest = (request: InboxItem) => {
    setSelectedRequest(request);
    setResponse(null);
  };

  const handleApprove = async () => {
    if (!selectedRequest || !response?.status) return;

    try {
      const res = await fetch(`${apiBase}/hitl/${selectedRequest.id}/respond`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          owner_id: selectedRequest.ownerId || '',
          status: response.status,
          secret: response.secret,
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to respond: ${res.statusText}`);
      }

      // Refresh the list
      await fetchPendingRequests();
      setSelectedRequest(null);
      setResponse(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleDeny = async () => {
    if (!selectedRequest) return;

    try {
      const res = await fetch(`${apiBase}/hitl/${selectedRequest.id}/respond`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          owner_id: selectedRequest.ownerId || '',
          status: InteractionStatus.Rejected,
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to deny: ${res.statusText}`);
      }

      // Refresh the list
      await fetchPendingRequests();
      setSelectedRequest(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleExpire = async () => {
    if (!selectedRequest) return;

    try {
      const res = await fetch(`${apiBase}/hitl/${selectedRequest.id}/respond`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          owner_id: selectedRequest.ownerId || '',
          status: InteractionStatus.Expired,
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to expire: ${res.statusText}`);
      }

      // Refresh the list
      await fetchPendingRequests();
      setSelectedRequest(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const formatTimeRemaining = (expiresAt: string): string => {
    const expires = new Date(expiresAt);
    const now = new Date();
    const diff = expires.getTime() - now.getTime();

    if (diff <= 0) return 'Expired';

    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  };

  const renderSecretInput = () => {
    if (!selectedRequest) return null;

    // Only show secret input for certain kinds
    const needsSecret = [
      InteractionKind.SecretText,
      InteractionKind.OtpCode,
    ].includes(selectedRequest.kind);

    return (
      <div className="secret-input">
        {needsSecret && (
          <div className="form-group">
            <label htmlFor="secret-input">Enter secret (password/OTP):</label>
            <input
              type="password"
              id="secret-input"
              className="secret-input-field"
              value={response?.secret || ''}
              onChange={(e) => setResponse({ ...response!, secret: e.target.value })}
              placeholder="Enter password or OTP code"
              autoFocus
            />
            <p className="security-note">
              Secret is encrypted in transit and never stored in logs or telemetry
            </p>
          </div>
        )}
      </div>
    );
  };

  const renderRequestDetails = () => {
    if (!selectedRequest) return null;

    return (
      <div className="request-details">
        <h3>Interaction Request Details</h3>
        <div className="request-info">
          <div className="info-item">
            <span className="label">Reason:</span>
            <span className="value">{selectedRequest.reason}</span>
          </div>
          <div className="info-item">
            <span className="label">Kind:</span>
            <span className="value">{selectedRequest.kind}</span>
          </div>
          <div className="info-item">
            <span className="label">Session ID:</span>
            <span className="value">{selectedRequest.sessionId}</span>
          </div>
          <div className="info-item">
            <span className="label">Created:</span>
            <span className="value">{new Date(selectedRequest.createdAt).toLocaleString()}</span>
          </div>
          <div className="info-item">
            <span className="label">Expires in:</span>
            <span className={`value ${formatTimeRemaining(selectedRequest.expiresAt) === 'Expired' ? 'expired' : ''}`}>
              {formatTimeRemaining(selectedRequest.expiresAt)}
            </span>
          </div>
          <div className="info-item">
            <span className="label">Status:</span>
            <span className={`value status-${selectedRequest.status}`}>
              {selectedRequest.status}
            </span>
          </div>
        </div>

        {renderSecretInput()}

        <div className="actions">
          <button
            className="btn approve"
            onClick={handleApprove}
            disabled={!response?.status}
          >
            Approve
          </button>
          <button className="btn deny" onClick={handleDeny}>
            Deny
          </button>
          <button className="btn expire" onClick={handleExpire}>
            Mark Expired
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="hitl-inbox">
      <h2>Human-in-the-Loop Inbox</h2>

      {error && <div className="error-message">{error}</div>}

      <div className="inbox-content">
        {/* Pending Requests List */}
        <div className="requests-list">
          <h3>Pending Requests ({pendingRequests.length})</h3>
          {loading ? (
            <p>Loading...</p>
          ) : pendingRequests.length === 0 ? (
            <p>No pending requests</p>
          ) : (
            <ul className="request-list">
              {pendingRequests.map((req) => (
                <li
                  key={req.id}
                  className={`request-item ${selectedRequest?.id === req.id ? 'selected' : ''}`}
                  onClick={() => handleSelectRequest(req)}
                >
                  <div className="request-header">
                    <span className="kind">{req.kind}</span>
                    <span className={`status status-${req.status}`}>{req.status}</span>
                  </div>
                  <p className="reason">{req.reason}</p>
                  <p className="expires">
                    Expires in: {formatTimeRemaining(req.expiresAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Selected Request Details */}
        <div className="request-details-panel">
          {selectedRequest ? renderRequestDetails() : <p>Select a request to view details</p>}
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
