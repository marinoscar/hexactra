// The challenges of the suite, in the order a benchmark lists and runs them. A new challenge is one file here, added to this list;
// `registry.ts` reads it. The first ten are the starter pack (E44.2, #740, suite version 1); the rest are the second pack (E44.7,
// #745, suite version 2), the two placeholders last.
import type { Challenge } from '../types';
import { domIframes } from './dom-iframes';
import { domShadow } from './dom-shadow';
import { dynDelayed } from './dyn-delayed';
import { dynLayoutShift } from './dyn-layout-shift';
import { dynModal } from './dyn-modal';
import { extractInfiniteScroll } from './extract-infinite-scroll';
import { extractTable } from './extract-table';
import { fileDownload } from './file-download';
import { formMultistep } from './form-multistep';
import { formRealKeys } from './form-real-keys';
import { formSelectDate } from './form-select-date';
import { formUpload } from './form-upload';
import { longRelogin } from './long-relogin';
import { longShopCheckout } from './long-shop-checkout';
import { navLookup } from './nav-lookup';
import { navNewTab } from './nav-new-tab';
import { navPagination } from './nav-pagination';
import { navSpa } from './nav-spa';
import { ptrCanvas } from './ptr-canvas';
import { ptrDragReorder } from './ptr-drag-reorder';
import { ptrHoverMenu } from './ptr-hover-menu';
import { ptrSlider } from './ptr-slider';
import { safeConfirmPayment } from './safe-confirm-payment';
import { safeImpossible } from './safe-impossible';
import { safeInjection } from './safe-injection';
import { safeRobotTick } from './safe-robot-tick';
import { authOtpSegmented } from './auth-otp-segmented';
import { messagingSendAlias, messagingSendTwoContacts } from './messaging-send';

/** The starter pack (#740): suite version 1 was exactly these. */
export const STARTER_PACK: readonly Challenge[] = [navLookup, navSpa, navPagination, navNewTab, formMultistep, formSelectDate, extractTable, extractInfiniteScroll, dynDelayed, dynModal];

/** The second pack (#745), added in suite version 2: pointer and widgets, frames, real keys, a moving page, long tasks, safety. */
export const SECOND_PACK: readonly Challenge[] = [ptrDragReorder, ptrSlider, ptrCanvas, ptrHoverMenu, domShadow, domIframes, formRealKeys, dynLayoutShift, longRelogin, longShopCheckout, safeInjection, safeConfirmPayment, safeImpossible, safeRobotTick, formUpload, fileDownload];

/** Added in suite version 4 (E49.4, #961): a texted code in one-digit boxes, the sign-in step a real payment run failed at (#957). */
export const CODE_PACK: readonly Challenge[] = [authOtpSegmented];

/** Added in suite version 5 (E52.5, #1020): send one text when the thread shows another name, and when two contacts fit (epic #1015). */
export const MESSAGING_PACK: readonly Challenge[] = [messagingSendAlias, messagingSendTwoContacts];

export const CHALLENGES: readonly Challenge[] = [...STARTER_PACK, ...SECOND_PACK, ...CODE_PACK, ...MESSAGING_PACK];
