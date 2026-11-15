import React from 'react';
import { HITLInbox } from './components/HITLInbox.js';

// Default API base URL (can be overridden via environment variable)
const API_BASE = import.meta.env?.VITE_API_BASE || 'http://localhost:3000/api/v1';
const AUTH_HEADER = `Bearer ${import.meta.env?.VITE_AUTH_TOKEN || ''}`;

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
        <HITLInbox apiBase={API_BASE} authHeader={AUTH_HEADER} />
      </main>
    </div>
  );
}
