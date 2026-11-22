// Site facts (phase 5, E46.30): short notes about one site ("Invoices: Billing → History", "Sign-in asks for a one-time code") that help a
// later run on that site. A fact is DATA, never an instruction or a permission: it cannot widen a site, an account, a recipient or a secret
// release, or change a confirmation. Only the owner's own act makes one `active`; derived and agent proposals start `proposed`. No fact holds
// Secret Material (`validateSiteFact` refuses one through the host's `SecretCheckPort`).
import { z } from 'zod';
import { idSchema, registrableDomainSchema, timestampSchema } from './core';

/** What a fact is about. `navigation`: where something is. `sign_in`: how the site signs in. `quirk`: a banner, a pop-up, an expiry. `timing`: slowness. */
export const SITE_FACT_KINDS = ['navigation', 'sign_in', 'quirk', 'timing', 'other'] as const;
export const siteFactKindSchema = z.enum(SITE_FACT_KINDS);
export type SiteFactKind = z.infer<typeof siteFactKindSchema>;

/** Who wrote it. `owner`: the owner typed it. `derived`: `deriveSiteFacts` from server-recorded facts. `agent_proposed`: the agent's free text (Reviews). */
export const SITE_FACT_SOURCES = ['owner', 'derived', 'agent_proposed'] as const;
export const siteFactSourceSchema = z.enum(SITE_FACT_SOURCES);
export type SiteFactSource = z.infer<typeof siteFactSourceSchema>;

/** `proposed` (waiting for the owner) → `active` (used in runs) → `archived` (kept, not used). Only the owner's approval makes a fact `active`. */
export const SITE_FACT_STATUSES = ['proposed', 'active', 'archived'] as const;
export const siteFactStatusSchema = z.enum(SITE_FACT_STATUSES);
export type SiteFactStatus = z.infer<typeof siteFactStatusSchema>;

/** The status moves a store makes. An archived fact may be restored to `active` by its owner; nothing returns to `proposed`. */
export const SITE_FACT_TRANSITIONS: Readonly<Record<SiteFactStatus, readonly SiteFactStatus[]>> = Object.freeze({
  proposed: ['active', 'archived'],
  active: ['archived'],
  archived: ['active'],
});

export function canMoveSiteFact(from: SiteFactStatus, to: SiteFactStatus): boolean {
  return SITE_FACT_TRANSITIONS[from].includes(to);
}

/** The longest text a fact may have. */
export const SITE_FACT_MAX_TEXT = 300;

/** What a fact was derived from: the run, its tool calls (`s<seq>`) and the screens of the surface graph. Ids only, never page text. */
export const siteFactEvidenceSchema = z
  .object({
    runId: idSchema.optional(),
    stepIds: z.array(idSchema).max(50).optional(),
    screenIds: z.array(idSchema).max(50).optional(),
  })
  .strict();
export type SiteFactEvidence = z.infer<typeof siteFactEvidenceSchema>;

/** A site fact. One registrable domain, text of at most 300 characters. The owner is the store's key, not a field. */
export const siteFactSchema = z
  .object({
    id: idSchema,
    site: registrableDomainSchema,
    kind: siteFactKindSchema,
    text: z.string().trim().min(1).max(SITE_FACT_MAX_TEXT),
    source: siteFactSourceSchema,
    status: siteFactStatusSchema,
    evidence: siteFactEvidenceSchema.default({}),
    createdAt: timestampSchema,
    lastUsedAt: timestampSchema.nullable().default(null),
  })
  .strict();
export type SiteFact = z.infer<typeof siteFactSchema>;

/** A fact before it is stored: what `deriveSiteFacts` returns and what a host validates. */
export type SiteFactProposal = Pick<SiteFact, 'site' | 'kind' | 'text' | 'source' | 'evidence'>;

/** What `SiteFactStorePort.proposeSiteFact` takes: a proposal with the id and time the host gives it. A store always stores it `proposed`. */
export type NewSiteFact = SiteFactProposal & { id: string; createdAt: string };

/**
 * A fact's text for identity: Unicode-folded, lower case, digits as `#` (so "about 8 s" and "about 12 s" are the same fact), punctuation
 * dropped (arrows kept as `>`), whitespace collapsed.
 */
export function normaliseSiteFactText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[→⟶➔➜>]+/g, ' > ')
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .replace(/[^\p{L}\p{N}#> ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A fact's identity: site, kind and normalised text. A store keeps at most one fact per identity and owner. */
export function siteFactKey(f: Pick<SiteFact, 'site' | 'kind' | 'text'>): string {
  return `${f.site}|${f.kind}|${normaliseSiteFactText(f.text)}`;
}
