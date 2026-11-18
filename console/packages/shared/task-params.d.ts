/** The types a task parameter may have (E36.6, #552). */
export type TaskParameterType = 'text' | 'number' | 'money' | 'date' | 'choice' | 'phone' | 'email';

/** A parameter's default: a fixed value, or an attribute of one of the owner's memories (resolved at run time). */
export type TaskParameterDefault = { value: string } | { memory: { id: string; attribute: string } };

export interface TaskParameterConstraints {
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
}

/** A parameter's definition, stored on the task (`tasks.parameters`). */
export interface TaskParameter {
  key: string;
  label: string;
  type: TaskParameterType;
  required: boolean;
  options?: string[];
  help?: string;
  default?: TaskParameterDefault;
  constraints?: TaskParameterConstraints;
  sensitive?: boolean;
}

export interface GoalPlaceholder {
  key: string;
  name: string;
}

export interface GoalError {
  position: number;
  message: string;
}

export type GoalSegment = { text: string } | { key: string; name: string; start: number; end: number };

export declare const MAX_PARAMETERS: number;
export declare const MAX_NAME_LENGTH: number;
export declare const MAX_VALUE_LENGTH: number;
export declare const MAX_PATTERN_LENGTH: number;
export declare const PARAMETER_TYPES: readonly TaskParameterType[];
export declare const MARK_OPEN: string;
export declare const MARK_CLOSE: string;

export declare function paramKey(name: string): string;
export declare function parseGoal(goal: string): { segments: GoalSegment[]; params: GoalPlaceholder[]; errors: GoalError[] };
export declare function parsePlaceholders(goal: string): { params: GoalPlaceholder[]; errors: GoalError[] };
export declare function render(
  goal: string,
  values: Record<string, string | undefined | null>,
  opts?: { mark?: boolean; missing?: (p: GoalPlaceholder) => string; display?: (key: string, value: string) => string },
): string;
export declare function cleanValue(v: string): string;
export declare function patternProblem(pattern: string): string | null;
export declare function todayIn(timeZone?: string | null, now?: Date | number): string;
export declare function formatDate(iso: string): string;
export declare function displayValue(def: Pick<TaskParameter, 'type'> | null | undefined, value: string): string;
export declare function normalizeValue(def: Pick<TaskParameter, 'type' | 'options' | 'constraints'>, raw: unknown, opts?: { timeZone?: string | null; now?: Date | number }): { value: string; error?: undefined } | { error: string; value?: undefined };
export declare function definitionProblems(def: TaskParameter): { key: string; message: string }[];
export declare function reconcileParameters(goal: string, defs: readonly Partial<TaskParameter>[] | null | undefined): { parameters: TaskParameter[]; errors: GoalError[] };
export declare function matchInputKey(parameters: readonly Pick<TaskParameter, 'key' | 'label'>[], name: string): string | null;
