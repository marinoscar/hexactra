import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

// The deployment switch of "Improve this task" (E52.8, #1023): `taskImprover.enabled`, on by default. Off: every route is a 404 and
// the web shows no button. It runs only when an owner asks; nothing runs in the background.

export const taskImproverSettingsSchema = z.object({ enabled: z.boolean() });
export type TaskImproverSettings = z.infer<typeof taskImproverSettingsSchema>;
const patchSchema = taskImproverSettingsSchema.partial();

export const TASK_IMPROVER_SYSTEM_SETTINGS = {
  key: 'taskImprover',
  description: 'Improve this task: whether owners can ask an AI to propose a better goal from their runs.',
  storedSchema: taskImproverSettingsSchema,
  patchSchema,
  putSchema: taskImproverSettingsSchema,
  wirePatchSchema: patchSchema,
  responseSchema: taskImproverSettingsSchema,
  defaults: { enabled: true },
  requiredOnPut: false,
  merge: (current, patch) => ({ enabled: patch?.enabled ?? current.enabled }),
} satisfies SystemSettingsNamespace<'taskImprover', TaskImproverSettings, Partial<TaskImproverSettings>>;

registerSystemSettingsNamespaces([TASK_IMPROVER_SYSTEM_SETTINGS as SystemSettingsNamespace]);

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    taskImprover: TaskImproverSettings;
  }
}
