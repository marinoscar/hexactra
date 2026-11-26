// The pure text helpers (E50.4): `sanitizeText` moved here from the console's MCP text unchanged, so the web toolset cleans third-party text
// the same way. The MCP behaviour is still pinned by apps/api/test/mcp-trust.spec.ts.
import { clip, sanitizeText } from '../src/text';

describe('text helpers', () => {
  it('clip cuts with an ellipsis', () => {
    expect(clip('abcdef', 3)).toBe('abc…');
    expect(clip('abc', 3)).toBe('abc');
  });

  it('sanitizeText removes markup, control and invisible characters, joins lines and caps', () => {
    const zw = String.fromCharCode(0x200b);
    expect(sanitizeText(`<b>Hi</b>${zw} there\n**now** [link](https://x.test) \`code\``, 100)).toBe('Hi there now link code');
    expect(sanitizeText('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(sanitizeText(42, 10)).toBe('');
  });
});
