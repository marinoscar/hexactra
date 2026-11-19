/** Time, so a test passes it without waiting. Guarantee: `now()` never goes backwards within one run. */
export interface ClockPort {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** Ids a tool may need to mint (a reference it hands the model). Guarantee: unique within the run. */
export interface IdPort {
  uuid(): string;
}
