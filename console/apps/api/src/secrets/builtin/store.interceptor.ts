// Scopes the embedded Vault controllers to the built-in store (E37.5, #594).
//
// It does three things for a request that reaches the `SecretsController` of `@marinoscar/vault-api` (matched by
// class, so nothing else in the console is touched; step 2 also covers Vault's `SecretTypesController`):
//
//   1. loads the caller's data key for the duration of the handler (store.context.ts), creating one on the first
//      write, so the synchronous crypto port can encrypt and decrypt;
//   2. refuses (404, as if the route did not exist) the parts of Vault that are NOT part of the built-in store:
//      the zip export, card and document summaries and renewal, and attachments. The controller class is Vault's and mounts them
//      all; the store holds logins only. A handler that is in neither the denied nor the served list (a route a newer
//      Vault package adds) is refused too, on both Vault controllers, until it is classified (#918);
//   3. limits `POST /secrets` to the `Credential` type (every other type is Vault's).
//
// The interceptor is the console's own (an `APP_INTERCEPTOR` of the store module), not an edit of the package.
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { SecretTypesController } from '@marinoscar/vault-api/secret-types';
import { SecretsController } from '@marinoscar/vault-api/secrets';
import type { FastifyRequest } from 'fastify';
import { from, map, Observable, switchMap } from 'rxjs';
import { SERVICE_KEY_TYPE_NAME } from '@marinoscar/vault-contract/secret-types';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretsStoreKeys } from './store.data-keys';

/** Handler names of Vault's `SecretsController` that the built-in store does not offer. */
export const STORE_DENIED_HANDLERS: ReadonlySet<string> = new Set(['exportSecrets', 'cardSummary', 'documentSummary', 'renew', 'linkAttachment', 'findAttachments', 'unlinkAttachment']);

/**
 * Handler names of Vault's `SecretsController` that the built-in store serves (#918). Every handler of the controller is in
 * exactly one of the two lists (`secrets-store-module.spec.ts` checks it against the installed package); a handler in
 * neither, such as a route a newer Vault package adds, answers 404 until someone decides.
 */
export const STORE_SERVED_HANDLERS: ReadonlySet<string> = new Set([
  'create',
  'findAll',
  'findByName',
  'findOne',
  'totp',
  'update',
  'updateAgentAccess',
  'remove',
  'findVersions',
  'findVersion',
  'rollback',
]);

/** Handler names of Vault's `SecretTypesController` that the store serves; any other answers 404 (#918). */
export const STORE_SERVED_TYPE_HANDLERS: ReadonlySet<string> = new Set(['create', 'findAll', 'findOne', 'update', 'remove']);

export const STORE_SECRET_TYPE = 'Credential';

/** `GET /api/secret-types` without the system types the owner does not create on the page (the `Service Key` type, E50.3). */
function withoutHiddenTypes(r: unknown): unknown {
  const doc = r as { data?: unknown } | null;
  if (!doc || !Array.isArray(doc.data)) return r;
  return { ...doc, data: (doc.data as { name?: unknown; isSystem?: unknown }[]).filter((t) => !(t.isSystem === true && t.name === SERVICE_KEY_TYPE_NAME)) };
}

interface RequestWithUser extends FastifyRequest {
  user?: { id?: string };
}

@Injectable()
export class SecretsStoreInterceptor implements NestInterceptor {
  constructor(
    private readonly keys: SecretsStoreKeys,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler().name;
    // Secret types hold no value and need no key scope; only the handlers the store decided to serve are reachable.
    if (context.getClass() === SecretTypesController) {
      if (!STORE_SERVED_TYPE_HANDLERS.has(handler)) throw new NotFoundException();
      // The `Service Key` type (E50.3) is the console's own: it writes those items when the owner moves a key here. The owner's
      // page offers the Credential type only, so it is left out of the list (a create of it is refused below anyway).
      if (handler === 'findAll') return next.handle().pipe(map((r: unknown) => withoutHiddenTypes(r)));
      return next.handle();
    }
    if (context.getClass() !== SecretsController) return next.handle();

    // Fail closed: a denied handler, and one in neither list (a route a newer Vault package adds), are as if absent.
    if (STORE_DENIED_HANDLERS.has(handler) || !STORE_SERVED_HANDLERS.has(handler)) throw new NotFoundException();
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userId = request.user?.id;
    // An unauthenticated request never gets here (the guard ran first); a request with no user is left to fail there.
    if (!userId) return next.handle();
    const write = request.method !== 'GET' && request.method !== 'HEAD';
    const isCreate = context.getHandler().name === 'create';
    const body = request.body as { typeId?: unknown } | undefined;

    return from(this.prepare(userId, write, isCreate ? body?.typeId : undefined)).pipe(
      switchMap(
        (loaded) =>
          new Observable<unknown>((subscriber) => {
            // The handler runs on subscription: subscribe INSIDE the scope so it inherits it. A failure of the scope itself
            // (the owner's key cannot be unwrapped) must reach the caller, not leave the request hanging.
            loaded
              .run(
                () =>
                  new Promise<void>((resolve) => {
                    next.handle().subscribe({
                      next: (v) => subscriber.next(v),
                      error: (e) => {
                        subscriber.error(e);
                        resolve();
                      },
                      complete: () => {
                        subscriber.complete();
                        resolve();
                      },
                    });
                  }),
              )
              .catch((e: unknown) => subscriber.error(e));
          }),
      ),
    );
  }

  /** Checks the type of a create, loads the key, and returns the runner that holds the scope. */
  private async prepare(userId: string, write: boolean, typeId: unknown): Promise<{ run: (fn: () => Promise<void>) => Promise<void> }> {
    if (typeId !== undefined) {
      const type = typeof typeId === 'string' ? await this.prisma.secretType.findUnique({ where: { id: typeId }, select: { name: true, isSystem: true } }) : null;
      if (!type || !type.isSystem || type.name !== STORE_SECRET_TYPE) throw new UnprocessableEntityException(`The built-in store holds ${STORE_SECRET_TYPE} items (saved logins) only.`);
    }
    return { run: (fn) => this.keys.scope(userId, { create: write }, fn) };
  }
}
