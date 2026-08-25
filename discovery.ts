/**
 * Dynamic model discovery via the Vertex AI Model Garden API.
 *
 * Queries publishers/{publisher}/models at startup to discover available models.
 * Results are cached to disk for configurable TTL (default 24h).
 * Unknown models get publisher-based defaults for pricing/capabilities.
 *
 * Claude and MaaS models discovered dynamically are registered with heuristic
 * apiIds and graceful streaming-time error handling. Google/Gemini models are
 * discovered but only registered if they exist in the static metadata table
 * (the Gemini streaming path differs from MaaS and can't be safely guessed).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAccessToken, resolveProjectId } from "./auth.js";
import type { VertexModelConfig, ModelCost, EndpointType, ModelInputType } from "./types.js";

// --- Types ---

export interface DiscoveredModel {
  /** e.g. "publishers/anthropic/models/claude-sonnet-5" */
  name: string;
  /** e.g. "default" or "20251001" */
  versionId: string;
  /** e.g. "GA" */
  launchStage: string;
  /** Extracted publisher, e.g. "anthropic" */
  publisher: string;
  /** Extracted model ID, e.g. "claude-sonnet-5" */
  modelId: string;
}

interface DiscoveryCache {
  timestamp: number;
  models: DiscoveredModel[];
}

interface PublisherDefaults {
  endpointType: EndpointType;
  contextWindow: number;
  maxTokens: number;
  input: ModelInputType[];
  reasoning: boolean;
  tools: boolean;
  cost: ModelCost;
}

// --- Constants ---

const DEFAULT_PUBLISHERS = [
  "anthropic",
  "meta",
  "mistralai",
  "deepseek-ai",
  "xai",
  "qwen",
  "moonshotai",
  "minimaxai",
  "openai",
  "zai-org",
  "google", // Discovered but only registered if in static table
];

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PER_PUBLISHER_TIMEOUT_MS = 5000;

/** Model name suffixes that indicate non-chat models */
const NON_CHAT_SUFFIXES = ["-tts", "-embedding", "-imagen", "-vision-encoder"];

/** Model name patterns for non-chat models (partial match) */
const NON_CHAT_PATTERNS = ["text-embedding", "textembedding", "imagen"];

// --- Publisher Defaults ---

const PUBLISHER_DEFAULTS: Record<string, PublisherDefaults> = {
  anthropic: {
    endpointType: "maas",
    contextWindow: 200000,
    maxTokens: 64000,
    input: ["text", "image"],
    reasoning: true,
    tools: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  google: {
    endpointType: "gemini",
    contextWindow: 1048576,
    maxTokens: 65536,
    input: ["text", "image"],
    reasoning: true,
    tools: true,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
  },
  meta: {
    endpointType: "maas",
    contextWindow: 128000,
    maxTokens: 32000,
    input: ["text"],
    reasoning: true,
    tools: true,
    cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
  },
  mistralai: {
    endpointType: "maas",
    contextWindow: 128000,
    maxTokens: 32000,
    input: ["text"],
    reasoning: false,
    tools: true,
    cost: { input: 0.4, output: 2.0, cacheRead: 0, cacheWrite: 0 },
  },
  "deepseek-ai": {
    endpointType: "maas",
    contextWindow: 163840,
    maxTokens: 32000,
    input: ["text"],
    reasoning: true,
    tools: true,
    cost: { input: 0.6, output: 1.7, cacheRead: 0.06, cacheWrite: 0 },
  },
  xai: {
    endpointType: "maas",
    contextWindow: 200000,
    maxTokens: 32000,
    input: ["text", "image"],
    reasoning: true,
    tools: true,
    cost: { input: 1.0, output: 2.0, cacheRead: 0, cacheWrite: 0 },
  },
  _default: {
    endpointType: "maas",
    contextWindow: 128000,
    maxTokens: 32000,
    input: ["text"],
    reasoning: true,
    tools: true,
    cost: { input: 1.0, output: 3.0, cacheRead: 0, cacheWrite: 0 },
  },
};

// --- Cache ---

function getCacheDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".pi", "agent", "cache");
}

function getCachePath(): string {
  return join(getCacheDir(), "pi-vertex-models.json");
}

function readCache(ttlMs: number): DiscoveredModel[] | null {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;

  try {
    const raw = readFileSync(cachePath, "utf-8");
    const cache: DiscoveryCache = JSON.parse(raw);
    if (Date.now() - cache.timestamp > ttlMs) return null;
    return cache.models;
  } catch {
    // Corrupt cache — treat as miss
    return null;
  }
}

function writeCache(models: DiscoveredModel[]): void {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });

  const cachePath = getCachePath();
  const tmpPath = `${cachePath}.tmp.${process.pid}`;
  const data: DiscoveryCache = { timestamp: Date.now(), models };

  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, cachePath); // Atomic on same filesystem
  } catch (err) {
    console.warn(`[pi-vertex] Failed to write discovery cache: ${err}`);
    // Clean up tmp file if rename failed
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

// --- API ---

async function fetchPublisherModels(
  publisher: string,
  accessToken: string,
  projectId: string,
): Promise<DiscoveredModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PER_PUBLISHER_TIMEOUT_MS);

  try {
    const url = `https://aiplatform.googleapis.com/v1beta1/publishers/${publisher}/models?pageSize=100`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-goog-user-project": projectId,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[pi-vertex] Discovery: ${publisher} returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      publisherModels?: Array<{
        name: string;
        versionId?: string;
        launchStage?: string;
      }>;
    };

    return (data.publisherModels ?? []).map((m) => {
      const parts = m.name.split("/");
      const modelId = parts[parts.length - 1];
      return {
        name: m.name,
        versionId: m.versionId ?? "default",
        launchStage: m.launchStage ?? "UNKNOWN",
        publisher,
        modelId,
      };
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.warn(`[pi-vertex] Discovery: ${publisher} timed out`);
    } else {
      console.warn(`[pi-vertex] Discovery: ${publisher} failed: ${err}`);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function isChatModel(model: DiscoveredModel): boolean {
  const id = model.modelId.toLowerCase();
  for (const suffix of NON_CHAT_SUFFIXES) {
    if (id.endsWith(suffix)) return false;
  }
  for (const pattern of NON_CHAT_PATTERNS) {
    if (id.includes(pattern)) return false;
  }
  return true;
}

// --- Main Discovery ---

export interface DiscoveryOptions {
  enabled?: boolean;
  cacheTtlMs?: number;
  publishers?: string[];
}

export interface DiscoveryResult {
  discovered: DiscoveredModel[];
  fromCache: boolean;
  newGeminiModels: string[]; // Discovered Google models not in static table
}

/**
 * Discover available models from the Vertex AI Model Garden.
 * Returns discovered models, using cache when fresh.
 */
export async function discoverModels(
  options?: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const enabled = options?.enabled ?? true;
  if (!enabled) {
    return { discovered: [], fromCache: false, newGeminiModels: [] };
  }

  const ttlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const publishers = options?.publishers ?? DEFAULT_PUBLISHERS;

  // Try cache first
  const cached = readCache(ttlMs);
  if (cached) {
    return { discovered: cached, fromCache: true, newGeminiModels: [] };
  }

  // Fetch from API
  const projectId = resolveProjectId();
  if (!projectId) {
    console.warn("[pi-vertex] Discovery: no project ID, skipping");
    return { discovered: [], fromCache: false, newGeminiModels: [] };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.warn(`[pi-vertex] Discovery: auth failed, skipping: ${err}`);
    return { discovered: [], fromCache: false, newGeminiModels: [] };
  }

  // Query all publishers in parallel
  const results = await Promise.all(
    publishers.map((p) => fetchPublisherModels(p, accessToken, projectId)),
  );

  const allModels = results.flat().filter(isChatModel);

  // Cache results
  writeCache(allModels);

  return { discovered: allModels, fromCache: false, newGeminiModels: [] };
}

/**
 * Merge discovered models with the static metadata table.
 *
 * - Models in static table: use static metadata (authoritative pricing/capabilities)
 * - Anthropic/MaaS models NOT in static table: generate from publisher defaults
 * - Google models NOT in static table: log as detected, skip registration
 */
export function mergeWithStatic(
  discovered: DiscoveredModel[],
  staticModels: VertexModelConfig[],
): { merged: VertexModelConfig[]; newGeminiModels: string[] } {
  const staticById = new Map(staticModels.map((m) => [m.id, m]));
  const merged = new Map<string, VertexModelConfig>();
  const newGeminiModels: string[] = [];

  // Start with all static models
  for (const m of staticModels) {
    merged.set(m.id, m);
  }

  // Merge discovered models
  for (const dm of discovered) {
    if (merged.has(dm.modelId)) {
      // Already have static metadata — keep it
      continue;
    }

    if (dm.publisher === "google") {
      // Google models need static metadata for correct endpointType
      newGeminiModels.push(dm.modelId);
      continue;
    }

    // Generate config from publisher defaults
    const config = generateModelConfig(dm);
    if (config) {
      merged.set(dm.modelId, config);
    }
  }

  return { merged: Array.from(merged.values()), newGeminiModels };
}

/**
 * Generate a VertexModelConfig for a dynamically discovered model
 * using publisher defaults and heuristic apiId.
 */
function generateModelConfig(dm: DiscoveredModel): VertexModelConfig | null {
  const defaults = PUBLISHER_DEFAULTS[dm.publisher] ?? PUBLISHER_DEFAULTS._default;

  // Derive apiId based on publisher conventions
  const apiId = deriveApiId(dm);

  // Derive a human-readable name
  const name = dm.modelId
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return {
    id: dm.modelId,
    name,
    apiId,
    publisher: dm.publisher,
    endpointType: defaults.endpointType,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
    input: [...defaults.input],
    reasoning: defaults.reasoning,
    tools: defaults.tools,
    cost: { ...defaults.cost },
    region: "global",
  };
}

/**
 * Derive the API model identifier based on publisher conventions.
 *
 * - anthropic: plain model name, with @version if not "default"
 * - Other MaaS: try {publisher}/{modelId}-maas pattern (common convention)
 */
function deriveApiId(dm: DiscoveredModel): string {
  if (dm.publisher === "anthropic") {
    // Anthropic uses plain model IDs, optionally versioned
    if (dm.versionId && dm.versionId !== "default") {
      return `${dm.modelId}@${dm.versionId}`;
    }
    return dm.modelId;
  }

  // For other MaaS publishers, the convention varies.
  // Use the plain model name — the streaming layer will attempt this
  // and fall back gracefully on 404.
  return dm.modelId;
}
