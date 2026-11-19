// How a round is shown to the model (#366): the screen, as a person would see it, and the text that goes with it.
import { clip, digest, NO_OBSERVATION, type Observation } from '../harness';
import type { BrowserContext } from './context';
import { shotHash } from './context-settings';
import { roundInput, type ScreenView } from './vision';

/** The notes a run carries when its model takes no images: they name the tools to use instead. */
export const VISION_NOTES = {
  byTier: '(Screenshots are off: the model of this tier does not accept images. Use observe_elements and read_text.)',
  refused: '(Screenshots are off: this model does not accept images. Use observe_elements and read_text.)',
};

/**
 * Takes the screenshot a round starts with, when the model can see it: the page with its numbered elements, or the whole desktop
 * after `look`. A saved detail on screen is covered in the picture and its mark's label is masked (E37.6). A failure is a line in the
 * log, never an error: the round goes on without the picture.
 */
export async function observeRound(ctx: BrowserContext): Promise<Observation> {
  const { memory, ext } = ctx;
  if (memory.visionOff || !ext.shotWindow.enabled) return NO_OBSERVATION;
  await ctx.setActivity('looking');
  const screen = memory.look ?? 'page';
  memory.look = null;
  try {
    // A desktop picture cannot be covered: with a saved detail on the page it is not taken.
    if (screen === 'desktop' && (await ext.masking.anyCoverable())) throw new Error('a saved detail is on the page, and the desktop picture would show it: use the page screenshot');
    const view = await ext.masking.covered(async (covered) => {
      const v = await ext.browser.capture(screen);
      if (screen !== 'page' || covered.length === 0) return v;
      return ext.masking.maskView(v, covered);
    });
    if (screen === 'page') ext.state.marks = new Map(view.marks.map((m) => [m.n, m]));
    ext.state.view = view;
    const images = ext.shotWindow.push(view);
    memory.shots = ext.shotWindow.hashes;
    // The page as the stall detector sees it: a digest of what is on it, never the image (#405).
    const page = screen === 'page' ? { url: view.url, title: view.title, view: view.marks.length ? digest(JSON.stringify(view.marks.map((m) => [m.selector, m.text, m.x, m.y, m.w, m.h]))) : shotHash(view.dataUrl) } : null;
    return { images, page, url: view.url };
  } catch (e) {
    memory.log.push(`(No ${screen} screenshot this round: ${clip(e instanceof Error ? e.message : String(e), 200)})`);
    return NO_OBSERVATION;
  }
}

/** The round's input: the text alone, or the text with the screenshots as image parts. */
export function assembleRoundInput(text: string, observation: Observation, status: string): unknown {
  return roundInput(text, observation.images.length ? (observation.images as ScreenView[]) : null, status);
}

/** The allowed-sites line of the stable prefix. */
export function sitesLine(ctx: BrowserContext): string {
  return `Allowed sites: ${ctx.ext.sites.text || 'any'}.`;
}
