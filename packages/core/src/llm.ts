import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Minimal client for any OpenAI-compatible chat endpoint. Free tiers from Groq,
 * Google AI Studio (Gemini) and OpenRouter all expose one, so switching provider
 * is a config change. Every response is cached by prompt hash.
 */

const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
};

/** Loads .env from the working directory if present; real environment variables win. */
export function loadEnv(file = '.env'): void {
  try {
    const before = { ...process.env };
    process.loadEnvFile(file);
    Object.assign(process.env, before);
  } catch {
    // no .env file
  }
}

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  cacheDir: string;
  /** Only answer from the cache; never call the network. */
  replay: boolean;
}

export function llmConfigFromEnv(env = process.env): LlmConfig | null {
  const provider = env.LLM_PROVIDER || 'groq';
  const preset = PRESETS[provider];
  const baseUrl = env.LLM_BASE_URL || preset?.baseUrl;
  const model = env.LLM_MODEL || preset?.model;
  const replay = env.LLM_REPLAY === '1';
  if (!baseUrl || !model) return null;
  if (!env.LLM_API_KEY && !replay) return null;
  return {
    provider,
    baseUrl: baseUrl.replace(/\/$/, ''),
    model,
    apiKey: env.LLM_API_KEY ?? '',
    cacheDir: env.LLM_CACHE_DIR || '.cache/llm',
    replay,
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  cached: boolean;
  model: string;
}

export async function chatJson(cfg: LlmConfig, messages: ChatMessage[]): Promise<ChatResult> {
  const hash = createHash('sha256').update(JSON.stringify([cfg.model, messages])).digest('hex');
  const file = join(cfg.cacheDir, `${hash}.json`);
  try {
    const hit = JSON.parse(await readFile(file, 'utf8'));
    return { content: hit.content, cached: true, model: hit.model };
  } catch {
    if (cfg.replay) throw new Error('replay mode: no cached response for this prompt');
  }

  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 || res.status >= 500) {
      lastError = `${res.status} ${await res.text().catch(() => '')}`.slice(0, 300);
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
      await new Promise((r) => setTimeout(r, Math.min(wait, 20) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
    const content = data.choices?.[0]?.message?.content ?? '';
    await mkdir(cfg.cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify({ model: data.model ?? cfg.model, content, at: new Date().toISOString() }, null, 2));
    return { content, cached: false, model: data.model ?? cfg.model };
  }
  throw new Error(`LLM request kept failing: ${lastError}`);
}

/** Models sometimes wrap JSON in a code fence or add a sentence; take the outermost object. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(start, end + 1));
}
