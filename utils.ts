/**
 * Utility functions for pi-vertex extension
 *
 * Message conversion aligns with pi-mono's google-shared.ts to ensure consistent
 * handling of thinking blocks, tool calls, tool results, and thought signatures.
 */

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "./types.js";

/**
 * Sanitize text by removing unpaired surrogate code units.
 * Valid surrogate pairs, such as emoji, must be preserved.
 */
export function sanitizeText(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

// --- Thought signature helpers (matching pi-mono google-shared.ts) ---

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
  if (!signature) return false;
  if (signature.length % 4 !== 0) return false;
  return base64SignaturePattern.test(signature);
}

function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  signature: string | undefined,
): string | undefined {
  return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Preserve the last non-empty thought signature during streaming.
 * Some backends only send the signature on the first delta.
 */
export function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) return incoming;
  return existing;
}

/** Accepted `output_config.effort` values on Anthropic's Messages API. */
export type AnthropicEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Major/minor of a Claude model id, in either naming order: Anthropic moved the version
 * to the tail for the 4.x/5.x families (`claude-sonnet-4-5`, `claude-opus-4-6`,
 * `claude-opus-5`) while older models lead with it (`claude-3-5-sonnet-v2`,
 * `claude-3-7-sonnet`, `claude-2.1`). A missing minor means the family's first release
 * (`.0`). Bedrock-style `us.anthropic.` prefixes are stripped before matching.
 */
export function claudeVersion(modelId: string): { major: number; minor: number } | undefined {
  const id = modelId.toLowerCase().replace(/^us\.anthropic\./, "");
  const versionFirst = /^claude-(\d+)(?:[.-](\d+))?/.exec(id);
  if (versionFirst) {
    return {
      major: Number.parseInt(versionFirst[1], 10),
      minor: Number.parseInt(versionFirst[2] ?? "0", 10),
    };
  }
  const familyFirst = /^claude-[a-z]+-(\d+)(?:-(\d+))?/.exec(id);
  if (familyFirst) {
    return {
      major: Number.parseInt(familyFirst[1], 10),
      minor: Number.parseInt(familyFirst[2] ?? "0", 10),
    };
  }
  return undefined;
}

/**
 * Adaptive thinking (`thinking: {type: "adaptive"}` + `output_config.effort`) is the only
 * mode Claude 4.6 and newer accept, and is rejected by 4.5 and older, which require
 * `enabled` + `budget_tokens`. Verified against the Vertex global endpoint on 2026-09-28:
 * claude-opus-5 / claude-sonnet-5 / claude-opus-4-8 400 on `enabled`, while
 * claude-sonnet-4-5 / claude-haiku-4-5 400 on `adaptive`.
 *
 * Unparseable claude ids default to adaptive: an id we have never seen is far more likely
 * to be a newer release than a pre-4.6 one. The static table overrides this when needed.
 */
export function claudeSupportsAdaptiveThinking(modelId: string): boolean {
  if (!modelId.toLowerCase().includes("claude")) return false;
  const version = claudeVersion(modelId);
  if (!version) return true;
  return version.major > 4 || (version.major === 4 && version.minor >= 6);
}

/**
 * The effort ladder a model actually accepts. The 4.6 series rejects `xhigh` with
 * "This model does not support effort level 'xhigh'. Supported levels: high, low, max,
 * medium"; 4.7+ and the 5 series accept all five. Legacy budget models have no effort
 * parameter at all (Opus 4.5 is the documented exception — see the TODO(debt) in
 * streaming/maas.ts).
 */
export function claudeEffortLevels(modelId: string): AnthropicEffortLevel[] {
  if (!claudeSupportsAdaptiveThinking(modelId)) return [];
  const version = claudeVersion(modelId);
  const rejectsXhigh = version?.major === 4 && version?.minor === 6;
  return rejectsXhigh
    ? ["low", "medium", "high", "max"]
    : ["low", "medium", "high", "xhigh", "max"];
}

/** Effort ladder order, lowest to highest spending. */
const EFFORT_ORDER: AnthropicEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** pi thinking levels are not Anthropic effort names; `minimal` has no Anthropic rung. */
const PI_LEVEL_TO_EFFORT: Record<string, AnthropicEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Resolve a pi thinking level (or an already-mapped effort string from a model's
 * thinkingLevelMap) into an effort the model accepts.
 *
 * Missing rungs step *up* first, then down: `xhigh` on the 4.6 series becomes `max`
 * (verified: 4.6 rejects xhigh but accepts max), while `max` on a ladder without it
 * falls back to `xhigh`. Returns undefined only when the model has no effort parameter.
 */
export function mapAnthropicEffort(
  level: string | undefined,
  levels: AnthropicEffortLevel[],
): AnthropicEffortLevel | undefined {
  if (!level || level === "off" || levels.length === 0) return undefined;
  const requested = (EFFORT_ORDER as string[]).includes(level)
    ? (level as AnthropicEffortLevel)
    : PI_LEVEL_TO_EFFORT[level];
  if (!requested) return undefined;
  if (levels.includes(requested)) return requested;
  const from = EFFORT_ORDER.indexOf(requested);
  for (let i = from + 1; i < EFFORT_ORDER.length; i++) {
    if (levels.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  }
  for (let i = from - 1; i >= 0; i--) {
    if (levels.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  }
  return undefined;
}

function getGeminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const majorVersion = getGeminiMajorVersion(modelId);
  if (majorVersion !== undefined) return majorVersion >= 3;
  return true;
}

/**
 * A single content turn in the Vertex Gemini request format.
 * The SDK doesn't export this shape directly, so we model it loosely — fields
 * are constructed inline below and validated server-side.
 */
type GeminiContent = {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
};

/**
 * Convert messages to Gemini format.
 *
 * Handles the full pi-ai Message union: UserMessage, AssistantMessage (with
 * TextContent, ThinkingContent, ToolCall blocks), and ToolResultMessage.
 */
export function convertToGeminiMessages(messages: Message[], modelId: string): GeminiContent[] {
  const result: GeminiContent[] = [];
  const isGemini3 = modelId.startsWith("gemini-3");
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();

  const pushToolResult = (
    toolCallId: string,
    toolName: string,
    content: ToolResultMessage["content"],
    isError: boolean,
  ) => {
    const textContent = content.filter((c): c is TextContent => c.type === "text");
    const textResult = textContent.map((c) => c.text).join("\n");
    const imageContent = content.filter((c): c is ImageContent => c.type === "image");
    const hasText = textResult.length > 0;
    const hasImages = imageContent.length > 0;
    const responseValue = hasText
      ? sanitizeText(textResult)
      : hasImages
        ? "(see attached image)"
        : "";
    const imageParts = imageContent.map((imageBlock) => ({
      inlineData: {
        mimeType: imageBlock.mimeType,
        data: imageBlock.data,
      },
    }));

    const functionResponsePart: Record<string, unknown> = {
      functionResponse: {
        name: toolName,
        response: isError ? { error: responseValue } : { output: responseValue },
        ...(hasImages && supportsMultimodalFunctionResponse(modelId) ? { parts: imageParts } : {}),
      },
    };

    // Merge consecutive tool results into a single user turn (required by Gemini API)
    const lastContent = result[result.length - 1];
    if (lastContent?.role === "user" && lastContent.parts?.some((p) => "functionResponse" in p)) {
      lastContent.parts.push(functionResponsePart);
    } else {
      result.push({ role: "user", parts: [functionResponsePart] });
    }

    // Gemini < 3 carries tool-result images as a separate user image turn.
    if (hasImages && !supportsMultimodalFunctionResponse(modelId)) {
      result.push({
        role: "user",
        parts: [{ text: "Tool result image:" }, ...imageParts],
      });
    }
  };

  const flushMissingToolResults = () => {
    if (pendingToolCalls.length === 0) return;
    for (const toolCall of pendingToolCalls) {
      if (!existingToolResultIds.has(toolCall.id)) {
        pushToolResult(
          toolCall.id,
          toolCall.name,
          [{ type: "text", text: "No result provided" }],
          true,
        );
      }
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set<string>();
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      flushMissingToolResults();
      if (typeof msg.content === "string") {
        if (msg.content.trim()) {
          result.push({
            role: "user",
            parts: [{ text: sanitizeText(msg.content) }],
          });
        }
      } else {
        const parts: Array<Record<string, unknown>> = msg.content.map(
          (item: TextContent | ImageContent) => {
            if (item.type === "text") {
              return { text: sanitizeText(item.text) };
            }
            return {
              inlineData: {
                mimeType: item.mimeType,
                data: item.data,
              },
            };
          },
        );
        if (parts.length > 0) {
          result.push({ role: "user", parts });
        }
      }
    } else if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      flushMissingToolResults();

      // Skip errored/aborted messages — they're incomplete turns
      if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
        continue;
      }

      const isSameProviderAndModel =
        assistantMsg.provider === "vertex" &&
        assistantMsg.api === "google-generative-ai" &&
        assistantMsg.model === modelId;
      const parts: Array<Record<string, unknown>> = [];
      const toolCalls: ToolCall[] = [];

      for (const block of assistantMsg.content) {
        if (block.type === "text") {
          const textBlock = block as TextContent;
          if (!textBlock.text || textBlock.text.trim() === "") continue;
          const thoughtSig = resolveThoughtSignature(
            isSameProviderAndModel,
            textBlock.textSignature,
          );
          parts.push({
            text: sanitizeText(textBlock.text),
            ...(thoughtSig && { thoughtSignature: thoughtSig }),
          });
        } else if (block.type === "thinking") {
          const thinkingBlock = block as ThinkingContent;
          // Skip redacted thinking — only the signature matters, handled by other blocks
          if (thinkingBlock.redacted) continue;
          if (!thinkingBlock.thinking || thinkingBlock.thinking.trim() === "") continue;

          if (isSameProviderAndModel) {
            const thoughtSig = resolveThoughtSignature(true, thinkingBlock.thinkingSignature);
            parts.push({
              thought: true,
              text: sanitizeText(thinkingBlock.thinking),
              ...(thoughtSig && { thoughtSignature: thoughtSig }),
            });
          } else {
            // Cross-provider: convert thinking to plain text (no tags to avoid model mimicry)
            parts.push({ text: sanitizeText(thinkingBlock.thinking) });
          }
        } else if (block.type === "toolCall") {
          const toolCallBlock = block as ToolCall;
          toolCalls.push(toolCallBlock);
          const thoughtSig = resolveThoughtSignature(
            isSameProviderAndModel,
            toolCallBlock.thoughtSignature,
          );

          const part: Record<string, unknown> = {
            functionCall: {
              name: toolCallBlock.name,
              args: toolCallBlock.arguments ?? {},
            },
          };
          if (thoughtSig) {
            part.thoughtSignature = thoughtSig;
          } else if (isGemini3) {
            // Gemini 3 requires thoughtSignature on all functionCall parts.
            // For cross-provider tool calls (or rare same-provider calls without signatures),
            // use the documented escape hatch to bypass validation.
            // See: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
            part.thoughtSignature = "skip_thought_signature_validator";
          }
          parts.push(part);
        }
      }

      if (parts.length > 0) {
        result.push({ role: "model", parts });
      }
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set<string>();
      }
    } else if (msg.role === "toolResult") {
      const toolResultMsg = msg as ToolResultMessage;
      existingToolResultIds.add(toolResultMsg.toolCallId);
      pushToolResult(
        toolResultMsg.toolCallId,
        toolResultMsg.toolName,
        toolResultMsg.content,
        toolResultMsg.isError,
      );
    }
  }

  flushMissingToolResults();

  return result;
}

/**
 * Convert tools to Gemini format using parametersJsonSchema (full JSON Schema support).
 * This differs from OpenAI format — Gemini uses functionDeclarations wrapped in an array.
 */
export function convertToolsForGemini(
  tools: Tool[],
): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

/**
 * Convert tools to OpenAI format (for Claude and MaaS models)
 */
export function convertTools(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Parse SSE (Server-Sent Events) stream
 */
export async function* parseSSEStream(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          yield data;
        }
      }
    }

    // Process remaining buffer
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ")) {
      const data = trimmed.slice(6);
      if (data !== "[DONE]") {
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Map stop reason to standard format
 */
export function mapStopReason(reason: string): "stop" | "length" | "toolUse" | "error" {
  switch (reason) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

/**
 * Calculate cost based on usage and model cost config
 */
export function calculateCost(
  inputCost: number,
  outputCost: number,
  cacheReadCost: number,
  cacheWriteCost: number,
  usage: AssistantMessage["usage"],
): void {
  usage.cost.input = (inputCost / 1000000) * usage.input;
  usage.cost.output = (outputCost / 1000000) * usage.output;
  usage.cost.cacheRead = (cacheReadCost / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = (cacheWriteCost / 1000000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
