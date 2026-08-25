/**
 * Export all Vertex AI model definitions and discovery integration.
 *
 * Static model tables provide authoritative metadata (pricing, context window,
 * capabilities). Dynamic discovery via the Model Garden API adds models not yet
 * in the static tables.
 */

import type { VertexModelConfig } from "../types.js";
import type { DiscoveryOptions } from "../discovery.js";
import { discoverModels, mergeWithStatic } from "../discovery.js";
import { CLAUDE_MODELS } from "./claude.js";
import { GEMINI_MODELS } from "./gemini.js";
import { MAAS_MODELS } from "./maas.js";

/** All statically defined models (no discovery). */
export const STATIC_MODELS: VertexModelConfig[] = [
  ...GEMINI_MODELS,
  ...CLAUDE_MODELS,
  ...MAAS_MODELS,
].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Get all available models: static metadata merged with dynamic discovery.
 *
 * - Models in static tables get authoritative metadata
 * - Discovered MaaS models not in static tables get publisher defaults
 * - Discovered Google models not in static tables are logged but not registered
 */
export async function getAllModels(
  options?: DiscoveryOptions,
): Promise<{ models: VertexModelConfig[]; fromCache: boolean; discoveredCount: number; newModels: string[] }> {
  const { discovered, fromCache } = await discoverModels(options);

  if (discovered.length === 0) {
    // Discovery disabled or failed — static only
    return { models: STATIC_MODELS, fromCache: false, discoveredCount: 0, newModels: [] };
  }

  const { merged, newModels } = mergeWithStatic(discovered, STATIC_MODELS);
  const sorted = merged.sort((a, b) => a.id.localeCompare(b.id));

  return {
    models: sorted,
    fromCache,
    discoveredCount: discovered.length,
    newModels,
  };
}

export function getModelById(id: string): VertexModelConfig | undefined {
  // Check static first (fast path)
  return STATIC_MODELS.find((m) => m.id === id);
}

export function getModelsByEndpointType(type: "gemini" | "maas"): VertexModelConfig[] {
  return STATIC_MODELS.filter((m) => m.endpointType === type);
}

export { GEMINI_MODELS, CLAUDE_MODELS, MAAS_MODELS };
