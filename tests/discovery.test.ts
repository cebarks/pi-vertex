import { describe, expect, it } from "vitest";
import { type CachedAvailableModel, buildModelConfigs } from "../discovery.js";
import { STATIC_MODELS } from "../models/index.js";

const anthropic = (modelId: string, versionId = "default"): CachedAvailableModel => ({
  publisher: "anthropic",
  modelId,
  versionId,
});

describe("buildModelConfigs — Anthropic capability derivation", () => {
  it("derives adaptive thinking for a Claude model missing from the static table", () => {
    // Regression: claude-opus-5 was absent from models/claude.ts and inherited
    // PUBLISHER_DEFAULTS.anthropic, which left adaptiveThinking undefined and made
    // streaming/maas.ts send thinking.type=enabled -> Vertex 400.
    const configs = buildModelConfigs([anthropic("claude-opus-5")], []);
    expect(configs[0]).toMatchObject({
      id: "claude-opus-5",
      apiId: "claude-opus-5",
      adaptiveThinking: true,
    });
  });

  it("keeps legacy budget thinking for 4.5-era models that are not in the static table", () => {
    const configs = buildModelConfigs([anthropic("claude-sonnet-4-5", "20250929")], []);
    expect(configs[0].adaptiveThinking).toBe(false);
    expect(configs[0].apiId).toBe("claude-sonnet-4-5@20250929");
  });

  it("prefers authoritative static metadata over derivation", () => {
    const configs = buildModelConfigs([anthropic("claude-opus-4-8")], STATIC_MODELS);
    const opus = configs.find((c) => c.id === "claude-opus-4-8");
    expect(opus).toMatchObject({
      adaptiveThinking: true,
      contextWindow: 1000000,
      maxTokens: 128000,
    });
  });

  it("does not derive Claude capabilities for non-Anthropic publishers", () => {
    const configs = buildModelConfigs(
      [{ publisher: "google", modelId: "gemini-3-5-flash", versionId: "default" }],
      [],
    );
    expect(configs[0].adaptiveThinking).toBeUndefined();
  });
});
