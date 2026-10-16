#!/bin/bash
# Install and configure Chrome for Hexactra unattended host

set -e

echo "=== Installing Chrome for Hexactra ==="

# Update package lists
apt-get update

# Install Xvfb for virtual display
echo "Installing Xvfb..."
apt-get install -y xserver-xorg-video-dummy xvfb

# Install Google Chrome
echo "Installing Google Chrome..."
curl -fsSL https://dl.google.com/linux/chrome/deb/google-chrome-stable-current-amd64.deb -o /tmp/google-chrome.deb
dpkg -i /tmp/google-chrome.deb || apt-get install -f -y
rm -f /tmp/google-chrome.deb

# Install additional dependencies for headless Chrome
apt-get install -y \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    x11-utils

# Create service user for Chrome
echo "Creating hexactra-agent user..."
id -u hexactra-agent &>/dev/null || \
    useradd --system --create-home --shell /usr/sbin/nologin hexactra-agent

# Create Chrome profile directories with proper permissions
echo "Setting up Chrome profile directories..."
mkdir -p /var/lib/hexactra/chrome-profiles
chown -R hexactra-agent:hexactra-agent /var/lib/hexactra/chrome-profiles
chmod 750 /var/lib/hexactra/chrome-profiles

# Create runtime directory
mkdir -p /tmp/hexactra-runtime
chown hexactra-agent:hexactra-agent /tmp/hexactra-runtime
chmod 750 /tmp/hexactra-runtime

# Configure Xvfb startup
echo "Configuring Xvfb..."
cat > /etc/systemd/system/xvfb.service << 'EOF'
[Unit]
Description=X Virtual Frame Buffer Service
After=network.target
Documentation=https://github.com/marinoscar/hexactra

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -auth /tmp/xvfb-auth.XXXXXX
Restart=on-failure
RestartSec=5s
Environment=DISPLAY=:99

[Install]
WantedBy=multi-user.target
EOF

# Enable Xvfb service
systemctl daemon-reload || true
systemctl enable xvfb || true

echo "=== Chrome installation complete ==="
echo ""
echo "To start the virtual display:"
echo "  systemctl start xvfb"
echo ""
echo "To verify Chrome is working:"
echo "  DISPLAY=:99 google-chrome --version"
echo ""
echo "To test Chrome in virtual display:"
echo "  DISPLAY=:99 google-chrome --no-sandbox --disable-dev-shm-usage --screenshot /tmp/test.png about:blank"
