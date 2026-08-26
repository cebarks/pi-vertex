/**
 * Dynamic model discovery via the Vertex AI Model Garden API.
 *
 * 1. Query publishers/{publisher}/models to get the global catalog
 * 2. Probe each model via countTokens to verify project-level access
 * 3. Enrich with static metadata for pricing/capabilities where available
 * 4. Register only models confirmed available
 *
 * Results cached to disk for configurable TTL (default 24h).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAccessToken, resolveProjectId } from "./auth.js";
import type { VertexModelConfig, ModelCost, EndpointType, ModelInputType } from "./types.js";

// --- Types ---

export interface DiscoveredModel {
  name: string;
  versionId: string;
  launchStage: string;
  publisher: string;
  modelId: string;
}

interface CachedAvailableModel {
  publisher: string;
  modelId: string;
  versionId: string;
}

interface DiscoveryCache {
  timestamp: number;
  available: CachedAvailableModel[];
}

interface PublisherDefaults {
  endpointType: EndpointType;
  contextWindow: number;
  maxTokens: number;
  input: ModelInputType[];
  reasoning: boolean;
  tools: boolean;
  adaptiveThinking?: boolean;
  cost: ModelCost;
  /** Region to use for probing and as default for streaming */
  probeRegion: string;
}

// --- Constants ---

const DEFAULT_PUBLISHERS = [
  "anthropic",
  "google",
  "meta",
  "mistralai",
  "deepseek-ai",
  "xai",
  "qwen",
  "moonshotai",
  "minimaxai",
  "openai",
  "zai-org",
];

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PER_PUBLISHER_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_CONCURRENCY = 8;

/** Model name suffixes/patterns for non-chat models */
const NON_CHAT_PATTERNS = ["-tts", "-embedding", "-imagen", "text-embedding", "textembedding", "-native-audio", "-image"];

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
    probeRegion: "us-east5",
  },
  google: {
    endpointType: "gemini",
    contextWindow: 1048576,
    maxTokens: 65535,
    input: ["text", "image"],
    reasoning: true,
    tools: true,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
    probeRegion: "global",
  },
  meta: {
    endpointType: "maas",
    contextWindow: 128000,
    maxTokens: 32000,
    input: ["text"],
    reasoning: true,
    tools: true,
    cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
    probeRegion: "us-central1",
  },
  mistralai: {
    endpointType: "maas",
    contextWindow: 128000,
    maxTokens: 32000,
    input: ["text"],
    reasoning: false,
    tools: true,
    cost: { input: 0.4, output: 2.0, cacheRead: 0, cacheWrite: 0 },
    probeRegion: "us-central1",
  },
  "deepseek-ai": {
    endpointType: "maas",
    contextWindow: 163840,
    maxTokens: 32000,
    input: ["text"],
    reasoning: true,
    tools: true,
    cost: { input: 0.6, output: 1.7, cacheRead: 0.06, cacheWrite: 0 },
    probeRegion: "us-central1",
  },
  xai: {
    endpointType: "maas",
    contextWindow: 200000,
    maxTokens: 32000,
    input: ["text", "image"],
    reasoning: true,
    tools: true,
    cost: { input: 1.0, output: 2.0, cacheRead: 0, cacheWrite: 0 },
    probeRegion: "us-central1",
  },
  _default: {
    endpointType: "maas",
    contextWindow: 128000,
    maxTokens: 32000,
    input: ["text"],
    reasoning: true,
    tools: true,
    cost: { input: 1.0, output: 3.0, cacheRead: 0, cacheWrite: 0 },
    probeRegion: "us-central1",
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

function readCache(ttlMs: number): CachedAvailableModel[] | null {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const cache: DiscoveryCache = JSON.parse(raw);
    if (Date.now() - cache.timestamp > ttlMs) return null;
    return cache.available;
  } catch {
    return null;
  }
}

/** Clear the discovery cache so the next startup re-probes. */
export function clearCache(): boolean {
  const cachePath = getCachePath();
  if (existsSync(cachePath)) {
    try { unlinkSync(cachePath); return true; } catch { return false; }
  }
  return false;
}

function writeCache(available: CachedAvailableModel[]): void {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = getCachePath();
  const tmpPath = `${cachePath}.tmp.${process.pid}`;
  const data: DiscoveryCache = { timestamp: Date.now(), available };
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, cachePath);
  } catch (err) {
    console.warn(`[pi-vertex] Failed to write discovery cache: ${err}`);
    try { require("node:fs").unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// --- API: List Models ---

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
      console.warn(`[pi-vertex] Discovery: ${publisher} list returned ${response.status}`);
      return [];
    }
    const data = (await response.json()) as {
      publisherModels?: Array<{ name: string; versionId?: string; launchStage?: string }>;
    };
    return (data.publisherModels ?? []).map((m) => {
      const parts = m.name.split("/");
      return {
        name: m.name,
        versionId: m.versionId ?? "default",
        launchStage: m.launchStage ?? "UNKNOWN",
        publisher,
        modelId: parts[parts.length - 1],
      };
    });
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? "timed out" : String(err);
    console.warn(`[pi-vertex] Discovery: ${publisher} list ${msg}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// --- API: Probe Access via countTokens ---

/**
 * Probe a model's project-level availability via countTokens.
 *
 * Response codes:
 *   200                              → available (Gemini)
 *   400 "countTokens is infeasible"  → available (Claude/MaaS — doesn't support countTokens)
 *   400 "Organization Policy"        → blocked by org policy → NOT available
 *   400 "is not servable"            → not servable in this region → NOT available
 *   404                              → not found / no access → NOT available
 */
async function probeModelAccess(
  publisher: string,
  modelId: string,
  region: string,
  accessToken: string,
  projectId: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Global endpoint uses aiplatform.googleapis.com (no region prefix)
    const baseUrl = region === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${region}-aiplatform.googleapis.com`;
    const url = `${baseUrl}/v1/projects/${projectId}/locations/${region}/publishers/${publisher}/models/${modelId}:countTokens`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "x-goog-user-project": projectId,
      },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      signal: controller.signal,
    });

    if (response.ok) return true; // 200 — available

    const data = (await response.json()) as { error?: { code?: number; message?: string } };
    const message = data.error?.message ?? "";

    // "countTokens is infeasible" = model exists but doesn't support countTokens (Claude/MaaS)
    if (message.includes("infeasible")) return true;

    // Everything else (404, org policy, not servable) = not available
    return false;
  } catch {
    return false; // timeout or network error — assume unavailable
  } finally {
    clearTimeout(timeout);
  }
}

/** Run probes in parallel with concurrency limit */
async function probeAll(
  models: DiscoveredModel[],
  accessToken: string,
  projectId: string,
): Promise<CachedAvailableModel[]> {
  const available: CachedAvailableModel[] = [];
  const queue = [...models];

  async function worker() {
    while (queue.length > 0) {
      const dm = queue.shift()!;
      const defaults = PUBLISHER_DEFAULTS[dm.publisher] ?? PUBLISHER_DEFAULTS._default;
      const ok = await probeModelAccess(dm.publisher, dm.modelId, defaults.probeRegion, accessToken, projectId);
      if (ok) {
        available.push({ publisher: dm.publisher, modelId: dm.modelId, versionId: dm.versionId });
      }
    }
  }

  const workers = Array.from({ length: PROBE_CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return available;
}

// --- Filtering ---

function isChatModel(model: DiscoveredModel): boolean {
  const id = model.modelId.toLowerCase();
  for (const pattern of NON_CHAT_PATTERNS) {
    if (id.includes(pattern)) return false;
  }
  return true;
}

// --- Config ---

export interface DiscoveryOptions {
  enabled?: boolean;
  cacheTtlMs?: number;
  publishers?: string[];
}

// --- Main ---

/**
 * Discover available models: list from Model Garden, probe for access, return available set.
 */
export async function discoverAvailableModels(
  options?: DiscoveryOptions,
): Promise<{ available: CachedAvailableModel[]; fromCache: boolean }> {
  const enabled = options?.enabled ?? true;
  if (!enabled) return { available: [], fromCache: false };

  const ttlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const publishers = options?.publishers ?? DEFAULT_PUBLISHERS;

  // Try cache
  const cached = readCache(ttlMs);
  if (cached) return { available: cached, fromCache: true };

  // Auth
  const projectId = resolveProjectId();
  if (!projectId) {
    console.warn("[pi-vertex] Discovery: no project ID, skipping");
    return { available: [], fromCache: false };
  }
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.warn(`[pi-vertex] Discovery: auth failed: ${err}`);
    return { available: [], fromCache: false };
  }

  // List all models from all publishers
  const listResults = await Promise.all(
    publishers.map((p) => fetchPublisherModels(p, accessToken, projectId)),
  );
  const allModels = listResults.flat().filter(isChatModel);

  // Probe each for project-level access
  const available = await probeAll(allModels, accessToken, projectId);

  // Cache results
  writeCache(available);
  console.log(`[pi-vertex] Discovery: ${available.length}/${allModels.length} models available`);

  return { available, fromCache: false };
}

/**
 * Build VertexModelConfig entries from available models,
 * enriching with static metadata where available.
 */
export function buildModelConfigs(
  available: CachedAvailableModel[],
  staticModels: VertexModelConfig[],
): VertexModelConfig[] {
  const staticById = new Map(staticModels.map((m) => [m.id, m]));
  const configs: VertexModelConfig[] = [];

  for (const am of available) {
    const staticConfig = staticById.get(am.modelId);
    if (staticConfig) {
      // Use authoritative static metadata
      configs.push(staticConfig);
    } else {
      // Generate from publisher defaults
      const defaults = PUBLISHER_DEFAULTS[am.publisher] ?? PUBLISHER_DEFAULTS._default;
      const name = am.modelId
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

      configs.push({
        id: am.modelId,
        name,
        apiId: am.publisher === "anthropic"
          ? (am.versionId !== "default" ? `${am.modelId}@${am.versionId}` : am.modelId)
          : am.modelId,
        publisher: am.publisher,
        endpointType: defaults.endpointType,
        contextWindow: defaults.contextWindow,
        maxTokens: defaults.maxTokens,
        input: [...defaults.input],
        reasoning: defaults.reasoning,
        tools: defaults.tools,
        adaptiveThinking: defaults.adaptiveThinking,
        cost: { ...defaults.cost },
        region: "global",
      });
    }
  }

  return configs.sort((a, b) => a.id.localeCompare(b.id));
}
