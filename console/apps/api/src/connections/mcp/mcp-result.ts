// What a tool's result becomes before a model reads it (E39.9, #606): text and structured content only, size-capped and marked truncated.
// Images, audio and binary resources are dropped with a note; resource links are NOT followed (a link is a request to fetch something
// the owner did not ask for). Console tokens and the owner's other connections' tokens are redacted on the way in as they are on the way out.
import type { McpCallResult } from './mcp-client';
import { redactSecrets } from './mcp-redact';
import { sanitizeServerMessage } from './mcp-text';

export interface NormalizedResult {
  /** The text the model reads (without the untrusted-content wrapper): text blocks, or the structured content as JSON. */
  text: string;
  isError: boolean;
  /** The result was cut at the cap. */
  truncated: boolean;
  /** What was dropped: `3 images, 1 resource link`. Empty when nothing was. */
  dropped: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `maxChars` bounds the text. A result with text blocks keeps those (a server SHOULD also serialise structured content into one); one
 * with only structured content keeps that as JSON. `secrets` are exact values that must never come back to a model.
 */
export function normalizeResult(r: McpCallResult, maxChars: number, secrets: readonly string[] = []): NormalizedResult {
  const texts: string[] = [];
  const counts = { image: 0, audio: 0, link: 0, blob: 0, other: 0 };
  for (const block of r.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image') counts.image += 1;
    else if (block.type === 'audio') counts.audio += 1;
    else if (block.type === 'resource_link') counts.link += 1;
    else if (block.type === 'resource' && isRecord(block.resource)) {
      if (typeof block.resource.text === 'string') texts.push(block.resource.text);
      else counts.blob += 1;
    } else counts.other += 1;
  }
  let text = texts.join('\n');
  if (!text && r.structuredContent !== undefined) {
    try {
      text = JSON.stringify(r.structuredContent);
    } catch {
      text = '';
    }
  }
  text = redactSecrets(text, secrets);
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  const parts = [
    counts.image ? `${counts.image} image${counts.image === 1 ? '' : 's'}` : '',
    counts.audio ? `${counts.audio} audio clip${counts.audio === 1 ? '' : 's'}` : '',
    counts.link ? `${counts.link} resource link${counts.link === 1 ? '' : 's'} (not followed)` : '',
    counts.blob ? `${counts.blob} binary resource${counts.blob === 1 ? '' : 's'}` : '',
    counts.other ? `${counts.other} other item${counts.other === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return { text, isError: r.isError, truncated, dropped: parts.join(', ') };
}

/** An error the server reported, as the short plain sentence the model reads. */
export const serverErrorText = (message: string | undefined): string => (message ? sanitizeServerMessage(message) : '');
