// The OpenTelemetry SDK must be installed before anything that loads Nest (src/instrumentation.ts).
import { sdk } from './instrumentation';
import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { APP_NAME, REPO_URL } from '@app/shared';
import { verifyEncryptionKeyAtStartup } from '@marinoscar/platform-api/core';
import { registerVaultCallbackLogRedaction } from './secrets/secrets.log-redaction';
import { registerRequestSpanAttributes } from '@marinoscar/platform-api/otel-core';
import { buildCorsOptions, isSameOriginOnly, registerPlatformDocs, resolveApiVersion, type PlatformOpenApiOptions } from '@marinoscar/platform-api/host';
import { OAUTH_PUBLIC_CORS_PATHS, verifyTenancyModeAtStartup } from '@marinoscar/platform-api/identity';
import { STORAGE_OPTIONS, simpleUploadFileSizeLimit, type ResolvedStorageModuleOptions } from '@marinoscar/platform-api/storage';

import { AppModule } from './app.module';
import { describeTrustProxy, parseTrustProxy } from './config/trust-proxy';
import { registerMcpTransport } from './mcp/mcp.controller';
import { McpSettingsReader } from './mcp/mcp-settings.reader';
import { MCP_RATE_LIMITER, McpUnauthenticatedLimit, type McpRateLimiter } from './mcp/mcp.rate-limit';
import { McpMetrics } from './mcp/mcp.metrics';
import { isSliceEnabled } from './platform/slices/manifest';
import { PrismaService } from './prisma/prisma.service';

/** The app's identity in the OpenAPI document and on `/api/docs`. */
export const APP_OPENAPI: PlatformOpenApiOptions = {
  appName: APP_NAME,
  repoUrl: REPO_URL,
  version: () => resolveApiVersion(__dirname),
};

/**
 * Builds the application: Fastify, the cookie plugin, the multipart plugin when
 * the storage slice is on, the `/api` prefix, and
 * the API reference (`/api/docs`, `/api/openapi.json`; a generation failure
 * degrades both to a 503, never the boot). Shared by the boot and the db-tier tests.
 */
export async function createApp(): Promise<NestFastifyApplication> {
  // CORS, parsed before anything else so a wildcard or malformed CORS_ORIGIN fails
  // here with its own message. Same-origin only (no CORS headers) unless
  // CORS_ORIGIN lists origins. `openPaths`: the OAuth server's token, register and
  // revoke endpoints and its metadata documents answer ANY origin without
  // credentials (browser-based MCP clients), even under an allowlist; no other
  // route is loosened (#459; the platform's oauth-server spec, §3). `/api/mcp`
  // keeps its own Origin rules (registerMcpTransport, which runs first).
  const corsOptions = buildCorsOptions(process.env.CORS_ORIGIN, { openPaths: OAUTH_PUBLIC_CORS_PATHS });
  // Which proxies are trusted for the caller's address (`request.ip`), from
  // TRUST_PROXY (#530): by default loopback and private ranges, so the stack's
  // nginx forwards the real address and the per-address limits (MCP
  // unauthenticated, the OAuth server's authorize and register) count each
  // caller apart. An invalid value throws here, before anything is built.
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, // `maxParamLength`: the signed links of deliveries (the report link, the unsubscribe link) carry their claims in the path, longer than Fastify's default of 100.
    new FastifyAdapter({ trustProxy, routerOptions: { maxParamLength: 1024 } }), { bufferLogs: false });
  new Logger('Bootstrap').log(`Trusted proxies: ${describeTrustProxy(trustProxy)}`);
  // Route and caller attributes on the HTTP server span (`http.route`, `app.route.matched`),
  // first so it runs ahead of every other hook. Only when the SDK is installed.
  registerRequestSpanAttributes(app.getHttpAdapter().getInstance(), sdk !== null);
  // The MCP endpoint's transport rules (Origin, CORS, 405, 406, JSON-RPC parse errors), ahead of authentication,
  // and the per-address limit of its unauthenticated answers (#465).
  const mcpSettings = app.get(McpSettingsReader);
  const mcpMetrics = app.get(McpMetrics);
  const unauthenticated = new McpUnauthenticatedLimit(
    app.get<McpRateLimiter>(MCP_RATE_LIMITER),
    async () => (await mcpSettings.read()).rateLimitUnauthenticated,
    (client) => mcpMetrics.rateLimited({ keyKind: 'unauthenticated', client }),
  );
  registerMcpTransport(app.getHttpAdapter().getInstance(), app.get(ConfigService).get<string>('appUrl'), { unauthenticated });
  // The OAuth callback's `code` and `state` stay out of the request log (E37.2).
  registerVaultCallbackLogRedaction(app.getHttpAdapter().getInstance());
  await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET });
  if (isSliceEnabled('storage')) {
    // The simple (single request) upload route reads multipart bodies; its size
    // ceiling is the smaller of the deployment's limit and the slice's own.
    const storageOptions = app.get<ResolvedStorageModuleOptions>(STORAGE_OPTIONS, { strict: false });
    const maxFileSize = app.get(ConfigService).get<number>('storage.maxFileSize');
    await app.register(multipart, {
      limits: { fileSize: simpleUploadFileSizeLimit(maxFileSize, storageOptions.maxSimpleUploadBytes), files: 1 },
    });
  }
  app.setGlobalPrefix('api');
  app.enableCors(corsOptions);
  if (!isSameOriginOnly(corsOptions)) new Logger('Bootstrap').log(`CORS: allowlist of ${corsOptions.origin.length} origin(s) with credentials`);
  registerPlatformDocs(app, APP_OPENAPI);
  return app;
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  if (process.env.NODE_ENV === 'production' && process.env.TEST_AUTH_ENABLED === 'true') {
    throw new Error('TEST_AUTH_ENABLED must not be true in production');
  }
  // Fail fast, before a port is bound: a bad TENANCY_MODE, or stored
  // credentials without the SECRETS_ENCRYPTION_KEY that decrypts them.
  verifyTenancyModeAtStartup(process.env, logger);
  const app = await createApp();
  await verifyEncryptionKeyAtStartup(() => app.get(PrismaService).credential.count(), logger);
  app.enableShutdownHooks();
  const port = parseInt(process.env.PORT || '3000', 10);
  await app.listen(port, '0.0.0.0');
  logger.log(`API listening on :${port}/api`);
}

if (require.main === module) {
  void bootstrap();
}
