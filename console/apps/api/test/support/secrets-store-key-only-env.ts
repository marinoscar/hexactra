// A deployment with a store KEY and no on/off variable (#711): the store is mounted, and switched on only in the admin panel.
// IMPORT THIS FIRST: `AppModule` decides whether to mount the store when it is imported. Invented test key only.
export const TEST_STORE_KEY = Buffer.alloc(32, 0x5a).toString('base64');

delete process.env.SECRETS_STORE_ENABLED;
process.env.SECRETS_STORE_KEY = TEST_STORE_KEY;
delete process.env.SECRETS_STORE_KEY_PREVIOUS;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
