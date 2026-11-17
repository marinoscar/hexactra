/**
 * Settings → Android app (`/settings/android-app`, #301): download and install
 * the Android app from this console, as in EvoPath.
 *
 * The APK this server hosts (published with `hexactra android release` or on
 * Administration → Android app): its version, release date, size and notes,
 * a Download button, how to install it, and its SHA-256 to check the file
 * against. Inside the app itself it says whether the installed build is
 * current. With nothing published yet it says so, and tells an administrator
 * how to publish one.
 *
 * Ungated on purpose: `GET /api/android-app/releases/latest` and
 * `POST /api/android-app/releases/:id/download-link` are `@Auth()` with no
 * permission, so every signed-in user may install the app; the card in
 * `slices/android-app.tsx` declares no permission for that reason.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Card, CardContent, IconButton, Link, Skeleton, Snackbar, Stack, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { getInstalledAppVersion, isRunningInTwa, useAndroidRelease, type InstalledAppVersion, type PublicRelease } from '@marinoscar/platform-web/android-app/headless';
import { DownloadApkButton } from '@marinoscar/platform-web/android-app/ui';

import { PageContainer, PageHeader } from '../ui';

/** Mirrors the `Android app` card in `slices/android-app.tsx`, word for word. */
export const ANDROID_DOWNLOAD_PATH = '/settings/android-app';
export const ANDROID_DOWNLOAD_TITLE = 'Android app';
export const ANDROID_DOWNLOAD_DESCRIPTION = 'Download and install the Android app to control your agents and get their notifications on your phone.';

export const NO_RELEASE_MESSAGE = 'No Android app has been published on this server yet.';

/** The install steps; the last one is followed by this server's address. */
export function installSteps(appName: string): readonly string[] {
  return [
    'On your Android phone, open this page and tap Download APK. When Android asks, allow installing apps from your browser.',
    'Open the downloaded file and tap Install (or Update).',
    `Open ${appName} and sign in. If it asks for a server address, enter:`,
    'Allow notifications when asked: that is how you hear when an agent needs you.',
  ];
}

function formatSize(bytes: string): string {
  const n = Number(bytes);
  return Number.isFinite(n) ? `${(n / (1024 * 1024)).toFixed(1)} MB` : '';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function InstalledStatus({ installed, release }: { installed: InstalledAppVersion; release: PublicRelease }) {
  const label = installed.versionName ?? `build ${installed.versionCode}`;
  if (installed.versionCode >= release.versionCode) {
    return (
      <Alert severity="success" data-testid="installed-up-to-date">
        Installed version {label}: up to date.
      </Alert>
    );
  }
  return (
    <Alert severity="warning" data-testid="installed-update-available">
      Update available: {release.versionName}. You have {label}.
    </Alert>
  );
}

function Checksum({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
    } catch {
      // Clipboard blocked: the value stays selectable on screen.
    }
  };
  return (
    <Box>
      <Typography variant="subtitle2" component="h3">
        SHA-256 checksum
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box component="code" data-testid="release-sha256" sx={{ fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere', flex: 1, minWidth: 0, pt: 1 }}>
          {sha}
        </Box>
        <Tooltip title="Copy checksum">
          <IconButton aria-label="Copy checksum" onClick={() => void copy()}>
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Snackbar open={copied} autoHideDuration={2000} onClose={() => setCopied(false)} message="Checksum copied" />
    </Box>
  );
}

function ReleaseCards({ release, installed, appName, navigate }: { release: PublicRelease; installed: InstalledAppVersion | null; appName: string; navigate?: (url: string) => void }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const steps = installSteps(appName);
  return (
    <Stack spacing={2}>
      {installed && <InstalledStatus installed={installed} release={release} />}
      <Card variant="outlined" component="section" aria-labelledby="android-release-title">
        <CardContent>
          <Typography variant="h6" component="h2" id="android-release-title">
            Version {release.versionName}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Released {formatDate(release.createdAt)} · {formatSize(release.sizeBytes)} · build {release.versionCode}
          </Typography>
          {release.notes && (
            <Typography variant="body2" sx={{ mb: 2, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
              {release.notes}
            </Typography>
          )}
          <DownloadApkButton release={release} navigate={navigate} />
        </CardContent>
      </Card>
      <Card variant="outlined" component="section" aria-labelledby="android-install-title">
        <CardContent>
          <Typography variant="h6" component="h2" id="android-install-title" gutterBottom>
            Install it
          </Typography>
          <Box component="ol" sx={{ m: 0, pl: 3 }} aria-label="Install steps">
            {steps.map((step, index) => (
              <Typography component="li" variant="body2" key={step} sx={{ mb: 0.5 }}>
                {step}
                {index === 2 && origin && (
                  <>
                    {' '}
                    <Box component="code" sx={{ overflowWrap: 'anywhere' }}>
                      {origin}
                    </Box>
                  </>
                )}
              </Typography>
            ))}
          </Box>
          <Box sx={{ mt: 2 }}>
            <Checksum sha={release.fileSha256} />
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}

export interface AndroidAppDownloadPageProps {
  /** The app's name on the phone (identity.json). */
  appName: string;
  /** The TWA session-storage prefix, to read the installed build. */
  storagePrefix?: string;
  /** Where the download navigates; tests pass a spy. */
  navigate?: (url: string) => void;
}

export function AndroidAppDownloadPage({ appName, storagePrefix, navigate }: AndroidAppDownloadPageProps) {
  const { release, isLoading, error } = useAndroidRelease();
  const { viewer } = usePlatformHost();
  const [installed] = useState(() => (isRunningInTwa(storagePrefix) ? getInstalledAppVersion(storagePrefix) : null));
  const canPublish = viewer.hasPermission('system_settings:write');

  let body;
  if (isLoading && !release) {
    body = <Skeleton variant="rounded" height={200} data-testid="android-app-loading" />;
  } else if (error && !release) {
    body = <Alert severity="error">{error}</Alert>;
  } else if (!release) {
    body = (
      <Alert severity="info" data-testid="no-release">
        {NO_RELEASE_MESSAGE}{' '}
        {canPublish ? (
          <>
            Publish one with <code>hexactra android release</code>, or upload an APK on{' '}
            <Link component={RouterLink} to="/admin/settings/android">
              Administration → Android app
            </Link>
            .
          </>
        ) : (
          'Ask your administrator to publish it.'
        )}
      </Alert>
    );
  } else {
    body = <ReleaseCards release={release} installed={installed} appName={appName} navigate={navigate} />;
  }

  return (
    <PageContainer>
      <PageHeader title={ANDROID_DOWNLOAD_TITLE} subtitle={ANDROID_DOWNLOAD_DESCRIPTION} />
      {body}
    </PageContainer>
  );
}

export default AndroidAppDownloadPage;
