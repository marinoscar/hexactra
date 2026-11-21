// form-upload (E44.7, #745): a PLACEHOLDER. Giving a file to a web form has no browser action yet (#662), so the challenge
// `requires: ['file_upload']`, is reported `unsupported` at the start and is never run. Its page shows the form; the site does not
// read multipart bodies, so nothing can be uploaded and the grader cannot pass. The pull request that adds the capability also
// makes this challenge real (the site reads the file, the grader checks its name and content) and bumps the suite version.
import { html, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Seed, SiteState } from '../types';

const BRAND = 'Document inbox';

export function formUploadPlan(seed: Seed): { fileName: string; content: string } {
  const g = seeded(seed, 'form-upload');
  const code = g.code(6);
  return { fileName: `note-${code.toLowerCase()}.txt`, content: code };
}

function handle(req: SiteRequest): SiteResponse {
  if (req.method !== 'GET' || req.path !== '') return notFound();
  return page({
    title: 'Upload a document',
    brand: BRAND,
    body: html`<form method="post" action="${req.root}upload" enctype="multipart/form-data" class="stack">
        <label for="f-file">Document</label><input id="f-file" name="file" type="file" accept=".txt">
        <div class="row"><button type="submit">Upload</button></div>
      </form>`,
  });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { fileName } = formUploadPlan(seed);
  const uploaded = state.upload !== null && state.upload !== undefined;
  return [{ name: 'file-uploaded', pass: false, detail: uploaded ? 'uploads are not read yet (#662)' : `${fileName} was not uploaded` }];
}

export const formUpload: Challenge = {
  id: 'form-upload',
  title: 'Upload a file to a web form',
  category: 'forms',
  difficulty: 2,
  requires: ['file_upload'],
  setup: () => ({ upload: null }),
  goal: (seed, baseUrl) => {
    const p = formUploadPlan(seed);
    return `Open ${baseUrl}/ and upload a text file named ${p.fileName} that contains the single line ${p.content}.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
