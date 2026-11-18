/** The input types of a typed question (the REST contract, E26). */
export type QuestionInputType = 'none' | 'text' | 'secret' | 'choice' | 'multi_choice' | 'number' | 'confirm' | 'takeover';

export interface RuleOption {
  id: string;
  label: string;
  description?: string;
}

/** A question's constraints (camelCase, as the REST contract names them). */
export interface RuleConstraints {
  maxLength?: number;
  pattern?: string;
  multiline?: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  minSelections?: number;
  maxSelections?: number;
}

/** The fields of a question the rules read. */
export interface RuleQuestionLike {
  input: QuestionInputType | string;
  risk?: 'low' | 'high' | string | null;
  options?: RuleOption[] | null;
  constraints?: RuleConstraints | null;
  confirmLabel?: string | null;
  denyLabel?: string | null;
}

/** An answer as `POST /api/questions/:id/answer` takes it. */
export interface RuleAnswer {
  outcome: 'completed' | 'cancelled';
  value?: string | number;
  values?: string[];
}

export interface SelectionBounds {
  min: number;
  max: number;
}

/** How a question is answered in an AI app's chat (the MCP Apps question card). */
export type ChatAnswerMode = 'form' | 'acknowledge' | 'signed_in' | 'secret' | 'takeover';

/** Why a number does not fit its constraints, or null (an empty field is not an error yet). */
export declare function numberError(raw: string, c: RuleConstraints | null | undefined): string | null;
/** Why a text answer does not fit its constraints, or null (an empty field is not an error yet). */
export declare function textError(v: string, c: RuleConstraints | null | undefined): string | null;
/** How many options a multi_choice answer must hold. */
export declare function selectionBounds(c: RuleConstraints | null | undefined, optionCount: number): SelectionBounds;
/** Whether `count` picked options are a valid multi_choice answer. */
export declare function selectionOk(count: number, bounds: SelectionBounds): boolean;
/** The instruction above a multi_choice: "Choose 2", "Choose one or more", "Choose between 1 and 3". */
export declare function selectionHelp(bounds: SelectionBounds, optionCount: number): string;
/** The hint under a number field: "min 0 · max 50 · step 0.5", or ''. */
export declare function numberHint(c: RuleConstraints | null | undefined): string;
/** Why an answer is not valid for the question, or null. Declining is always valid. */
export declare function answerError(q: RuleQuestionLike, answer: RuleAnswer): string | null;
/** A secret, or a confirm that is not low risk: only a signed-in channel may record it. */
export declare function needsSignedIn(q: Pick<RuleQuestionLike, 'input' | 'risk'>): boolean;
/** choice, multi_choice, text, number and a low-risk confirm: any channel may collect it. */
export declare function isPublicAnswer(q: Pick<RuleQuestionLike, 'input' | 'risk'>): boolean;
/** How the question is answered in an AI app's chat. */
export declare function chatAnswerMode(q: Pick<RuleQuestionLike, 'input' | 'risk'>): ChatAnswerMode;
/** The answer in words (never a secret). */
export declare function answerLabel(q: RuleQuestionLike, answer: RuleAnswer): string;
