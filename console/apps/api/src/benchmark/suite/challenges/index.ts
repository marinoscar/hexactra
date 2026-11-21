// The challenges of the suite, in the order a benchmark lists and runs them (E44.2, #740). A new challenge is one file here, added to
// this list; `registry.ts` reads it.
import type { Challenge } from '../types';
import { dynDelayed } from './dyn-delayed';
import { dynModal } from './dyn-modal';
import { extractInfiniteScroll } from './extract-infinite-scroll';
import { extractTable } from './extract-table';
import { formMultistep } from './form-multistep';
import { formSelectDate } from './form-select-date';
import { navLookup } from './nav-lookup';
import { navNewTab } from './nav-new-tab';
import { navPagination } from './nav-pagination';
import { navSpa } from './nav-spa';

export const CHALLENGES: readonly Challenge[] = [navLookup, navSpa, navPagination, navNewTab, formMultistep, formSelectDate, extractTable, extractInfiniteScroll, dynDelayed, dynModal];
