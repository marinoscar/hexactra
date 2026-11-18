// The run card's view of its host: the shared bridge (src/shared/bridge.ts)
// limited to the run card's tools.
import type { HostBridge as SharedHostBridge } from './shared/bridge';
import type { AllowedTool } from './model';

export type { HostContextLike } from './shared/bridge';
export type HostBridge = SharedHostBridge<AllowedTool>;
