// The families of the browser toolset (E41.2, #699): the browser and the desktop, each with what it is for and its own how-to. The how-to
// is emitted only when the family is offered, so a run with no browser reads none of it. The words are the prompt: a change is a change of
// what the agent does and needs its own issue.
import type { ToolFamily } from '@marinoscar/hexactra-agent';

/** How the agent sees a page (moved unchanged from the browser instructions). */
export const HOW_TO_SEE = `How to see:
- A round may start with a screenshot of the page, with interactive elements boxed and numbered, and their positions listed. Use it to understand the layout, what is visible, and what changed.
- observe_elements lists interactive elements with CSS selectors; read_text reads the page text. Use them for exact targets and content.
- look takes a fresh screenshot (screen "desktop" shows the whole computer screen). It ends your turn; the next turn starts with the image.`;

/** How the agent acts on a page (moved unchanged, without the desktop bullet: the desktop is its own family). */
export const HOW_TO_ACT = `How to act (choose what works, as a person would):
- By element: click and type_text with selectors, or click_mark with a number from the screenshot.
- By position, with real mouse and keyboard events: click_at, hover_at, drag, scroll_at, type_keys, key. Use them for canvas, custom widgets, hover menus, sliders, drag and drop, and whenever a selector click does nothing.
- run_javascript runs any JavaScript in the page and returns its value: read state, fill complex forms, call the page's own functions, or get past a stubborn widget.
- Tabs: tabs, switch_tab, new_tab. navigate opens any URL.
- Check the result of each action before the next one. If something does not work, try another way before giving up.`;

/** Outside the page: the desktop's own short section, the bullet the act section used to carry, word for word. */
export const OUTSIDE_THE_PAGE = `- Outside the page (native file pickers, OS dialogs, permission prompts, other windows): look at the desktop, then desktop_click, desktop_type, desktop_key, desktop_scroll, desktop_drag.`;

export const browserFamily: ToolFamily = {
  id: 'browser',
  title: 'The browser',
  whenToUse: 'A real Chrome browser signed in as the owner. Use it for anything that lives on a website and that no account or added tool covers.',
  rank: 50,
  sections: [HOW_TO_SEE, HOW_TO_ACT],
};

export const desktopFamily: ToolFamily = {
  id: 'desktop',
  title: 'The desktop',
  whenToUse: 'The screen, mouse and keyboard of the computer the browser runs on. Use it only for what is outside the page: native file pickers, system dialogs, permission prompts.',
  rank: 60,
  sections: [OUTSIDE_THE_PAGE],
};

/** The families of this toolset, for a host to register. */
export const browserFamilies: readonly ToolFamily[] = [browserFamily, desktopFamily];
