// What the task builder never records (E42.3): secret-looking strings in a spec change, and the default of a
// parameter named like a secret. Emails, phone numbers, amounts and dates are ordinary values.
import { scrubSecrets } from '../src/task-builder/task-builder-secrets';

describe('scrubSecrets', () => {
  it('keeps ordinary values', () => {
    const patch = { goal: 'Pay {{Amount}} to the water utility by the 5th', parameters: [{ name: 'Recipient', type: 'email' as const, default: 'person-a@example.test' }, { name: 'Phone', type: 'phone' as const, default: '555-010-6020' }], schedules: [{ cron: '0 9 1 * *', timezone: 'UTC', inputs: { Amount: '25.00' } }] };
    expect(scrubSecrets(patch)).toEqual({ patch, dropped: [] });
  });

  it('drops a card number, an IBAN, an account number and a token wherever they are', () => {
    const { patch, dropped } = scrubSecrets({
      goal: 'Pay with 4111 1111 1111 1111',
      edgeCases: ['Use IBAN GB82WEST12345698765432 if asked', 'Retry once'],
      parameters: [{ name: 'Account', type: 'text', default: 'checking account 123456789012' }],
      sites: ['https://example.test', 'token sk-live-abc123defghijklmnopqrstu'],
    });
    expect(patch).toEqual({ edgeCases: ['Retry once'], parameters: [{ name: 'Account', type: 'text' }], sites: ['https://example.test'] });
    expect(dropped).toEqual(['goal', 'edgeCases[0]', 'parameters[0].default', 'sites[1]']);
  });

  it('drops the default of a parameter named like a secret', () => {
    const { patch, dropped } = scrubSecrets({ parameters: [{ name: 'Bank PIN', type: 'text', default: '1234' }, { name: 'One-time code', type: 'text', memory: 'Bank', attribute: 'code' }, { name: 'Pinecone count', type: 'number', default: '3' }] });
    expect(patch.parameters).toEqual([{ name: 'Bank PIN', type: 'text' }, { name: 'One-time code', type: 'text' }, { name: 'Pinecone count', type: 'number', default: '3' }]);
    expect(dropped).toEqual(['parameters[0].default', 'parameters[1].default']);
  });

  it('leaves null (a clear) alone', () => {
    expect(scrubSecrets({ goal: null, parameters: null })).toEqual({ patch: { goal: null, parameters: null }, dropped: [] });
  });
});
