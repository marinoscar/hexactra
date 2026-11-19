// Google's file picker (E39.10, #607). With the narrow `drive.file` permission the console sees only files it created or the owner picked,
// so the delivery editor offers Google's own picker to choose a spreadsheet or folder. The script is loaded ONLY when the owner asks for
// the picker in that dialog (never on another page, never in the background), and the access token it needs comes from
// `POST /api/connections/{id}/picker`, is held in this module's closure for the one call and is never stored.
import type { PickerSession } from './files';

export const PICKER_SCRIPT = 'https://apis.google.com/js/api.js';

export type PickerKind = 'spreadsheet' | 'folder';

export interface PickedFile {
  id: string;
  name: string;
  kind: PickerKind;
}

/** Why the picker did not open: the script was blocked or offline, or the owner has no project key set up. */
export class PickerUnavailable extends Error {
  constructor(readonly reason: 'script' | 'picker' | 'not_configured') {
    super(reason === 'script' ? 'Google\'s picker could not be loaded.' : reason === 'not_configured' ? 'Google\'s picker is not set up for this deployment.' : 'Google\'s picker could not be opened.');
    this.name = 'PickerUnavailable';
  }
}

interface GoogleGlobal {
  picker: {
    PickerBuilder: new () => PickerBuilderLike;
    DocsView: new (viewId?: string) => DocsViewLike;
    ViewId: { SPREADSHEETS: string; FOLDERS: string };
    Action: { PICKED: string; CANCEL: string };
    Response: { ACTION: string; DOCUMENTS: string };
    Document: { ID: string; NAME: string };
  };
}
interface DocsViewLike {
  setIncludeFolders(v: boolean): DocsViewLike;
  setSelectFolderEnabled(v: boolean): DocsViewLike;
  setMimeTypes?(v: string): DocsViewLike;
}
interface PickerBuilderLike {
  addView(v: DocsViewLike): PickerBuilderLike;
  setOAuthToken(t: string): PickerBuilderLike;
  setDeveloperKey(k: string): PickerBuilderLike;
  setAppId(id: string): PickerBuilderLike;
  setCallback(cb: (data: Record<string, unknown>) => void): PickerBuilderLike;
  build(): { setVisible(v: boolean): void };
}
declare global {
  interface Window {
    gapi?: { load(name: string, cb: () => void): void };
    google?: GoogleGlobal;
  }
}

let loading: Promise<void> | null = null;

/** Adds Google's script (once) and loads its picker module. Rejects with {@link PickerUnavailable} when the browser refuses or is offline. */
export function loadGooglePicker(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const fail = () => {
      loading = null;
      reject(new PickerUnavailable('script'));
    };
    const ready = () => {
      if (!window.gapi) return fail();
      window.gapi.load('picker', () => (window.google?.picker ? resolve() : fail()));
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PICKER_SCRIPT}"]`);
    if (existing && window.gapi) return ready();
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', ready, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!existing) {
      script.src = PICKER_SCRIPT;
      script.async = true;
      script.referrerPolicy = 'no-referrer';
      document.head.appendChild(script);
    }
  });
  return loading;
}

/** Opens the picker for one choice. Resolves with the file, or `null` when the owner closed it. */
export async function pickWithGoogle(session: PickerSession, kind: PickerKind, load: () => Promise<void> = loadGooglePicker): Promise<PickedFile | null> {
  if (!session.accessToken) throw new PickerUnavailable('not_configured');
  await load();
  const g = window.google?.picker;
  if (!g) throw new PickerUnavailable('picker');
  return new Promise<PickedFile | null>((resolve) => {
    const view = kind === 'folder' ? new g.DocsView(g.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true) : new g.DocsView(g.ViewId.SPREADSHEETS);
    let builder = new g.PickerBuilder().addView(view).setOAuthToken(session.accessToken);
    if (session.appId) builder = builder.setAppId(session.appId);
    if (session.apiKey) builder = builder.setDeveloperKey(session.apiKey);
    builder
      .setCallback((data) => {
        const action = data[g.Response.ACTION];
        if (action === g.Action.PICKED) {
          const doc = (data[g.Response.DOCUMENTS] as Record<string, unknown>[] | undefined)?.[0];
          resolve(doc ? { id: String(doc[g.Document.ID]), name: String(doc[g.Document.NAME] ?? ''), kind } : null);
        } else if (action === g.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
