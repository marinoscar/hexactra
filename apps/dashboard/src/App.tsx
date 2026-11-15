import React from 'react';
import { HITLInbox } from './components/HITLInbox.js';

// Origin of the control plane (its `/v1` API); override with VITE_API_BASE.
const API_BASE = import.meta.env?.VITE_API_BASE || 'http://127.0.0.1:8787';
// An operator or service token; override with VITE_AUTH_TOKEN.
const AUTH_TOKEN = import.meta.env?.VITE_AUTH_TOKEN || '';

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <svg viewBox="0 0 120 120" width="28" height="28" aria-hidden="true" focusable="false">
          <path className="trace" d="M60 60V108L18.4 84V36L60 12L101.6 36V84L80 96.5" fill="none" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
          <circle className="start" cx="60" cy="60" r="13" />
        </svg>
        <h1 aria-label="Hexactra Dashboard">hexactra</h1>
      </header>
      <nav className="nav">
        <a href="#inbox">HITL Inbox</a>
      </nav>
      <main className="content">
        <HITLInbox apiBase={API_BASE} token={AUTH_TOKEN} />
      </main>
    </div>
  );
}
