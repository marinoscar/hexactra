// Scopes the embedded Vault controllers to the built-in store (E37.5, #594).
//
// It does three things for a request that reaches the `SecretsController` of `@marinoscar/vault-api` (matched by
// class, so nothing else in the console is touched):
//
//   1. loads the caller's data key for the duration of the handler (store.context.ts), creating one on the first
//      write, so the synchronous crypto port can encrypt and decrypt;
//   2. refuses (404, as if the route did not exist) the parts of Vault that are NOT part of the built-in store:
//      the zip export, card and document summaries and renewal, and attachments. The controller class is Vault's and mounts them
//      all; the store holds logins only;
//   3. limits `POST /secrets` to the `Credential` type (every other type is Vault's).
//
// The interceptor is the console's own (an `APP_INTERCEPTOR` of the store module), not an edit of the package.
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { SecretsController } from '@marinoscar/vault-api/secrets';
import type { FastifyRequest } from 'fastify';
import { from, Observable, switchMap } from 'rxjs';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretsStoreKeys } from './store.data-keys';

/** Handler names of Vault's `SecretsController` that the built-in store does not offer. */
export const STORE_DENIED_HANDLERS: ReadonlySet<string> = new Set(['exportSecrets', 'cardSummary', 'documentSummary', 'renew', 'linkAttachment', 'findAttachments', 'unlinkAttachment']);

export const STORE_SECRET_TYPE = 'Credential';

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
    // Only Vault's secrets controller needs a key scope; secret types hold no value.
    if (context.getClass() !== SecretsController) return next.handle();

    if (STORE_DENIED_HANDLERS.has(context.getHandler().name)) throw new NotFoundException();
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
