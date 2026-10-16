#!/usr/bin/env node

/**
 * Fixture server for browser testing
 * Provides a deterministic test site with forms, SPA nav, tabs, nested frames, OTP and approval challenges
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.FIXTURE_PORT || 8765;

const routes = {
  '/': () => createPage('Fixture Site - Home', `
    <h1>Hexactra Fixture Site</h1>
    <p>Welcome to the test fixture site.</p>
    <nav>
      <a href="/forms">Forms</a>
      <a href="/spa">SPA Navigation</a>
      <a href="/frames">Nested Frames</a>
      <a href="/otp">OTP Challenge</a>
      <a href="/approval">Approval Challenge</a>
    </nav>
  `),
  '/forms': () => createPage('Forms Test', `
    <h1>Form Tests</h1>
    <form id="test-form">
      <input type="text" name="username" placeholder="Username" />
      <input type="password" name="password" placeholder="Password" />
      <button type="submit">Submit</button>
    </form>
  `),
  '/spa': () => createPage('SPA Navigation', `
    <h1>SPA Navigation Test</h1>
    <div id="app">
      <nav>
        <button onclick="navigate('/')">Home</button>
        <button onclick="navigate('/spa/page1')">Page 1</button>
        <button onclick="navigate('/spa/page2')">Page 2</button>
      </nav>
      <main id="content"></main>
    </div>
    <script>
      function navigate(path) {
        const content = document.getElementById('content');
        content.innerHTML = '<h2>' + path + '</h2>';
      }
    </script>
  `),
  '/frames': () => createPage('Nested Frames', `
    <h1>Nested Frames Test</h1>
    <iframe src="/frame1" width="100%" height="300"></iframe>
  `),
  '/frame1': () => createPage('Frame 1', `
    <h2>Frame 1</h2>
    <iframe src="/frame2" width="100%" height="200"></iframe>
  `),
  '/frame2': () => createPage('Frame 2', `
    <h3>Frame 2</h3>
    <p>This is a nested frame for testing.</p>
  `),
  '/otp': () => createPage('OTP Challenge', `
    <h1>OTP Challenge</h1>
    <p>Please enter the OTP sent to your device.</p>
    <form id="otp-form">
      <input type="text" name="otp" placeholder="Enter OTP" maxlength="6" />
      <button type="submit">Verify</button>
    </form>
  `),
  '/approval': () => createPage('Approval Challenge', `
    <h1>Approval Challenge</h1>
    <p>This action requires human approval.</p>
    <button id="approve-btn">Approve</button>
    <button id="reject-btn">Reject</button>
  `),
};

function createPage(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body>
  ${content}
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  let url = req.url;
  if (url === '/') {
    url = '/';
  }
  
  const handler = routes[url] || routes['/'];
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(handler());
});

server.listen(PORT, () => {
  console.log(`Fixture server running on http://localhost:${PORT}`);
});
