/** The types a task output may have (E39.5, #600). The first five are the task parameter types it shares. */
export type TaskOutputType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'url' | 'choice';

/** An output's definition, stored on the task (`tasks.outputs`) and copied onto each run (`runs.outputs_spec`). */
export interface TaskOutput {
  key: string;
  label: string;
  type: TaskOutputType;
  required: boolean;
  options?: string[];
  help?: string;
  sensitive?: boolean;
}

export interface MoneyValue {
  amount: number;
  currency: string | null;
}

export type OutputValue = string | number | boolean | MoneyValue | null;

/** One stored output value (`runs.outputs`, by key). */
export interface StoredOutput {
  value: OutputValue;
  ok: boolean;
  note?: string;
}

export declare const OUTPUT_TYPES: readonly TaskOutputType[];
export declare const MAX_OUTPUTS: number;
export declare const MAX_OUTPUT_KEY_LENGTH: number;
export declare const MAX_OUTPUT_LABEL_LENGTH: number;
export declare const MAX_OUTPUT_HELP_LENGTH: number;
export declare const MAX_OUTPUT_TEXT_LENGTH: number;
/** What a sensitive output reads as wherever a person, an export or a hosted AI app sees it. */
export declare const MASKED_OUTPUT: string;
/** How many times `finish` is refused for a missing or invalid output before the run finishes with what it has. */
export declare const MAX_OUTPUT_ATTEMPTS: number;

export declare function outputKey(label: string): string;
export declare function parseLocalizedNumber(text: string): number | null;
export declare function parseMoney(text: string): MoneyValue | null;
export declare function parseDateText(text: string): { value: string; error?: undefined } | { error: string; value?: undefined };
export declare function parseDateTimeText(text: string): { value: string; error?: undefined } | { error: string; value?: undefined };
export declare function parseOutputValue(
  def: Pick<TaskOutput, 'type'> & Partial<Pick<TaskOutput, 'options'>>,
  raw: unknown,
): { ok: true; value: Exclude<OutputValue, null>; missing?: undefined; error?: undefined } | { ok: false; missing?: true; error: string; value?: undefined };
export declare function outputDefinitionProblems(defs: readonly Partial<TaskOutput>[] | null | undefined): { key: string; message: string }[];
export declare function parseOutputs(
  defs: readonly TaskOutput[],
  raw: unknown,
): { fields: Record<string, StoredOutput>; problems: { key: string; message: string }[]; complete: boolean };
export declare function formatOutputValue(def: Pick<TaskOutput, 'type'> | null | undefined, value: OutputValue | undefined): string;
