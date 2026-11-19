// "Save this login?" (E37.4b): what the question broker needs of the secrets module to carry out the owner's answer.
//
// The broker owns the question (its card, its channel rules, its single winning answer); the secrets module owns the
// provider and the fabric call. The module registers its handler here on start (`QuestionsService.useSaveLogin`), so the broker
// does not depend on it and a deployment without the secrets slices simply never makes such a question. Nothing here carries
// the password: it is in the fabric's memory and goes from there to the provider.
import type { SaveLoginProposal } from './questions.contract';

/** Why a save did not happen, in the words the card shows. */
export type SaveLoginErrorCode = 'SAVE_TOO_LATE' | 'SAVE_NAME_TAKEN' | 'SAVE_RECONNECT' | 'SAVE_DISABLED' | 'SAVE_UNAVAILABLE' | 'SAVE_REFUSED';

/** What the owner reads when the password is no longer held. */
export const SAVE_TOO_LATE_TEXT = 'Too late to save this time; it will be offered at the next sign-in.';

/** The HTTP status each failure answers with. */
export const SAVE_ERROR_STATUS: Record<SaveLoginErrorCode, number> = {
  SAVE_TOO_LATE: 409,
  SAVE_NAME_TAKEN: 409,
  SAVE_RECONNECT: 409,
  SAVE_DISABLED: 409,
  SAVE_UNAVAILABLE: 503,
  SAVE_REFUSED: 422,
};

/** A save that did not happen. `message` is for the owner and carries no value. */
export class SaveLoginError extends Error {
  constructor(
    readonly code: SaveLoginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SaveLoginError';
  }
}

/** Carries out the owner's answer to a "Save this login?" card. */
export interface SaveLoginPort {
  /**
   * Ask the provider to save the sign-in under `name` (the owner's edit). The fabric sends the password it still holds; the
   * console never has it. Throws {@link SaveLoginError}.
   */
  save(userId: string, proposal: SaveLoginProposal, name: string, ctx: { questionId: string; runId: string | null }): Promise<{ itemId: string | null }>;
  /** Remember "Never for this site" for the owner and the registrable domain. */
  never(userId: string, domain: string): Promise<void>;
}
