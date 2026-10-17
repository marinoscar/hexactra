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
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        }
        .hitl-inbox h2 {
          margin-top: 0;
          color: #333;
        }
        .error-message {
          background-color: #ffebee;
          color: #c62828;
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
          background-color: #f5f5f5;
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 12px;
          cursor: pointer;
          transition: background-color 0.2s;
        }
        .request-item:hover {
          background-color: #e0e0e0;
        }
        .request-item.selected {
          background-color: #e3f2fd;
          border: 2px solid #2196f3;
        }
        .request-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .kind {
          font-weight: bold;
          color: #1976d2;
        }
        .status {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 0.8em;
        }
        .status.pending {
          background-color: #fff3e0;
          color: #ef6c00;
        }
        .status.approved {
          background-color: #e8f5e9;
          color: #2e7d32;
        }
        .status.rejected {
          background-color: #ffebee;
          color: #c62828;
        }
        .reason {
          margin: 0;
          color: #555;
        }
        .expires {
          margin: 4px 0 0;
          font-size: 0.9em;
          color: #777;
        }
        .request-details {
          background-color: #fff;
          border-radius: 8px;
          padding: 20px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .request-info {
          margin-bottom: 20px;
        }
        .info-item {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid #eee;
        }
        .info-item:last-child {
          border-bottom: none;
        }
        .label {
          font-weight: 500;
          color: #666;
        }
        .value {
          color: #333;
        }
        .form-group {
          margin-bottom: 16px;
        }
        .form-group label {
          display: block;
          margin-bottom: 4px;
          font-weight: 500;
          color: #333;
        }
        .secret-input-field {
          width: 100%;
          padding: 12px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1em;
        }
        .secret-input-field:focus {
          outline: none;
          border-color: #2196f3;
          box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.2);
        }
        .security-note {
          margin: 8px 0 0;
          font-size: 0.8em;
          color: #666;
        }
        .actions {
          display: flex;
          gap: 12px;
          margin-top: 20px;
        }
        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1em;
          transition: background-color 0.2s;
        }
        .btn:hover {
          opacity: 0.9;
        }
        .btn.approve {
          background-color: #2e7d32;
          color: white;
        }
        .btn.deny {
          background-color: #c62828;
          color: white;
        }
        .btn.expire {
          background-color: #f57c00;
          color: white;
        }
        .btn:disabled {
          background-color: #ccc;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
