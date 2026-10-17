# Chrome Extension Installation Guide

## Prerequisites

- Google Chrome 125 or later (MV3 support required)
- Internet connection

## Installation Methods

### Method 1: Load Unpacked (Development)

1. Open Chrome and navigate to chrome://extensions/
2. Enable Developer mode (top right toggle)
3. Click Load unpacked
4. Select the dist directory from this package
5. Extension should appear in your extensions list

### Method 2: Install from Web Store (Production)

1. Visit the Chrome Web Store
2. Search for Hexactra AI
3. Click Add to Chrome
4. Confirm installation

## Post-Installation Setup

### Configure Native Messaging Host

The extension requires a native messaging host to communicate with Hexactra:

1. Install the Hexactra native host binary (see main README)
2. Copy the native manifest to Chrome's native messaging hosts directory

3. Replace YOUR_EXTENSION_ID_HERE in the manifest with your actual extension ID
4. Restart Chrome

### Configure API Settings

1. Click the Hexactra icon in the Chrome toolbar
2. Go to Settings
3. Configure your API provider (OpenAI, Anthropic, etc.)
4. Set your API key or use a compatible provider

## Usage

### Standalone Mode (No Server)

The extension works standalone with:
- Local AI model configuration
- Built-in chat interface
- Browser automation capabilities

### Connected Mode (With Server)

For full functionality:
1. Start the Hexactra control plane server
2. Configure extension to connect to server
3. Use remote session management
4. Access HITL (Human in the Loop) features

## Troubleshooting

### Extension not loading

- Check Chrome version (must be 125+)
- Verify manifest.json is valid JSON
- Check console for errors (F12 -> Console)

### Native host not found

- Ensure native host binary is installed
- Verify manifest path and extension ID
- Restart Chrome after configuration

### API connection failed

- Verify API key is correct
- Check network connectivity
- Review provider-specific requirements

## Uninstallation

1. Go to chrome://extensions/
2. Find Hexactra AI
3. Click the trash icon
4. (Optional) Remove native host manifest
