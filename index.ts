/**
 * @cebarks/pi-vertex - Google Vertex AI provider for Pi coding agent
 *
 * Fork of @lhl/pi-vertex with dynamic model discovery.
 *
 * Supports:
 * - Gemini models (via @google/genai)
 * - Claude models (via Anthropic Vertex SDK)
 * - All MaaS models (Llama, Mistral, DeepSeek, etc. via OpenAI-compatible endpoint)
 * - Dynamic model discovery via the Vertex AI Model Garden API
 *
 * Configuration (resolution order: config file → env var):
 *
 *   Config file: ~/.pi/agent/settings/pi-vertex.json
 *     {
 *       "googleCloudProject": "my-gcp-project",
 *       "googleCloudLocation": "us-central1",
 *       "googleApplicationCredentials": "/path/to/service-account.json",
 *       "discoveryEnabled": true,
 *       "discoveryCacheTtlMs": 86400000,
 *       "discoveryPublishers": ["anthropic", "meta", "mistralai", ...]
 *     }
 *
 *   Env vars (fallback):
 *     GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT  (required)
 *     GOOGLE_CLOUD_LOCATION                   (optional, default: model region or us-central1)
 *     GOOGLE_APPLICATION_CREDENTIALS          (optional, for service account auth)
 *
 * Usage:
 *   pi --provider vertex --model claude-opus-4-6
 *   pi --provider vertex --model gemini-2.5-pro
 *   pi --provider vertex --model llama-4-maverick
 */

import type { Api, Context, Model } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { hasAdcCredentials, resolveProjectId } from "./auth.js";
import { getConfigPath, loadConfig } from "./config.js";
import { getAllModels, getModelById, STATIC_MODELS } from "./models/index.js";
import { clearCache } from "./discovery.js";
import { streamVertex } from "./streaming/index.js";
import type { StreamOptions } from "./types.js";
import type { VertexModelConfig } from "./types.js";

/**
 * Convert Vertex model config to Pi model format
 */
function toPiModel(config: VertexModelConfig): Model<Api> {
  return {
    id: config.id,
    name: config.name,
    api: "vertex-unified",
    provider: "vertex",
    // Must be undefined (not "") so pi's applyExtension() falls through to
    // provider-level baseUrl via ??. Empty string wins the coalesce but fails
    // the falsy check. Actual URLs built in streaming/index.ts.
    baseUrl: undefined as unknown as string,
    reasoning: config.reasoning,
    input: config.input,
    cost: config.cost,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    headers: {},
  };
}

/**
 * Extension entry point (async — pi awaits extension factory functions)
 */
export default async function (pi: ExtensionAPI) {
  const config = loadConfig();

  // Apply credentialsFile to environment so all Google SDKs pick it up.
  if (config.googleApplicationCredentials && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = config.googleApplicationCredentials;
  }

  const projectId = resolveProjectId();

  if (!projectId) {
    console.log(
      `[pi-vertex] Skipping: no project ID found.\n  Config file: set "project" in ${getConfigPath()}\n  Env var: export GOOGLE_CLOUD_PROJECT=your-project-id`,
    );
    return;
  }

  if (!hasAdcCredentials()) {
    console.log(
      `[pi-vertex] Skipping: ADC credentials not found.\n  Run: gcloud auth application-default login\n  Or set "credentialsFile" in ${getConfigPath()}`,
    );
    return;
  }

  // Discover available models (list + probe, cached to disk)
  const { models: allModels, fromCache, count } = await getAllModels({
    enabled: config.discoveryEnabled,
    cacheTtlMs: config.discoveryCacheTtlMs,
    publishers: config.discoveryPublishers,
  });

  // Build a lookup for streaming dispatch
  const modelById = new Map(allModels.map((m) => [m.id, m]));

  // Register the provider
  pi.registerProvider("vertex", {
    baseUrl: "https://aiplatform.googleapis.com",
    apiKey: "GOOGLE_CLOUD_PROJECT",
    api: "vertex-unified",
    models: allModels.map(toPiModel),

    streamSimple: (model: Model<Api>, context: Context, options?: StreamOptions) => {
      const vertexModel = modelById.get(model.id) ?? getModelById(model.id);
      if (!vertexModel) {
        throw new Error(`Unknown Vertex model: ${model.id}`);
      }

      return streamVertex(vertexModel, context, options);
    },
  });

  // Build startup info
  const cacheNote = fromCache ? "cached" : "fresh";
  const vertexStartupLines: string[] = [
    `   [pi-vertex] Project: ${projectId} | ${count} models available (${cacheNote})`,
  ];

  // Register /vertex-refresh command
  pi.registerCommand("vertex-refresh", {
    description: "Re-probe Vertex AI model availability and update the cache.",
    handler: async (_args) => {
      clearCache();
      const { models, count } = await getAllModels({
        enabled: true,
        cacheTtlMs: 0, // Force fresh probe
        publishers: config.discoveryPublishers,
      });

      // Update the lookup used by streamSimple
      modelById.clear();
      for (const m of models) modelById.set(m.id, m);

      const names = models.map((m) => m.id).join(", ");
      pi.sendMessage({
        customType: "pi-vertex-refresh",
        content: `Vertex model cache refreshed. ${count} models available: ${names}`,
        display: true,
      });
    },
  });

  // Show startup widget that clears on first user input
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    ctx.ui.setWidget("pi-vertex-startup", (_tui, theme) => ({
      render: () => [...vertexStartupLines.map((l: string) => theme.fg("muted", l)), ""],
      invalidate: () => {},
    }));
  });
  pi.on("input", async (_event: InputEvent, ctx: ExtensionContext) => {
    ctx.ui.setWidget("pi-vertex-startup", undefined);
  });
}

// Export types and utilities for advanced usage
export * from "./types.js";
export * from "./models/index.js";
export * from "./auth.js";
export * from "./config.js";
export * from "./streaming/index.js";
export * from "./discovery.js";
