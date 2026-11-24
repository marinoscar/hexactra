// The built-in secrets store in the unit tier (#918). A Vault upgrade once added a constructor dependency to Vault's
// `SecretsController` (`DocumentSummaryService`, 0.1.0-next.6) and a route; the API did not boot, and only the DB tier
// and the VPS stack job noticed, because no unit spec mounted the store. This one does.
//
// IMPORT FIRST: the store env must exist before `AppModule` is loaded (it decides at import time whether to mount the store).
import './support/secrets-store-env';

import { CallHandler, ExecutionContext, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SecretTypesController } from '@marinoscar/vault-api/secret-types';
import { SecretsController } from '@marinoscar/vault-api/secrets';
import { of } from 'rxjs';

import { AppModule } from '../src/app.module';
import { SecretsStoreInterceptor, STORE_DENIED_HANDLERS, STORE_SERVED_HANDLERS, STORE_SERVED_TYPE_HANDLERS } from '../src/secrets/builtin/store.interceptor';

/** The handler names a controller class declares, from the installed package. */
function handlersOf(cls: { prototype: object }): string[] {
  return Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== 'constructor' && typeof (cls.prototype as Record<string, unknown>)[n] === 'function');
}

describe('the built-in secrets store mounted in the app', () => {
  it('compiles with the store on: every provider the Vault controllers need is there', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    try {
      expect(moduleRef.get(SecretsController, { strict: false })).toBeInstanceOf(SecretsController);
      expect(moduleRef.get(SecretTypesController, { strict: false })).toBeInstanceOf(SecretTypesController);
      expect(moduleRef.get(SecretsStoreInterceptor, { strict: false })).toBeInstanceOf(SecretsStoreInterceptor);
    } finally {
      await moduleRef.close();
    }
  }, 60_000);
});

describe('every route of the Vault controllers is a decision', () => {
  it('each SecretsController handler is either served or denied, never both, never neither', () => {
    const handlers = handlersOf(SecretsController);
    expect(handlers.length).toBeGreaterThan(0);
    const undecided = handlers.filter((h) => !STORE_SERVED_HANDLERS.has(h) && !STORE_DENIED_HANDLERS.has(h));
    const both = handlers.filter((h) => STORE_SERVED_HANDLERS.has(h) && STORE_DENIED_HANDLERS.has(h));
    expect({ undecided, both }).toEqual({ undecided: [], both: [] });
    // A name in a list that the package no longer has is a stale decision.
    expect([...STORE_SERVED_HANDLERS, ...STORE_DENIED_HANDLERS].filter((h) => !handlers.includes(h))).toEqual([]);
  });

  it('each SecretTypesController handler is served, and the list names nothing the package lacks', () => {
    const handlers = handlersOf(SecretTypesController);
    expect(handlers.filter((h) => !STORE_SERVED_TYPE_HANDLERS.has(h))).toEqual([]);
    expect([...STORE_SERVED_TYPE_HANDLERS].filter((h) => !handlers.includes(h))).toEqual([]);
  });
});

describe('the interceptor fails closed on a route it has not classified', () => {
  const interceptor = new SecretsStoreInterceptor({} as never, {} as never);
  const next: CallHandler = { handle: () => of('served') };
  function contextFor(cls: unknown, handlerName: string): ExecutionContext {
    const handler = { [handlerName]: () => undefined }[handlerName]!;
    return {
      getClass: () => cls,
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ method: 'GET' }) }),
    } as unknown as ExecutionContext;
  }

  it('answers 404 for a SecretsController handler in neither list, and for a denied one', () => {
    expect(() => interceptor.intercept(contextFor(SecretsController, 'brandNewRoute'), next)).toThrow(NotFoundException);
    expect(() => interceptor.intercept(contextFor(SecretsController, 'documentSummary'), next)).toThrow(NotFoundException);
  });

  it('answers 404 for a SecretTypesController handler it does not serve, and passes a served one through', (done) => {
    expect(() => interceptor.intercept(contextFor(SecretTypesController, 'brandNewRoute'), next)).toThrow(NotFoundException);
    interceptor.intercept(contextFor(SecretTypesController, 'findAll'), next).subscribe((v) => {
      expect(v).toBe('served');
      done();
    });
  });

  it('leaves every other controller alone', (done) => {
    class Other {}
    interceptor.intercept(contextFor(Other, 'anything'), next).subscribe((v) => {
      expect(v).toBe('served');
      done();
    });
  });
});
