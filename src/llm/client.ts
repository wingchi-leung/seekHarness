import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";

// ── Retry logic for API calls ──

const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/** Check if an OpenAI API error is retryable (rate limit or server error). */
function isRetryableError(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: number }).status;
    return typeof status === "number" && RETRYABLE_STATUS_CODES.includes(status);
  }
  return false;
}

/**
 * Wrap an API call with exponential-backoff retry.
 * Retries up to MAX_RETRIES times on 429 / 5xx errors.
 * Respects AbortSignal – retries are skipped if signal is already aborted,
 * and the delay between retries short-circuits on abort.
 */
async function withRetry<T>(
  fn: (signal: AbortSignal | undefined) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(signal);
    } catch (err) {
      lastError = err;
      // Non-retryable errors (4xx other than 429, parse errors, etc.) → throw immediately
      if (!isRetryableError(err)) throw err;
      // Out of retries, or caller cancelled → throw last error
      if (attempt >= MAX_RETRIES || signal?.aborted) throw err;

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      // Wait with exponential backoff; short-circuit if signal aborts
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        if (signal) {
          signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        }
      });
    }
  }
  throw lastError; // unreachable, but TS needs it
}

export interface LlmConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export function loadLlmConfig(): LlmConfig {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing DEEPSEEK_API_KEY (or OPENAI_API_KEY). Set it in .env at the project root (see .env.example)."
    );
  }

  return {
    apiKey,
    baseURL:
      process.env.DEEPSEEK_BASE_URL ??
      process.env.OPENAI_BASE_URL ??
      "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  };
}

export function createLlmClient(config: LlmConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

export async function chatWithTools(
  client: OpenAI,
  config: LlmConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  options?: { signal?: AbortSignal }
) {
  return withRetry(
    (signal) => client.chat.completions.create({
      model: config.model,
      messages,
      tools,
      tool_choice: "auto",
    }, { signal }),
    options?.signal,
  );
}

/**
 * Streaming variant of chatWithTools.
 *
 * Calls onContent(text) progressively as text chunks arrive.
 * Returns the fully accumulated assistant message (content + tool_calls).
 */
export async function streamChatWithTools(
  client: OpenAI,
  config: LlmConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  onContent: (chunk: string) => void,
  options?: { signal?: AbortSignal },
): Promise<ChatCompletionMessageParam> {
  const stream = await withRetry(
    (signal) => client.chat.completions.create({
      model: config.model,
      messages,
      tools,
      tool_choice: "auto",
      stream: true,
    }, { signal }),
    options?.signal,
  );

  let content = "";
  let reasoningContent: string | undefined;
  // Accumulate tool call deltas by index
  const toolCallAccumulators = new Map<
    number,
    { id: string; function: { name: string; arguments: string } }
  >();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;

    // ── Stream text content ──
    if (delta?.content) {
      content += delta.content;
      onContent(delta.content);
    }

    // ── Accumulate reasoning_content (DeepSeek reasoning model) ──
    const rc = (delta as any)?.reasoning_content;
    if (rc) {
      reasoningContent = (reasoningContent ?? "") + rc;
    }

    // ── Accumulate tool call deltas ──
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index;
        if (index === undefined) continue;

        if (!toolCallAccumulators.has(index)) {
          toolCallAccumulators.set(index, {
            id: tc.id ?? "",
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          });
        } else {
          const acc = toolCallAccumulators.get(index)!;
          if (tc.id) acc.id = tc.id;
          // Name comes only on the first delta for this index
          if (tc.function?.name) acc.function.name = tc.function.name;
          // Arguments are streamed incrementally
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  // ── Build the full assistant message ──
  const assistantMsg: Record<string, unknown> = {
    role: "assistant",
    content,
  };

  if (reasoningContent) {
    assistantMsg.reasoning_content = reasoningContent;
  }

  if (toolCallAccumulators.size > 0) {
    assistantMsg.tool_calls = Array.from(toolCallAccumulators.entries())
      .sort(([a], [b]) => a - b)
      .map(([_, acc]) => ({
        id: acc.id,
        type: "function" as const,
        function: {
          name: acc.function.name,
          arguments: acc.function.arguments,
        },
      }));
  }

  return assistantMsg as unknown as ChatCompletionMessageParam;
}
