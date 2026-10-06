import { type ParsedDiff, summarizeFiles, truncateDiff } from "./git";

export type Provider = "openai" | "openrouter";

export interface AIConfig {
  provider: Provider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface AIConfigInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface PromptOptions {
  /** Language the description should be written in. */
  language?: string;
  /** Maximum number of diff characters sent to the model. */
  maxChars?: number;
  branch?: string;
  commits?: string[];
}

export class AIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIError";
  }
}

const PROVIDERS: Record<Provider, { baseUrl: string; model: string; envKey: string }> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    envKey: "OPENAI_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    envKey: "OPENROUTER_API_KEY",
  },
};

export const DEFAULT_MAX_CHARS = 24_000;
const REQUEST_TIMEOUT_MS = 60_000;

function isProvider(value: string): value is Provider {
  return value in PROVIDERS;
}

/**
 * Resolves provider, key, model and endpoint from CLI flags and environment.
 * When no provider is given, the one whose API key is set wins (OpenAI first).
 */
export function resolveConfig(input: AIConfigInput = {}, env: NodeJS.ProcessEnv = process.env): AIConfig {
  let provider: Provider;
  if (input.provider) {
    if (!isProvider(input.provider)) {
      throw new AIError(`Unknown provider "${input.provider}". Use "openai" or "openrouter".`);
    }
    provider = input.provider;
  } else {
    provider = !env.OPENAI_API_KEY && env.OPENROUTER_API_KEY ? "openrouter" : "openai";
  }

  const defaults = PROVIDERS[provider];
  const apiKey = env[defaults.envKey];
  if (!apiKey) {
    throw new AIError(`Missing API key: set the ${defaults.envKey} environment variable.`);
  }

  return {
    provider,
    apiKey,
    model: input.model || env.AI_PR_MODEL || defaults.model,
    baseUrl: (input.baseUrl || env.AI_PR_BASE_URL || defaults.baseUrl).replace(/\/+$/, ""),
  };
}

const SYSTEM_PROMPT = `You are a senior software engineer writing a Pull Request description for your teammates.

Rules:
- Describe only what the diff actually shows. Never invent changes, motivations, issue numbers or test results.
- Be specific: name the modules, functions and behaviours that changed.
- Prefer the "why" and the impact over a line-by-line narration.
- Output GitHub-flavoured Markdown and nothing else (no preamble, no code fence around the whole answer).

Use exactly this structure:

# <concise, imperative PR title, max 72 characters>

## Summary
<2-4 sentences on what this PR does and why>

## Changes
<bulleted list of the meaningful changes, grouped by area when it helps>

## How to test
<concrete steps a reviewer can follow; say so if the diff gives no hint>

## Notes
<breaking changes, migrations, follow-ups or risks; write "None." if there are none>`;

export function buildMessages(diff: ParsedDiff, options: PromptOptions = {}): ChatMessage[] {
  const { text, truncated } = truncateDiff(diff.raw, options.maxChars ?? DEFAULT_MAX_CHARS);

  const sections: string[] = [];
  if (options.branch) sections.push(`Branch: ${options.branch}`);
  if (options.commits?.length) {
    sections.push(`Commits:\n${options.commits.map((subject) => `- ${subject}`).join("\n")}`);
  }
  sections.push(
    `Files changed (${diff.files.length} files, +${diff.additions} -${diff.deletions}):\n${summarizeFiles(diff)}`,
  );
  if (truncated) {
    sections.push("The diff below was truncated to fit; rely on the file list for the parts you cannot see.");
  }
  sections.push(`Diff:\n\`\`\`diff\n${text}\n\`\`\``);

  const language = options.language ?? "English";
  return [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nWrite the description in ${language}.` },
    { role: "user", content: sections.join("\n\n") },
  ];
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string } | string;
}

function errorDetail(body: ChatCompletionResponse | undefined, fallback: string): string {
  if (!body?.error) return fallback;
  return typeof body.error === "string" ? body.error : body.error.message ?? fallback;
}

/** Calls an OpenAI-compatible chat completions endpoint and returns the text. */
export async function complete(config: AIConfig, messages: ChatMessage[]): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.provider === "openrouter") {
    // Optional attribution headers recommended by OpenRouter.
    headers["HTTP-Referer"] = "https://github.com/wallaceluis/ai-pr-cli";
    headers["X-Title"] = "ai-pr-cli";
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.model, messages, temperature: 0.2 }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const err = error as Error;
    if (err.name === "TimeoutError") {
      throw new AIError(`Request to ${config.provider} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new AIError(`Could not reach ${config.baseUrl}: ${err.message}`);
  }

  const raw = await response.text();
  let body: ChatCompletionResponse | undefined;
  try {
    body = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    throw new AIError(
      `${config.provider} API returned ${response.status}: ${errorDetail(body, raw.slice(0, 200) || response.statusText)}`,
    );
  }

  const content = body?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    // OpenRouter can answer 200 with an error payload.
    throw new AIError(`${config.provider} returned an empty response: ${errorDetail(body, "no content")}`);
  }
  return content;
}

export async function generatePRDescription(
  diff: ParsedDiff,
  config: AIConfig,
  options: PromptOptions = {},
): Promise<string> {
  return complete(config, buildMessages(diff, options));
}
