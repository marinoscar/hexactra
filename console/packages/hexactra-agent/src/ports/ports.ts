import type { ApprovalPort } from './approvals';
import type { ClockPort, IdPort } from './clock';
import type { ControlPort } from './control';
import type { EventsPort } from './events';
import type { ModelPort } from './model';
import type { PicturePort } from './picture';
import type { PolicyPort } from './policy';
import type { QuestionPort } from './questions';
import type { RunStorePort } from './run-store';
import type { TelemetryPort } from './telemetry';

/** Everything the harness reaches outside itself through, bound once per job by the host. */
export interface Ports {
  model: ModelPort;
  store: RunStorePort;
  questions: QuestionPort;
  control: ControlPort;
  policy: PolicyPort;
  events: EventsPort;
  telemetry: TelemetryPort;
  clock: ClockPort;
  ids: IdPort;
  /** Absent: every gated step asks. */
  approvals?: ApprovalPort;
  /** Absent: no step carries a trace picture. */
  pictures?: PicturePort;
}
