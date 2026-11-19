// The credential purpose of deliveries (E39.6, #603). A purpose is the cipher's sub-key domain, so it is PERMANENT once a row exists.
//
//   delivery_webhook   user tier. Name `<deliveryId>`: the signing secret (`whsec_...`) of a `webhook` delivery. Shown once, when the
//                      delivery is created; the receiver verifies the Standard Webhooks signature with it. Deleted with the delivery.
import { Injectable } from '@nestjs/common';
import { UserCredentialsService, type UserCredentialPurposeDef } from '@marinoscar/platform-api/credentials';

export const DELIVERY_WEBHOOK_PURPOSE = 'delivery_webhook';

export const DELIVERY_USER_CREDENTIAL_PURPOSES: readonly UserCredentialPurposeDef[] = [
  {
    purpose: DELIVERY_WEBHOOK_PURPOSE,
    label: 'Delivery webhook signing secrets',
    description: 'The secret that signs the webhook a task calls when a run ends. Shown once when the delivery is created; never shown again.',
    system: null,
  },
];

@Injectable()
export class DeliveryWebhookSecrets {
  constructor(private readonly users: UserCredentialsService) {}

  put(userId: string, deliveryId: string, secret: string): Promise<void> {
    return this.users.setSecret(userId, DELIVERY_WEBHOOK_PURPOSE, deliveryId, secret);
  }

  get(userId: string, deliveryId: string): Promise<string | null> {
    return this.users.getSecret(userId, DELIVERY_WEBHOOK_PURPOSE, deliveryId);
  }

  async has(userId: string, deliveryId: string): Promise<boolean> {
    return (await this.get(userId, deliveryId)) !== null;
  }

  remove(userId: string, deliveryId: string): Promise<void> {
    return this.users.deleteSecret(userId, DELIVERY_WEBHOOK_PURPOSE, deliveryId);
  }
}
