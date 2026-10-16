#!/usr/bin/env node

/**
 * Build script for Hexactra Chrome extension
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
const srcDir = path.join(__dirname, 'src');
const manifestDir = path.join(__dirname, 'manifest');

// Clean dist directory
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

console.log('Building Hexactra Chrome extension...');

// Copy manifest
const manifestPath = path.join(manifestDir, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  fs.copyFileSync(manifestPath, path.join(distDir, 'manifest.json'));
  console.log('Copied manifest.json');
}

// Copy sidepanel HTML
const sidepanelHtmlPath = path.join(__dirname, 'sidepanel.html');
if (fs.existsSync(sidepanelHtmlPath)) {
  fs.copyFileSync(sidepanelHtmlPath, path.join(distDir, 'sidepanel.html'));
  console.log('Copied sidepanel.html');
}

// Compile TypeScript files
console.log('Compiling TypeScript...');

try {
  execSync('tsc --project tsconfig.json', {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('TypeScript compilation complete');
} catch (error) {
  console.error('TypeScript compilation failed:', error);
  process.exit(1);
}

// Copy compiled files from src to root dist directory
const files = fs.readdirSync(srcDir);
for (const file of files) {
  if (file.endsWith('.js')) {
    fs.copyFileSync(
      path.join(srcDir, file),
      path.join(distDir, file)
    );
    console.log(`Copied ${file}`);
  }
}

// Create icons directory if it doesn't exist
const iconsDir = path.join(distDir, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
  console.log('Created icons directory');

  // Create placeholder icons
  createPlaceholderIcon(path.join(iconsDir, 'icon-16.png'), 16);
  createPlaceholderIcon(path.join(iconsDir, 'icon-48.png'), 48);
  createPlaceholderIcon(path.join(iconsDir, 'icon-128.png'), 128);
}

console.log('Build complete! Output in:', distDir);
console.log('\nTo load the extension in Chrome:');
console.log('1. Open chrome://extensions/');
console.log('2. Enable "Developer mode"');
console.log('3. Click "Load unpacked"');
console.log('4. Select the', distDir, 'directory');

/**
 * Create a simple placeholder SVG icon
 */
function createPlaceholderIcon(filePath, size) {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#667eea"/>
  <text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="white" font-family="sans-serif" font-size="${size/2}">H</text>
</svg>`;
  
  fs.writeFileSync(filePath, svg);
}
