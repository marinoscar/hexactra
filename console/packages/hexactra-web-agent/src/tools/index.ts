// The web toolset's tools, in the order the model is offered them (the order is part of the cached prompt prefix: never sorted). A host
// registers them with `webFamily` and the `webSiteGate` (E50.7 does it in the console's runner).
import type { RunnerTool } from '@marinoscar/hexactra-agent';
import type { WebContext } from '../context';
import { webFetch } from './web-fetch';
import { webSearch } from './web-search';

export { WEB_SPAN_ATTRS } from './web-search';
export { webFetch, webSearch };

export const webTools: readonly RunnerTool<WebContext>[] = [webSearch, webFetch] as unknown as RunnerTool<WebContext>[];
