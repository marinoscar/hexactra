// "Save this login?" (E37.4b): after the owner signed in by hand through a `credentials` card, offer to save that login in
// their provider so the next run does not ask.
//
// The password is never here. The runner asks the fabric to keep it (`offer_save` on the `credentials` handoff); when the
// owner presses Save, the FABRIC sends the value it still holds to the provider (`FabricSession.saveLogin`) and answers only
// that it did. The console keeps: the proposal (site, name, username, the fabric's handoff id), the decision, and the sites the
// owner said "Never" for. A test scans the database for a marker password.
import { createHash } from 'node:crypto';

import { Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UserSettingsService } from '@marinoscar/platform-api/settings';
import type { Prisma } from '@prisma/client';

import { registrableDomain } from '../approvals/approval-match';
import { FabricClient, FabricError } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { SAVE_LOGIN_VALUE_TTL_MS, saveLoginProposalSchema, type SaveLoginProposal } from '../questions/questions.contract';
import { QuestionsService } from '../questions/questions.service';
import { SaveLoginError, type SaveLoginPort } from '../questions/save-login.port';
import { FabricSession } from '../runner/fabric-session';
import { SecretsPolicyService } from './secrets-policy.service';
import { SecretsProviderRegistrar } from './secrets-provider.registrar';
import { SecretsProviderError } from './secrets-provider.port';
import { MAX_NEVER_SAVE_SITES, neverSaveLoginSitesOf } from './secrets.settings';
import { SECRETS_AUDIT, SecretsEvents, hostOf } from './secrets.events';
import { VaultApiClient } from './vault-api.client';
import { VaultConnectionService } from './vault-connection.service';
import { VAULT_SCOPES } from './vault-contract';
import { VaultAccessError, VaultTokenService } from './vault-token.service';

/** The feature id Vault's `GET /whoami` lists from agent contract 1.3: it accepts the purpose `save_login`. */
export const VAULT_SAVE_LOGIN_FEATURE = 'save_login';

/** What `propose_saving_login` tells the model. `questionId` when a card was made. */
export interface SaveLoginOffer {
  proposed: boolean;
  message: string;
  questionId?: string;
}

/** Where a sign-in comes from: the run, and the chat it belongs to when it is a chat's. */
export interface SaveLoginOrigin {
  runId: string;
  conversationId: string | null;
}

/** `https`, or `http` on loopback: the origins a provider binds a login to. Returns `scheme://host[:port]` or null. */
export function signInOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The name a login is offered under: one line, no more than a few words of the model's, the site's host when it gave none. */
export function offeredName(name: string | null | undefined, site: string): string {
  const clean = (name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || site;
}

@Injectable()
export class SaveLoginService implements SaveLoginPort, OnModuleInit {
  private readonly log = new Logger(SaveLoginService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: SecretsPolicyService,
    private readonly connection: VaultConnectionService,
    private readonly tokens: VaultTokenService,
    private readonly api: VaultApiClient,
    private readonly registrar: SecretsProviderRegistrar,
    private readonly fabric: FabricClient,
    private readonly events: SecretsEvents,
    /** The question broker is found at start (not imported as a module): this slice is optional, the broker is not, and the module graph stays as it was. */
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly settings?: UserSettingsService,
  ) {}

  private questions!: QuestionsService;

  onModuleInit(): void {
    this.questions = this.moduleRef.get(QuestionsService, { strict: false });
    this.questions.useSaveLogin(this);
  }

  /**
   * Whether a sign-in can be offered to the owner's provider now: both agent-use switches on, their Vault chosen and connected
   * with the write scope ("Let the agent save and change logins"), and that Vault speaking contract 1.3 (a Vault older than
   * that rejects the purpose). Never throws: any doubt is "no", and the run asks the owner as it always did.
   */
  async supported(userId: string): Promise<boolean> {
    try {
      if (!(await this.policy.agentUse(userId)).effective) return false;
      if ((await this.policy.activeProvider(userId)) !== 'vault') return false;
      if (!(await this.connection.grantedScopes(userId)).includes(VAULT_SCOPES.write)) return false;
      const access = await this.tokens.getAccess(userId);
      const who = await this.api.whoami(access.baseUrl, access.accessToken, (await this.policy.system()).vault.allowedHosts);
      return who.status === 'ok' && (who.whoami.contract?.features ?? []).includes(VAULT_SAVE_LOGIN_FEATURE);
    } catch (e) {
      if (!(e instanceof VaultAccessError)) this.log.warn(`could not check whether the Vault can save logins (${e instanceof Error ? e.name : 'error'})`);
      return false;
    }
  }

  /** The registrable domains the owner chose "Never for this site" for. */
  async neverSites(userId: string): Promise<string[]> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return neverSaveLoginSitesOf(row?.value);
  }

  /**
   * Offers the sign-in of a `credentials` handoff the agent typed: a card the owner answers when they like. Refused (with the
   * reason, for the model) when the owner said never for this site, the handoff is not a typed sign-in of this owner, the fabric
   * no longer holds its password, or it was offered already. Nothing here writes to the provider.
   */
  async propose(userId: string, args: { handoffId: string; origin: string; name: string | null; from: SaveLoginOrigin }): Promise<SaveLoginOffer> {
    const origin = signInOrigin(args.origin);
    if (!origin) return { proposed: false, message: 'Not offered: the sign-in page is not an https address.' };
    const site = hostOf(origin) ?? origin;
    const domain = registrableDomain(origin) ?? site;
    if ((await this.neverSites(userId)).includes(domain)) return { proposed: false, message: 'The owner chose never to be asked to save a login for this site. Do not offer again.' };

    const db = this.prisma.forUser({ userId });
    // The sign-in the owner typed: its question, answered, with the username they gave and when (the password's lifetime starts then).
    const asked = await db.question.findFirst({ where: { handoffId: args.handoffId, input: 'credentials', status: 'answered' }, select: { response: true } });
    const response = (asked?.response ?? null) as { value?: unknown; answeredAt?: unknown } | null;
    const username = typeof response?.value === 'string' ? response.value.trim() : '';
    const answeredAt = typeof response?.answeredAt === 'string' ? new Date(response.answeredAt) : null;
    if (!asked || !username || !answeredAt || Number.isNaN(answeredAt.getTime())) return { proposed: false, message: 'Not offered: no sign-in typed by the owner is waiting to be saved.' };
    const valueExpiresAt = new Date(answeredAt.getTime() + SAVE_LOGIN_VALUE_TTL_MS);
    if (valueExpiresAt.getTime() <= Date.now()) return { proposed: false, message: 'Not offered: it is too late to save this sign-in; it will be offered at the next one.' };

    const key = createHash('sha256').update(`save_login\u0000${args.handoffId}`).digest('hex');
    const waiting = await db.question.findFirst({ where: { input: 'save_login', proposalKey: key }, select: { id: true } });
    if (waiting) return { proposed: false, message: 'Already offered: it waits for the owner.', questionId: waiting.id };

    const proposal: SaveLoginProposal = { site, origin, domain, name: offeredName(args.name, site), username: username.slice(0, 200), handoffId: args.handoffId, provider: 'vault', valueExpiresAt: valueExpiresAt.toISOString() };
    const q = await this.questions.createSaveLoginProposal(userId, proposal, {
      askedBy: `run:${args.from.runId}`,
      proposalKey: key,
      runId: args.from.runId,
      conversationId: args.from.conversationId,
    });
    // In a chat, the card is a message of the thread (a card of its own: `meta.card`).
    if (args.from.conversationId) await this.appendCard(args.from.conversationId, q.id, site);
    await this.events.audit(userId, SECRETS_AUDIT.loginOffered, q.id, { provider: 'vault', site }, null, 'question');
    return { proposed: true, message: 'Offered; the owner decides. The run does not wait for the answer.', questionId: q.id };
  }

  /** The thread message that shows the card (`kind: memory`, `meta.card: save_login`, `meta.questionId`). */
  private async appendCard(conversationId: string, questionId: string, site: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const c = await tx.conversation.update({ where: { id: conversationId }, data: { nextSeq: { increment: 1 }, lastMessageAt: now }, select: { nextSeq: true } });
      await tx.chatMessage.create({
        data: { conversationId, seq: c.nextSeq - 1, role: 'assistant', kind: 'memory', text: `Offered to save the sign-in for ${site}`.slice(0, 8000), meta: { questionId, card: 'save_login' } as Prisma.InputJsonValue, createdAt: now },
      });
    });
  }

  /**
   * The owner pressed Save: the fabric sends the password it still holds to the provider. The provider's registration is
   * renewed first (the run that held it may be over). Every failure is a {@link SaveLoginError} in the card's words.
   */
  async save(userId: string, proposal: SaveLoginProposal, name: string, ctx: { questionId: string; runId: string | null }): Promise<{ itemId: string | null }> {
    const parsed = saveLoginProposalSchema.parse(proposal);
    const site = parsed.site;
    const fail = async (code: SaveLoginError['code'], message: string, reason: string): Promise<never> => {
      await this.events.audit(userId, SECRETS_AUDIT.loginSaveFailed, ctx.questionId, { provider: 'vault', site, reason }, null, 'question');
      throw new SaveLoginError(code, message);
    };
    const registered = await this.registrar.ensureRegistered(userId, { force: true });
    if (registered === 'not_enabled') return fail('SAVE_DISABLED', 'Saved logins are switched off. Turn them on in Settings → Secrets, then try again.', 'not_enabled');
    if (registered === 'needs_reconnect' || registered === 'not_connected') return fail('SAVE_RECONNECT', 'Vault needs to be connected again. Reconnect it in Settings → Secrets, then try again.', registered);
    if (registered !== 'registered') return fail('SAVE_UNAVAILABLE', 'Vault could not be reached. Try again in a moment.', 'unavailable');
    try {
      const saved = await new FabricSession(this.fabric).saveLogin(userId, 'vault', { handoffId: parsed.handoffId, name, origin: parsed.origin, ...(ctx.runId ? { runId: ctx.runId } : {}), clientLabel: 'Hexactra' });
      await this.events.audit(userId, SECRETS_AUDIT.loginSaved, ctx.questionId, { provider: 'vault', site }, null, 'question');
      await this.recordOutcome(userId, true);
      return saved;
    } catch (e) {
      if (e instanceof SecretsProviderError) return this.failureOf(e, fail, userId);
      if (e instanceof FabricError) return fail('SAVE_UNAVAILABLE', 'Hexactra could not reach the browser service to save the login. Try again in a moment.', 'fabric_unreachable');
      throw e;
    }
  }

  private async failureOf(e: SecretsProviderError, fail: (code: SaveLoginError['code'], message: string, reason: string) => Promise<never>, userId: string): Promise<never> {
    switch (e.code) {
      // The fabric no longer holds the password (saved, expired, restarted) or never had one for this handoff.
      case 'secret_unavailable':
      case 'not_found':
        return fail('SAVE_TOO_LATE', 'Too late to save this time; it will be offered at the next sign-in.', e.code);
      case 'name_taken':
        return fail('SAVE_NAME_TAKEN', 'You already have a secret with that name in Vault. Choose another name.', e.code);
      case 'unauthorized':
        await this.recordOutcome(userId, false, 'UNAUTHORIZED');
        return fail('SAVE_RECONNECT', 'Vault refused the connection. Reconnect it in Settings → Secrets, then try again.', e.code);
      case 'disabled':
        await this.recordOutcome(userId, false, 'DISABLED');
        return fail('SAVE_DISABLED', "Vault's agent access is switched off, so it cannot save logins.", e.code);
      case 'rate_limited':
      case 'unavailable':
      case 'timed_out':
      case 'no_provider':
        return fail('SAVE_UNAVAILABLE', 'Vault could not be reached or is busy. Try again in a moment.', e.code);
      default:
        // Refused (a missing scope, a Vault older than contract 1.3) or unsupported: the card says what to check.
        return fail('SAVE_REFUSED', 'Vault did not accept the login. It needs the "save and change logins" permission and Vault 1.3 or newer.', e.code);
    }
  }

  private async recordOutcome(userId: string, ok: boolean, code?: string): Promise<void> {
    try {
      await this.connection.recordOutcome(userId, ok ? { ok: true } : { ok: false, code: code ?? 'UNAVAILABLE' });
    } catch {
      // A failed report never fails the save.
    }
  }

  /** "Never for this site": the registrable domain is remembered for the owner (a setting, capped), and not offered again. */
  async never(userId: string, domain: string): Promise<void> {
    if (!this.settings) return;
    const site = domain.trim().toLowerCase();
    const current = await this.neverSites(userId);
    if (current.includes(site)) return;
    // The oldest entries fall off when the list is full: the owner can always add a site again.
    const next = [...current, site].slice(-MAX_NEVER_SAVE_SITES);
    await this.settings.patchSettings(userId, { secrets: { neverSaveLoginSites: next } } as never);
    await this.events.audit(userId, SECRETS_AUDIT.loginNeverForSite, userId, { provider: 'vault', site }, null, 'user');
  }
}
