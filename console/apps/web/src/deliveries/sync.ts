// Saving a changed list of deliveries (E39.10, #607): the requests of `planSync`, one after the other, stopping at the first refusal. The
// state it returns is what the server holds NOW (including the requests that did go through), so the form can show what is left to save.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import { planSync, draftFromDelivery, type DeliveryDraft, type TaskDelivery } from './drafts';

export interface CreatedSecret {
  /** Where the signed requests go (the host only). */
  host: string;
  /** `whsec_...`: shown once, here, and never again. */
  secret: string;
}

export interface SyncResult {
  saved: TaskDelivery[];
  drafts: DeliveryDraft[];
  secrets: CreatedSecret[];
  /** The first refusal, with the key of the draft it belongs to; null when everything was saved. */
  error: { key: string | null; cause: unknown } | null;
}

export const listTaskDeliveries = (api: PlatformApiClient, taskId: string) => api.get<TaskDelivery[]>(`/tasks/${taskId}/deliveries`);

const hostOf = (config: Record<string, unknown>): string => {
  try {
    return new URL(String(config.url)).host;
  } catch {
    return 'your web address';
  }
};

export async function syncDeliveries(api: PlatformApiClient, taskId: string, saved: readonly TaskDelivery[], drafts: readonly DeliveryDraft[]): Promise<SyncResult> {
  let now = [...saved];
  let list = [...drafts];
  const secrets: CreatedSecret[] = [];
  for (const op of planSync(saved, drafts)) {
    try {
      if (op.op === 'delete') {
        await api.delete(`/tasks/${taskId}/deliveries/${op.id}`);
        now = now.filter((d) => d.id !== op.id);
      } else if (op.op === 'create') {
        const made = await api.post<TaskDelivery & { signingSecret?: string | null }>(`/tasks/${taskId}/deliveries`, op.body);
        if (made.signingSecret) secrets.push({ host: hostOf(made.config), secret: made.signingSecret });
        const { signingSecret: _secret, ...view } = made;
        now = [...now, view];
        list = list.map((d) => (d.key === op.key ? { ...d, id: view.id, disabledReason: view.disabledReason } : d));
      } else {
        const updated = await api.patch<TaskDelivery>(`/tasks/${taskId}/deliveries/${op.id}`, op.body);
        now = now.map((d) => (d.id === op.id ? updated : d));
      }
    } catch (cause) {
      return { saved: now, drafts: list, secrets, error: { key: op.op === 'delete' ? null : op.key, cause } };
    }
  }
  const order = new Map(list.map((d, i) => [d.id, i]));
  return { saved: [...now].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)), drafts: list, secrets, error: null };
}

export { draftFromDelivery };
