import { Type } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantMessageEvent,
  Message,
  Tool,
  TranscriptContext,
  VertexModelConfig,
} from "../types.js";

const mocks = vi.hoisted(() => ({
  // @anthropic-ai/vertex-sdk
  anthropicVertex: vi.fn(),
  anthropicStream: vi.fn(),
  // pi-ai openai-completions path
  streamSimpleOpenAICompletions: vi.fn(),
  // auth
  getAuthConfig: vi.fn(),
  resolveLocation: vi.fn(),
  getAccessToken: vi.fn(),
  buildBaseUrl: vi.fn(),
}));

vi.mock("@anthropic-ai/vertex-sdk", () => ({
  AnthropicVertex: mocks.anthropicVertex,
}));

// streamSimpleOpenAICompletions is imported from the compat subpath, so that is
// the module to intercept. The root export is deliberately left unmocked: the
// transcript replay helpers (normalizeContext, getCurrentSystemPrompt,
// getCurrentTools) must be the real implementations.
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  return {
    ...actual,
    streamSimpleOpenAICompletions: mocks.streamSimpleOpenAICompletions,
  };
});

vi.mock("../auth.js", () => ({
  getAuthConfig: mocks.getAuthConfig,
  resolveLocation: mocks.resolveLocation,
  getAccessToken: mocks.getAccessToken,
  buildBaseUrl: mocks.buildBaseUrl,
}));

// Import AFTER mocks are registered
import { streamMaaS } from "../streaming/maas.js";

// pi-ai >= 0.87 hands providers a TranscriptContext: systemPrompt and tools are
// folded into a leading SystemMessage by normalizeContext(). Always build fixtures
// through it so tests exercise the same shape production sees.
function makeContext(
  init: {
    systemPrompt?: string;
    tools?: Tool[];
    messages?: Message[];
  } = {},
): TranscriptContext {
  return normalizeContext({
    systemPrompt: init.systemPrompt,
    tools: init.tools,
    messages: init.messages ?? [],
  });
}

const baseContext: TranscriptContext = makeContext();

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function makeAnthropicModel(overrides: Partial<VertexModelConfig> = {}): VertexModelConfig {
  return {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    apiId: "claude-sonnet-4-5@20250929",
    publisher: "anthropic",
    endpointType: "maas",
    contextWindow: 200000,
    maxTokens: 64000,
    input: ["text", "image"],
    reasoning: true,
    tools: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    region: "global",
    ...overrides,
  };
}

function makeOpenAICompatModel(overrides: Partial<VertexModelConfig> = {}): VertexModelConfig {
  return {
    id: "llama-4-scout",
    name: "Llama 4 Scout",
    apiId: "meta/llama-4-scout-17b-16e-instruct-maas",
    publisher: "meta",
    endpointType: "maas",
    contextWindow: 1310720,
    maxTokens: 32000,
    input: ["text"],
    reasoning: false,
    tools: true,
    cost: { input: 0.25, output: 0.7, cacheRead: 0, cacheWrite: 0 },
    region: "global",
    ...overrides,
  };
}

async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("streamMaaS — Anthropic path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveLocation.mockImplementation((region?: string) => region ?? "us-central1");
    mocks.getAuthConfig.mockReturnValue({ projectId: "test-project", location: "global" });
    mocks.anthropicVertex.mockImplementation(() => ({
      messages: { stream: mocks.anthropicStream },
    }));
  });

  it("emits start → text deltas → done in order on a happy-path stream", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_123",
            usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      ]),
    );

    const events = await collectEvents(streamMaaS(makeAnthropicModel(), baseContext));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(types[types.length - 1]).toBe("done");

    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.reason).toBe("stop");
    expect(done.message.usage.input).toBe(10);
    expect(done.message.usage.output).toBe(5);

    // Reconstructed text
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.delta : ""))
      .join("");
    expect(text).toBe("Hello world");
  });

  it("uses regional Claude pricing when the resolved endpoint is non-global", async () => {
    mocks.getAuthConfig.mockReturnValue({ projectId: "test-project", location: "europe-west1" });
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_regional",
            usage: {
              input_tokens: 1_000_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1_000_000 },
        },
      ]),
    );

    const events = await collectEvents(
      streamMaaS(
        makeAnthropicModel({
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          costRegional: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
        }),
        baseContext,
      ),
    );

    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.message.usage.cost.input).toBeCloseTo(3.3);
    expect(done.message.usage.cost.output).toBeCloseTo(16.5);
    expect(done.message.usage.cost.total).toBeCloseTo(19.8);
  });

  it("calls stream.end() exactly once across the Anthropic path (no double-end regression)", async () => {
    // Spy on the prototype of the stream returned by the public factory.
    const piAi = await import("@earendil-works/pi-ai");
    const sample = piAi.createAssistantMessageEventStream();
    const proto = Object.getPrototypeOf(sample);
    const endSpy = vi.spyOn(proto, "end");

    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_1",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );

    // The `sample` stream we created above also goes through the prototype, but we
    // never call .end() on it manually — so any end() call counted here comes from
    // streamMaaS / streamAnthropic. That's exactly what we want to assert.
    await collectEvents(streamMaaS(makeAnthropicModel(), baseContext));

    expect(endSpy).toHaveBeenCalledTimes(1);
    endSpy.mockRestore();
  });

  it("emits a single error event when AnthropicVertex throws synchronously", async () => {
    mocks.anthropicStream.mockImplementation(() => {
      throw new Error("boom");
    });

    const events = await collectEvents(streamMaaS(makeAnthropicModel(), baseContext));

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(events.some((e) => e.type === "done")).toBe(false);
    if (last?.type === "error") {
      expect(last.error.errorMessage).toBe("boom");
      expect(last.error.model).toBe("claude-sonnet-4-5");
    }
  });

  it("flips stopReason to toolUse when a tool_use block is present", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_t",
            usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_1", name: "read" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"/tmp"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      ]),
    );

    const events = await collectEvents(streamMaaS(makeAnthropicModel(), baseContext));
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.reason).toBe("toolUse");
    const toolCall = done.message.content.find((b: any) => b.type === "toolCall");
    expect(toolCall).toMatchObject({ name: "read", arguments: { path: "/tmp" } });
  });
});

describe("streamMaaS — OpenAI-compat path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveLocation.mockImplementation((region?: string) => region ?? "us-central1");
    mocks.getAuthConfig.mockReturnValue({ projectId: "test-project", location: "global" });
    mocks.getAccessToken.mockResolvedValue("fake-token");
    mocks.buildBaseUrl.mockReturnValue("https://example/v1/projects/p/locations/global");
  });

  it("relays inner OpenAI events and rewrites model id on done", async () => {
    const innerEvents: AssistantMessageEvent[] = [
      {
        type: "start",
        partial: {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "vertex",
          model: "meta/llama-4-scout-17b-16e-instruct-maas",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      },
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "openai-completions",
          provider: "vertex",
          model: "meta/llama-4-scout-17b-16e-instruct-maas",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      },
    ];
    mocks.streamSimpleOpenAICompletions.mockReturnValue(asyncIter(innerEvents));

    const events = await collectEvents(streamMaaS(makeOpenAICompatModel(), baseContext));
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");

    // The outer wrapper rewrites .model to the public id (not the apiId).
    expect(done.message.model).toBe("llama-4-scout");
  });
});

describe("streamMaaS — transcript context (system prompt + tools)", () => {
  const bashTool: Tool = {
    name: "bash",
    description: "Execute a shell command",
    parameters: Type.Object({ command: Type.String() }),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveLocation.mockImplementation((region?: string) => region ?? "us-central1");
    mocks.getAuthConfig.mockReturnValue({ projectId: "test-project", location: "global" });
    mocks.anthropicVertex.mockImplementation(() => ({
      messages: { stream: mocks.anthropicStream },
    }));
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_ctx",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );
  });

  /** The params object pi-vertex handed to AnthropicVertex.messages.stream(). */
  function sentParams(): Record<string, any> {
    const call = mocks.anthropicStream.mock.calls[0];
    if (!call) throw new Error("AnthropicVertex.messages.stream was never called");
    return call[0] as Record<string, any>;
  }

  it("sends the system prompt carried by the leading system message", async () => {
    await collectEvents(
      streamMaaS(
        makeAnthropicModel(),
        makeContext({ systemPrompt: "You are pi.", messages: [userMsg("hi")] }),
      ),
    );

    expect(sentParams().system).toBe("You are pi.");
  });

  it("sends tool declarations carried by toolsAdded", async () => {
    await collectEvents(
      streamMaaS(
        makeAnthropicModel(),
        makeContext({ tools: [bashTool], messages: [userMsg("hi")] }),
      ),
    );

    const tools = sentParams().tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("bash");
    expect(tools[0].description).toBe("Execute a shell command");
    expect(tools[0].input_schema).toMatchObject({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    });
  });

  it("never leaks a system-role message into the Anthropic messages array", async () => {
    await collectEvents(
      streamMaaS(
        makeAnthropicModel(),
        makeContext({
          systemPrompt: "You are pi.",
          tools: [bashTool],
          messages: [userMsg("hi")],
        }),
      ),
    );

    const messages = sentParams().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("resolves mid-conversation tool deltas when replaying the transcript", async () => {
    // pi emits later system messages carrying toolsAdded / toolsRemoved. The
    // request must carry the resolved current set, not just the leading one.
    const grepTool: Tool = {
      name: "grep",
      description: "Search text",
      parameters: Type.Object({ pattern: Type.String() }),
    };
    const ctx = makeContext({ tools: [bashTool], messages: [userMsg("hi")] });
    ctx.messages.push({
      role: "system",
      content: "",
      toolsAdded: [grepTool],
      timestamp: Date.now(),
    } as Message);
    ctx.messages.push({
      role: "system",
      content: "",
      toolsRemoved: [{ name: "bash" }],
      timestamp: Date.now(),
    } as Message);

    await collectEvents(streamMaaS(makeAnthropicModel(), ctx));

    expect((sentParams().tools ?? []).map((t: any) => t.name)).toEqual(["grep"]);
  });

  it("sanitizes tool names Anthropic rejects and maps them back on the response", async () => {
    // Anthropic requires tools.N.name to match ^[a-zA-Z0-9_-]{1,128}$; one bad
    // name 400s the whole request and takes every tool down with it.
    const namespaced: Tool = {
      name: "mcp:server.some-tool",
      description: "Namespaced MCP tool",
      parameters: Type.Object({}),
    };
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_names",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "mcp_server_some-tool",
            input: {},
          },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      ]),
    );

    const events = await collectEvents(
      streamMaaS(
        makeAnthropicModel(),
        makeContext({ tools: [namespaced], messages: [userMsg("hi")] }),
      ),
    );

    const sent = (sentParams().tools ?? []).map((t: any) => t.name);
    expect(sent[0]).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);

    // Inbound: pi must see the original name or it cannot dispatch the call.
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");
    const call = done.message.content.find((b) => b.type === "toolCall");
    expect(call?.type === "toolCall" ? call.name : undefined).toBe("mcp:server.some-tool");
  });

  it("omits system and tools keys when the transcript carries no system message", async () => {
    await collectEvents(
      streamMaaS(makeAnthropicModel(), makeContext({ messages: [userMsg("hi")] })),
    );

    const params = sentParams();
    expect(params).not.toHaveProperty("system");
    expect(params).not.toHaveProperty("tools");
  });
});

describe("streamMaaS — Claude thinking mode (adaptive vs legacy budget)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveLocation.mockImplementation((region?: string) => region ?? "global");
    mocks.getAuthConfig.mockReturnValue({ projectId: "test-project", location: "global" });
    mocks.anthropicVertex.mockImplementation(() => ({
      messages: { stream: mocks.anthropicStream },
    }));
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: { id: "msg_t", usage: { input_tokens: 1, output_tokens: 1 } },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );
  });

  function sentParams(): Record<string, any> {
    const call = mocks.anthropicStream.mock.calls[0];
    if (!call) throw new Error("AnthropicVertex.messages.stream was never called");
    return call[0] as Record<string, any>;
  }

  async function paramsFor(
    model: VertexModelConfig,
    reasoning: "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  ) {
    await collectEvents(
      streamMaaS(model, makeContext({ messages: [userMsg("hi")] }), { reasoning }),
    );
    return sentParams();
  }

  // The bug that produced: 400 {"type":"invalid_request_error","message":"\"thinking.type.enabled\"
  // is not supported for this model. Use \"thinking.type.adaptive\" and \"output_config.effort\"'}
  // claude-opus-5 was absent from the static table, so discovery synthesized it from
  // PUBLISHER_DEFAULTS.anthropic (no adaptiveThinking) and it fell to the legacy branch.
  it("sends adaptive thinking for a discovered Claude 5.x model that declares nothing", async () => {
    const params = await paramsFor(
      makeAnthropicModel({
        id: "claude-opus-5",
        name: "Claude Opus 5",
        apiId: "claude-opus-5",
        adaptiveThinking: undefined,
        maxTokens: 128000,
      }),
      "high",
    );

    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "high" });
    expect(params.thinking).not.toHaveProperty("budget_tokens");
  });

  it("maps pi max to Anthropic max instead of downgrading to high", async () => {
    const params = await paramsFor(
      makeAnthropicModel({ id: "claude-opus-5", adaptiveThinking: undefined }),
      "max",
    );

    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "max" });
  });

  it("steps xhigh up to max on the 4.6 series, which rejects xhigh", async () => {
    const params = await paramsFor(
      makeAnthropicModel({ id: "claude-opus-4-6", adaptiveThinking: true }),
      "xhigh",
    );

    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "max" });
  });

  it("keeps xhigh on 4.7+ and the 5.x series, which accept it", async () => {
    const params = await paramsFor(
      makeAnthropicModel({ id: "claude-opus-4-8", adaptiveThinking: true }),
      "xhigh",
    );

    expect(params.output_config).toEqual({ effort: "xhigh" });
  });

  it("still sends the legacy budget for Claude 4.5 and below", async () => {
    const params = await paramsFor(makeAnthropicModel({ id: "claude-sonnet-4-5" }), "high");

    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(params).not.toHaveProperty("output_config");
    expect(params.max_tokens).toBeGreaterThan(params.thinking.budget_tokens);
  });

  it("clamps the legacy budget under maxTokens so xhigh cannot violate the ordering", async () => {
    const params = await paramsFor(
      makeAnthropicModel({ id: "claude-haiku-4-5", maxTokens: 8192 }),
      "xhigh",
    );

    expect(params.thinking.type).toBe("enabled");
    expect(params.thinking.budget_tokens).toBeLessThan(params.max_tokens);
    expect(params.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
  });

  // pi's ThinkingLevel type has no "off" member: turning thinking off means the
  // provider is called without `reasoning` at all. Guard the omission so a Claude
  // model never gets a thinking block the user did not ask for.
  it("omits thinking entirely when the caller passes no reasoning level", async () => {
    await collectEvents(
      streamMaaS(
        makeAnthropicModel({ id: "claude-opus-5" }),
        makeContext({ messages: [userMsg("hi")] }),
      ),
    );

    const params = sentParams();
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("output_config");
  });
});
