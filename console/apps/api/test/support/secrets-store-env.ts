// Switches the built-in secrets store on for a spec (E37.5, #594). IMPORT THIS FIRST: `AppModule` reads
// `SECRETS_STORE_ENABLED` when it is imported, so the variables must exist before `../src/main` is loaded.
// Invented test keys only (32 bytes of a repeated byte), never a real one.
export const TEST_STORE_KEY = Buffer.alloc(32, 0x5a).toString('base64');
export const TEST_STORE_KEY_2 = Buffer.alloc(32, 0xa5).toString('base64');

process.env.SECRETS_STORE_ENABLED = 'true';
process.env.SECRETS_STORE_KEY = TEST_STORE_KEY;
delete process.env.SECRETS_STORE_KEY_PREVIOUS;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
