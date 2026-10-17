# Platform Compatibility Matrix

This document describes the cross-platform compatibility of Hexactra host agents and their capabilities.

## Overview

Hexactra supports running browser automation sessions on multiple platforms. Each platform has different capabilities and requirements.

## Supported Platforms

| Platform | Version | Host Agent | Desktop Input | Browser Support |
|----------|---------|------------|---------------|-----------------|
| Linux (x86_64) | Ubuntu 22.04+ | ✅ Full | ✅ X11/Wayland | Chrome, Chromium |
| Windows | 10/11 | ✅ Interactive | ✅ Native | Chrome, Edge |
| macOS | 12+ (Monterey+) | ✅ Interactive | ✅ Accessibility | Chrome, Firefox |

## Platform-Specific Details

### Linux

**Supported Distributions:**
- Ubuntu 22.04 LTS and later
- Debian 12 and later
- Fedora 38 and later

**Requirements:**
- X11 or Wayland display server
- `xdotool` for desktop input (optional, for native input)
- Chrome/Chromium browser installed

**Capabilities:**
- ✅ Interactive sessions (user logged in)
- ✅ Unattended sessions (no user logged in, headless)
- ✅ Virtual display (Xvfb) support
- ✅ Native messaging host registration
- ✅ Screen recording via X11

**Limitations:**
- Requires display server for GUI automation
- No native Windows/macOS session compatibility

### Windows

**Supported Versions:**
- Windows 10 (22H2 and later)
- Windows 11 (all versions)

**Requirements:**
- Chrome browser installed
- User must be logged in (interactive session)
- Accessibility permissions for desktop input

**Capabilities:**
- ✅ Interactive sessions (signed-in user)
- ❌ Session 0 (services) - not supported for GUI automation
- ✅ Native messaging host registration via registry
- ✅ Windows native input APIs

**Limitations:**
- Cannot control logged-out/non-interactive desktop
- Requires active user session for GUI automation
- Registry access required for Chrome Native Messaging

### macOS

**Supported Versions:**
- macOS 12 (Monterey) and later
- macOS 13 (Ventura) and later
- macOS 14 (Sonoma) and later

**Requirements:**
- Chrome/Firefox browser installed
- Screen Recording permission
- Accessibility permission for desktop input

**Capabilities:**
- ✅ Interactive sessions (GUI login)
- ❌ Non-interactive sessions - not supported
- ✅ Launchd agent support
- ✅ Accessibility-based input
- ✅ Native messaging host registration

**Limitations:**
- Requires user permissions for automation
- Cannot control locked screen or login window
- Screen Recording permission required for screenshots

## Browser Support Matrix

| Browser | Linux | Windows | macOS |
|---------|-------|---------|-------|
| Chrome | ✅ Full | ✅ Full | ✅ Full |
| Chromium | ✅ Full | ✅ Full | ⚠️ Limited |
| Firefox | ⚠️ Basic | ⚠️ Basic | ⚠️ Basic |
| Edge | ❌ Not tested | ⚠️ Basic | ❌ Not tested |
| Safari | ❌ Not supported | ❌ Not supported | ⚠️ Basic |

## Desktop Input Drivers

| Driver Type | Linux | Windows | macOS |
|-------------|-------|---------|-------|
| Virtual Display (Xvfb) | ✅ Full | ❌ | ❌ |
| Native Input | ✅ Full | ✅ Full | ⚠️ Accessibility only |
| Accessibility API | ✅ Limited | ✅ Full | ✅ Full |

## IPC Mechanisms

| Platform | IPC Type | Socket Path / Pipe Name |
|----------|----------|------------------------|
| Linux | Unix domain socket | `/run/hexactra/agent.sock` or `/tmp/hexactra-*.sock` |
| Windows | Named pipe | `\\.\pipe\hexactra-control` |
| macOS | Unix domain socket | `/tmp/hexactra-*.sock` |

## Profile Locations

| Platform | Chrome Profile Path |
|----------|---------------------|
| Linux | `~/.config/google-chrome/Default` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\Default` |
| macOS | `~/Library/Application Support/Google/Chrome/Default` |

## Installation

### Linux

```bash
# Install the host agent
sudo apt install ./hexactra-agent_*.deb
# or
sudo dnf install ./hexactra-agent-*.rpm

# Start the service
sudo systemctl enable hexactra-agent
sudo systemctl start hexactra-agent
```

### Windows

```powershell
# Run installer as Administrator
.\hexactra-agent-installer.exe

# The service will be installed and started automatically
```

### macOS

```bash
# Install via pkg installer
sudo installer -pkg hexactra-agent.pkg -target /

# Launchd agent will be loaded automatically
```

## Testing

### Cross-Platform Test Suite

The test suite includes:

1. **Unit Tests** - Platform-specific trait implementations
2. **Integration Tests** - Full browser automation workflows
3. **Negative Tests** - Unsupported operations should fail gracefully

### Running Tests

```bash
# All tests
cargo test --all

# Platform-specific tests
cargo test --target x86_64-unknown-linux-gnu
cargo test --target aarch64-apple-darwin
cargo test --target x86_64-pc-windows-msvc

# Linux-only tests (current platform)
cargo test --package hexactra-agent --platform linux
```

## Error Handling

Unsupported operations return specific error codes:

| Error | Platform | Description |
|-------|----------|-------------|
| `SESSION_NOT_FOUND` | All | No active session detected |
| `GUI_NOT_AVAILABLE` | Windows/macOS | GUI automation not available (logged out/locked) |
| `PERMISSION_DENIED` | macOS | Missing Screen Recording or Accessibility permission |
| `DISPLAY_NOT_FOUND` | Linux | No X11/Wayland display available |
| `SESSION_0_NOT_SUPPORTED` | Windows | Cannot control Session 0 for GUI automation |

## Future Support

Planned platform support:

- **Windows ARM64** - Pending native messaging support
- **macOS ARM64** - Pending Accessibility API testing
- **Linux ARM** - Raspberry Pi 4+ support
- **FreeBSD** - Experimental X11 support

## Security Considerations

1. **Linux**: Host agent runs as unprivileged user, not root
2. **Windows**: Service runs as LocalSystem but uses per-user helpers for GUI
3. **macOS**: Requires explicit user permission grants for automation

See `SECURITY.md` for detailed security requirements.
