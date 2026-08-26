import { describe, expect, it } from "vitest";
import { STATIC_MODELS, getModelById, getModelsByEndpointType } from "../models/index.js";

describe("static models", () => {
  it("has at least 45 models registered", () => {
    expect(STATIC_MODELS.length).toBeGreaterThanOrEqual(45);
  });

  it("every model has required fields", () => {
    for (const model of STATIC_MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(model.apiId).toBeTruthy();
      expect(model.publisher).toBeTruthy();
      expect(model.endpointType).toMatch(/^(gemini|maas)$/);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxTokens).toBeGreaterThan(0);
      expect(model.cost.input).toBeGreaterThanOrEqual(0);
      expect(model.cost.output).toBeGreaterThanOrEqual(0);
    }
  });

  it("has unique ids", () => {
    const ids = STATIC_MODELS.map((m: { id: string }) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("getModelById returns model when found", () => {
    const model = getModelById("claude-opus-4-7");
    expect(model).toBeDefined();
    expect(model?.name).toBe("Claude Opus 4.7");
  });

  it("getModelById returns undefined when not found", () => {
    expect(getModelById("nonexistent-model")).toBeUndefined();
  });

  it("getModelsByEndpointType filters correctly", () => {
    const geminiModels = getModelsByEndpointType("gemini");
    expect(geminiModels.every((m: { endpointType: string }) => m.endpointType === "gemini")).toBe(true);

    const maasModels = getModelsByEndpointType("maas");
    expect(maasModels.every((m: { endpointType: string }) => m.endpointType === "maas")).toBe(true);
  });

  it("Claude models have correct publisher", () => {
    const claudeModels = STATIC_MODELS.filter((m: { id: string }) => m.id.startsWith("claude-"));
    expect(claudeModels.length).toBeGreaterThan(0);
    for (const model of claudeModels) {
      expect(model.publisher).toBe("anthropic");
    }
  });

  it("includes new Claude models (sonnet-5, opus-4-8)", () => {
    expect(getModelById("claude-sonnet-5")).toMatchObject({
      name: "Claude Sonnet 5",
      contextWindow: 1000000,
      maxTokens: 128000,
      cost: { input: 2.0, output: 10.0 },
    });
    expect(getModelById("claude-opus-4-8")).toMatchObject({
      name: "Claude Opus 4.8",
      contextWindow: 1000000,
      maxTokens: 128000,
      cost: { input: 5.0, output: 25.0 },
    });
  });

  it("Claude 4.6+ models use current Vertex output limits and regional pricing", () => {
    expect(getModelById("claude-opus-4-7")).toMatchObject({
      maxTokens: 128000,
      cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
      costRegional: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
    });
    expect(getModelById("claude-opus-4-6")).toMatchObject({
      maxTokens: 128000,
      cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
      costRegional: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
    });
    expect(getModelById("claude-sonnet-4-6")).toMatchObject({
      maxTokens: 128000,
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      costRegional: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
    });
  });

  it("Gemini models have correct publisher", () => {
    const geminiModels = STATIC_MODELS.filter((m: { id: string }) => m.id.startsWith("gemini-"));
    expect(geminiModels.length).toBeGreaterThan(0);
    for (const model of geminiModels) {
      expect(model.publisher).toBe("google");
    }
  });

  it("registers Gemini 3.5 Flash with GA Vertex metadata", () => {
    expect(getModelById("gemini-3.5-flash")).toMatchObject({
      name: "Gemini 3.5 Flash",
      apiId: "gemini-3.5-flash",
      contextWindow: 1048576,
      maxTokens: 65535,
      reasoning: true,
      tools: true,
      cost: { input: 1.5, output: 9.0, cacheRead: 0.15, cacheWrite: 0 },
    });
  });

  it("registers MaaS models from multiple publishers", () => {
    expect(getModelById("grok-4.20-reasoning")).toMatchObject({
      publisher: "xai",
      contextWindow: 200000,
      input: ["text", "image"],
      cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    });
    expect(getModelById("gemma-4-26b-a4b-it")).toMatchObject({
      publisher: "google",
      contextWindow: 262144,
      maxTokens: 128000,
      input: ["text", "image"],
      tools: false,
    });
  });
});
