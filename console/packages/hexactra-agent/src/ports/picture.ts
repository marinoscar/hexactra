/** A masked picture of the screen kept for the run's trace (#541). Opaque to the harness. */
export interface Picture {
  shot?: unknown;
  note?: string;
}

/**
 * The trace pictures. Optional: without one no step carries a picture. Guarantees: best effort and bounded (a failure or a timeout
 * leaves the step without a picture and says why); never the model's unmasked screenshot; never during a secret request.
 */
export interface PicturePort {
  capture(moment: string): Promise<Picture>;
  attach(seq: number, moment: string, picture: Picture): Promise<void>;
}
