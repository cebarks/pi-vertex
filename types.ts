/**
 * Type definitions for pi-vertex extension
 *
 * Core message/content types are re-exported from pi-ai to ensure pi-vertex
 * handles the full message structure (thinking blocks, tool calls, tool results)
 * that pi-coding-agent passes through the streamSimple callback.
 *
 * Provider callbacks receive a `TranscriptContext`, NOT the legacy `Context`.
 * Since pi-ai 0.87 the system prompt and tool declarations are carried by
 * `SystemMessage` entries inside `messages` — `context.systemPrompt` and
 * `context.tools` no longer exist at runtime. Use pi-ai's replay helpers
 * (`getCurrentSystemPrompt`, `getCurrentTools`) to read them.
 */

// Re-export core types from pi-ai
export type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ImageContent,
  Message,
  StopReason,
  SystemMessage,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolReference,
  ToolResultMessage,
  TranscriptContext,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";

// Vertex-specific types

export type ModelInputType = "text" | "image";
export type EndpointType = "gemini" | "maas";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface VertexModelConfig {
  id: string;
  name: string;
  apiId: string;
  publisher: string;
  endpointType: EndpointType;
  contextWindow: number;
  maxTokens: number;
  input: ModelInputType[];
  reasoning: boolean;
  tools: boolean;
  /**
   * Whether this model supports adaptive thinking with output_config.effort.
   * When true, sends { thinking: { type: "adaptive" }, output_config: { effort } }.
   * When false/undefined, sends legacy { thinking: { type: "enabled", budget_tokens: N } }.
   * Claude 4.6+ models use adaptive thinking; older models use legacy.
   */
  adaptiveThinking?: boolean;
  /** Default/global endpoint pricing, per 1M tokens. */
  cost: ModelCost;
  /** Optional non-global endpoint pricing, per 1M tokens. */
  costRegional?: ModelCost;
  region: string;
}

export interface AuthConfig {
  projectId: string;
  location: string;
  credentials?: string;
}

export interface StreamOptions {
  maxTokens?: number;
  temperature?: number;
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  signal?: AbortSignal;
}
