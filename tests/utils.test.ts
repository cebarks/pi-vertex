import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import {
  calculateCost,
  claudeEffortLevels,
  claudeSupportsAdaptiveThinking,
  claudeVersion,
  convertTools,
  convertToolsForGemini,
  mapStopReason,
  retainThoughtSignature,
  sanitizeText,
} from "../utils.js";

describe("sanitizeText", () => {
  it("passes clean text through", () => {
    expect(sanitizeText("hello world")).toBe("hello world");
  });

  it("preserves valid surrogate pairs", () => {
    expect(sanitizeText("hello 😀 world")).toBe("hello 😀 world");
  });

  it("removes lone surrogates", () => {
    expect(sanitizeText("\uD800")).toBe("");
    expect(sanitizeText("\uDFFF")).toBe("");
  });

  it("removes unpaired surrogates inside text", () => {
    expect(sanitizeText("a\uD800b\uDFFFc")).toBe("abc");
  });
});

describe("retainThoughtSignature", () => {
  it("returns incoming when present", () => {
    expect(retainThoughtSignature("old", "new")).toBe("new");
  });

  it("returns existing when incoming is undefined", () => {
    expect(retainThoughtSignature("old", undefined)).toBe("old");
  });

  it("returns existing when incoming is empty string", () => {
    expect(retainThoughtSignature("old", "")).toBe("old");
  });

  it("returns undefined when both are absent", () => {
    expect(retainThoughtSignature(undefined, undefined)).toBeUndefined();
  });
});

describe("mapStopReason", () => {
  it("maps stop/end_turn to stop", () => {
    expect(mapStopReason("stop")).toBe("stop");
    expect(mapStopReason("end_turn")).toBe("stop");
  });

  it("maps length/max_tokens to length", () => {
    expect(mapStopReason("length")).toBe("length");
    expect(mapStopReason("max_tokens")).toBe("length");
  });

  it("maps tool_calls/tool_use to toolUse", () => {
    expect(mapStopReason("tool_calls")).toBe("toolUse");
    expect(mapStopReason("tool_use")).toBe("toolUse");
  });

  it("defaults unknown reasons to error", () => {
    expect(mapStopReason("content_filter")).toBe("error");
    expect(mapStopReason("")).toBe("error");
  });
});

describe("calculateCost", () => {
  it("computes cost per-million-token pricing", () => {
    const usage: AssistantMessage["usage"] = {
      input: 1_000_000,
      output: 2_000_000,
      cacheRead: 500_000,
      cacheWrite: 100_000,
      totalTokens: 3_600_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    calculateCost(3.0, 15.0, 0.3, 3.75, usage);

    expect(usage.cost.input).toBe(3.0);
    expect(usage.cost.output).toBe(30.0);
    expect(usage.cost.cacheRead).toBe(0.15);
    expect(usage.cost.cacheWrite).toBe(0.375);
    expect(usage.cost.total).toBe(33.525);
  });

  it("handles zero usage", () => {
    const usage: AssistantMessage["usage"] = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    calculateCost(5.0, 25.0, 0.5, 6.25, usage);

    expect(usage.cost.total).toBe(0);
  });
});

describe("convertTools", () => {
  it("converts tools to OpenAI format", () => {
    const tools = [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    });
  });
});

describe("convertToolsForGemini", () => {
  it("returns undefined for empty tool array", () => {
    expect(convertToolsForGemini([])).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(convertToolsForGemini(undefined as any)).toBeUndefined();
  });

  it("wraps tools in functionDeclarations", () => {
    const tools = [
      {
        name: "write",
        description: "Write a file",
        parameters: { type: "object", required: ["path"] },
      },
    ];

    const result = convertToolsForGemini(tools);

    expect(result).toHaveLength(1);
    expect(result?.[0]).toEqual({
      functionDeclarations: [
        {
          name: "write",
          description: "Write a file",
          parametersJsonSchema: { type: "object", required: ["path"] },
        },
      ],
    });
  });
});

describe("claudeVersion", () => {
  it("parses family-first and version-first ids", () => {
    expect(claudeVersion("claude-sonnet-4-5")).toEqual({ major: 4, minor: 5 });
    expect(claudeVersion("claude-opus-4")).toEqual({ major: 4, minor: 0 });
    expect(claudeVersion("claude-opus-5")).toEqual({ major: 5, minor: 0 });
    expect(claudeVersion("claude-3-5-sonnet-v2")).toEqual({ major: 3, minor: 5 });
    expect(claudeVersion("claude-2.1")).toEqual({ major: 2, minor: 1 });
    expect(claudeVersion("us.anthropic.claude-3-7-sonnet")).toEqual({ major: 3, minor: 7 });
    expect(claudeVersion("claude-pro-next")).toBeUndefined();
  });
});

describe("claudeSupportsAdaptiveThinking", () => {
  it("returns true for Claude 4.6+ and every Claude 5.x", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
    ]) {
      expect(claudeSupportsAdaptiveThinking(id), id).toBe(true);
    }
  });

  it("returns false for Claude 4.5 and older", () => {
    for (const id of [
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-opus-4",
      "claude-sonnet-4",
      "claude-3-5-sonnet-v2",
      "claude-3-7-sonnet",
    ]) {
      expect(claudeSupportsAdaptiveThinking(id), id).toBe(false);
    }
  });

  it("defaults to adaptive for unparseable claude ids (new releases are 4.6+)", () => {
    expect(claudeSupportsAdaptiveThinking("claude-pro-next")).toBe(true);
  });

  it("returns false for non-claude ids", () => {
    expect(claudeSupportsAdaptiveThinking("gemini-2.5-pro")).toBe(false);
    expect(claudeSupportsAdaptiveThinking("deepseek-r1")).toBe(false);
  });
});

describe("claudeEffortLevels", () => {
  it("omits xhigh on the 4.6 series (Vertex returns 400 for xhigh)", () => {
    expect(claudeEffortLevels("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(claudeEffortLevels("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
  });

  it("offers the full ladder on 4.7+ and 5.x", () => {
    expect(claudeEffortLevels("claude-opus-4-7")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(claudeEffortLevels("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claudeEffortLevels("claude-sonnet-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("returns no effort levels for legacy budget-thinking models", () => {
    expect(claudeEffortLevels("claude-sonnet-4-5")).toEqual([]);
    expect(claudeEffortLevels("claude-haiku-4-5")).toEqual([]);
  });
});
