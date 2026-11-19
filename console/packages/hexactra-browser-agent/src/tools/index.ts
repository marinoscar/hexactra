// The browser toolset's tools, in the order the model is offered them. The order is part of the stable prefix the provider caches, so it
// is fixed here and never sorted. The app registers its own tool families (saved logins, memories, ...) between `core` and `typeSecret`
// and before `finish`, exactly where they were offered before the split.
import type { RunnerTool } from '@marinoscar/hexactra-agent';
import type { BrowserContext } from '../context';
import { clickAt, click, clickMark } from './click';
import { desktopClick, desktopDrag, desktopKey, desktopScroll, desktopType } from './desktop';
import { finish } from './finish';
import { look } from './look';
import { goBack, navigate, newTab, switchTab, tabs } from './navigate';
import { observeElements, readText, runJavascript, waitFor } from './observe';
import { drag, hoverAt, scroll, scrollAt } from './pointer';
import { requestHuman } from './request-human';
import { key, pressKey, typeKeys, typeText } from './type';
import { typeHandoffSecret } from './type-secret';

type Tool = RunnerTool<BrowserContext>;

export const browserTools = {
  /** Everything up to and including `request_human`. */
  core: [
    observeElements,
    readText,
    navigate,
    click,
    typeText,
    pressKey,
    scroll,
    waitFor,
    goBack,
    look,
    clickMark,
    clickAt,
    hoverAt,
    drag,
    scrollAt,
    typeKeys,
    key,
    runJavascript,
    tabs,
    switchTab,
    newTab,
    desktopClick,
    desktopType,
    desktopKey,
    desktopScroll,
    desktopDrag,
    requestHuman,
  ] as unknown as Tool[],
  typeSecret: typeHandoffSecret as unknown as Tool,
  finish: finish as unknown as Tool,
};
