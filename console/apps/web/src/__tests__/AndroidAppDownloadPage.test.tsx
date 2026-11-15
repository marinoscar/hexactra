// Settings → Android app (#301): any signed-in person downloads the app the
// console hosts, sees how to install it and its checksum; inside the app it
// says whether an update is waiting; with nothing published it says so.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MenuList } from '@mui/material';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { twaSessionKeys } from '@marinoscar/platform-web/android-app/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANDROID_DOWNLOAD_DESCRIPTION, ANDROID_DOWNLOAD_TITLE, AndroidAppDownloadPage } from '../pages/AndroidAppDownloadPage';
import { ANDROID_IDENTITY, androidAppWebSlice } from '../slices/android-app';

/** The API answers 404 NO_RELEASE when nothing is published. */
const noRelease = () => {
  throw createTestApiError(404, 'No release', 'NO_RELEASE');
};

const RELEASE = {
  id: '11111111-1111-4111-8111-111111111111',
  packageName: 'com.example.app',
  versionName: '1.4.0',
  versionCode: 14,
  fileSha256: 'a'.repeat(64),
  sizeBytes: String(6 * 1024 * 1024),
  notes: 'Reminders before a request expires.',
  createdAt: '2026-11-15T12:00:00.000Z',
};
const PREFIX = 'test-app';

function renderPage(permissions: string[] = [], responses: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      'GET /android-app/releases/latest': RELEASE,
      [`POST /android-app/releases/${RELEASE.id}/download-link`]: { url: 'https://console.example.test/api/android-app/download/tok', expiresAt: '2026-11-15T12:10:00.000Z' },
      ...responses,
    },
  });
  const navigate = vi.fn();
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>
        <AndroidAppDownloadPage appName="Example" storagePrefix={PREFIX} navigate={navigate} />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return { host, navigate };
}

afterEach(() => sessionStorage.clear());

describe('AndroidAppDownloadPage', () => {
  it('shows the published release, how to install it and its checksum; Download fetches a signed link', async () => {
    const { navigate } = renderPage();
    expect(await screen.findByText('Version 1.4.0')).toBeInTheDocument();
    expect(screen.getByText(/6\.0 MB · build 14/)).toBeInTheDocument();
    expect(screen.getByText('Reminders before a request expires.')).toBeInTheDocument();
    expect(screen.getByTestId('release-sha256')).toHaveTextContent('a'.repeat(64));
    expect(screen.getByRole('list', { name: 'Install steps' })).toHaveTextContent(window.location.origin);
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://console.example.test/api/android-app/download/tok'));
  });

  it('with nothing published, says so; an administrator is told how to publish', async () => {
    const none = { 'GET /android-app/releases/latest': noRelease };
    renderPage([], none);
    expect(await screen.findByTestId('no-release')).toHaveTextContent('Ask your administrator to publish it.');
  });

  it('tells an administrator where to publish', async () => {
    renderPage(['system_settings:write'], { 'GET /android-app/releases/latest': noRelease });
    expect(await screen.findByTestId('no-release')).toHaveTextContent('hexactra android release');
    expect(screen.getByRole('link', { name: /Administration → Android app/ })).toHaveAttribute('href', '/admin/settings/android');
  });

  it('inside the app: up to date, or an update is waiting', async () => {
    const keys = twaSessionKeys(PREFIX);
    sessionStorage.setItem(keys.launched, '1');
    sessionStorage.setItem(keys.versionName, '1.3.0');
    sessionStorage.setItem(keys.versionCode, '13');
    renderPage();
    expect(await screen.findByTestId('installed-update-available')).toHaveTextContent('Update available: 1.4.0. You have 1.3.0.');
  });

  it('inside the app with the current build: up to date', async () => {
    const keys = twaSessionKeys(PREFIX);
    sessionStorage.setItem(keys.launched, '1');
    sessionStorage.setItem(keys.versionCode, '14');
    renderPage();
    expect(await screen.findByTestId('installed-up-to-date')).toBeInTheDocument();
  });
});

describe('the Android app card and route', () => {
  it('is a per-user card with no permission, word for word the page', () => {
    const cards = (androidAppWebSlice.userCards ?? []).flatMap((g) => g.cards);
    expect(cards).toEqual([expect.objectContaining({ title: ANDROID_DOWNLOAD_TITLE, description: ANDROID_DOWNLOAD_DESCRIPTION, path: '/settings/android-app' })]);
    expect(cards[0]).not.toHaveProperty('permission');
    const route = androidAppWebSlice.routes!.find((r) => r.path === 'settings/android-app');
    expect(route).toBeDefined();
    expect(route!.permission).toBeUndefined();
  });

  it('offers "Get the Android app" in the user menu, but not inside the app', () => {
    const item = androidAppWebSlice.userMenuItems![0];
    const menu = () => (
      <MemoryRouter>
        <MenuList>{item(() => undefined)}</MenuList>
      </MemoryRouter>
    );
    const { unmount } = render(menu());
    expect(screen.getByText('Get the Android app')).toBeInTheDocument();
    unmount();
    sessionStorage.setItem(twaSessionKeys(ANDROID_IDENTITY.storagePrefix).launched, '1');
    render(menu());
    expect(screen.queryByText('Get the Android app')).not.toBeInTheDocument();
  });
});
