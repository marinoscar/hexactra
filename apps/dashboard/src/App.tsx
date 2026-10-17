import React from 'react';
import { HITLInbox } from './components/HITLInbox.js';

// Default API base URL (can be overridden via environment variable)
const API_BASE = import.meta.env?.VITE_API_BASE || 'http://localhost:3000/api/v1';
const AUTH_HEADER = `Bearer ${import.meta.env?.VITE_AUTH_TOKEN || ''}`;

export function App() {
  return (
    <div className="app">
      <h1>Hexactra Dashboard</h1>
      <nav className="nav">
        <a href="#inbox">HITL Inbox</a>
      </nav>
      <main className="content">
        <HITLInbox apiBase={API_BASE} authHeader={AUTH_HEADER} />
      </main>
    </div>
  );
}
