/** `GET /api/inbox` items (apps/api/src/runner/inbox.controller.ts). */
export interface InboxItem {
  runId: string;
  goal: string;
  kind: string;
  prompt: string;
  input: 'none' | 'text' | 'secret' | 'choice';
  choices: string[];
  expiresAt: string;
}

/** Read one line from stdin (for a secret: never an argument, so it stays out of shell history). */
export async function readStdinLine(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += String(chunk);
    if (data.includes('\n')) break;
  }
  return data.split('\n')[0]!.trim();
}
