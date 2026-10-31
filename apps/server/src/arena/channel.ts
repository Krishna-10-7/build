/** What an agent at a desk reports while it works; the arena turns it into live events. */
export type Tone = 'info' | 'ok' | 'warn' | 'bad' | 'dim' | 'cmd' | 'add' | 'del';

export type AgentStatus = 'idle' | 'working' | 'thinking' | 'done' | 'alert';

export interface AgentChannel {
  log(text: string, tone?: Tone): void;
  state(status: AgentStatus, headline: string): void;
  frame(jpegBase64: string): void;
}

export interface Target {
  baseURL: string;
  mutations: string[];
  /** Fences a page in before its first step: it may only reach the app under test and the public web. */
  guard?: (page: import('playwright').Page) => Promise<void>;
}

/** Minimal line diff (longest common subsequence), enough for spec snippets. */
export function lineDiff(before: string, after: string): { tone: 'add' | 'del' | 'dim'; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { tone: 'add' | 'del' | 'dim'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ tone: 'dim', text: '  ' + a[i] });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ tone: 'add', text: '+ ' + b[j++] });
    } else {
      out.push({ tone: 'del', text: '- ' + a[i++] });
    }
  }
  return out;
}
