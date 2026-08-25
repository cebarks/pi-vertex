# @cebarks/pi-vertex: Dynamic Model Discovery Fork

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Fork `@lhl/pi-vertex` into `@cebarks/pi-vertex`, fix the baseUrl bug, and add dynamic model discovery via the Vertex AI Model Garden API so new models appear automatically without code changes.

**Architecture:** Hybrid static+dynamic approach. Static metadata tables provide pricing, context windows, and capabilities for known models. At startup, the Model Garden API (`publishers/{publisher}/models`) is queried for each publisher to discover what's actually available. Models found in the API are registered with their static metadata if known, or with publisher-based defaults if unknown. Results are cached to disk for 24h to avoid startup latency.

**Tech Stack:** TypeScript, Vertex AI REST API, `google-auth-library`, disk-based JSON cache

---

### Task 1: Rebrand package to @cebarks/pi-vertex

**Files:**
- Modify: `package.json`

**Step 1: Update package.json metadata**

Change these fields:
- `name`: `"@lhl/pi-vertex"` → `"@cebarks/pi-vertex"`
- `description`: add "with dynamic model discovery" suffix
- `version`: `"2.0.0"` (major bump — new scope + dynamic discovery is a breaking change for consumers)
- `author`: `"Anten Skrabec <cebarks@gmail.com>"`
- `repository.url`: `"git+https://github.com/cebarks/pi-vertex.git"`
- `homepage`: `"https://github.com/cebarks/pi-vertex#readme"`
- `bugs.url`: `"https://github.com/cebarks/pi-vertex/issues"`

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: rebrand to @cebarks/pi-vertex"
```

---

### Task 2: Fix the baseUrl bug

**Files:**
- Modify: `index.ts` (line ~52, `toPiModel()`)

**Step 1: Fix toPiModel() baseUrl**

Change `baseUrl: ""` to `baseUrl: undefined` in the `toPiModel()` function. The empty string wins the nullish coalesce (`??`) in pi-coding-agent's `applyExtension()` but then fails the falsy check. `undefined` correctly falls through to the provider-level baseUrl.

**Step 2: Commit**

```bash
git add index.ts
git commit -m "fix: use undefined baseUrl so provider-level fallback works

Empty string wins ?? coalesce but fails the subsequent falsy check in
pi-coding-agent's applyExtension(). Fixes #2."
```

---

### Task 3: Create the discovery module

**Files:**
- Create: `discovery.ts`

**Step 1: Write the discovery module**

The discovery module handles:
1. Querying the Model Garden API for each publisher
2. Caching results to disk (`~/.pi/agent/cache/pi-vertex-models.json`)
3. Merging discovered models with static metadata
4. Generating `VertexModelConfig` entries for unknown models using publisher defaults

**Key design decisions:**
- Cache file stores: `{ timestamp: number, models: DiscoveredModel[] }`
- TTL: 24 hours (configurable via config file)
- On cache miss or expiry: query API, write cache, return merged results
- On network error: fall back to static-only (log warning, don't crash)
- Publishers to query: `["anthropic", "google", "meta", "mistralai", "deepseek-ai", "xai", "qwen", "moonshotai", "minimaxai", "openai", "zai-org"]`

**Publisher defaults for unknown models:**

| Publisher | endpointType | contextWindow | maxTokens | input | reasoning | tools | cost (in/out/cacheRead/cacheWrite) |
|-----------|-------------|---------------|-----------|-------|-----------|-------|-----|
| anthropic | maas | 200000 | 64000 | text,image | true | true | 3/15/0.3/3.75 |
| google | gemini | 1048576 | 65536 | text,image | true | true | 1/5/0.1/0 |
| meta | maas | 128000 | 32000 | text | true | true | 0.5/1.5/0/0 |
| mistralai | maas | 128000 | 32000 | text | false | true | 0.4/2.0/0/0 |
| deepseek-ai | maas | 163840 | 32000 | text | true | true | 0.6/1.7/0.06/0 |
| xai | maas | 200000 | 32000 | text,image | true | true | 1.0/2.0/0/0 |
| others | maas | 128000 | 32000 | text | true | true | 1.0/3.0/0/0 |

**Model ID derivation:**
- From API: `publishers/anthropic/models/claude-sonnet-5` → id: `claude-sonnet-5`, publisher: `anthropic`
- API ID: For anthropic, use `{modelId}` (or `{modelId}@{versionId}` if versionId != "default"). For other MaaS, use `{publisher}/{apiModelId}-maas` pattern if matching existing conventions.
- For google/gemini models, keep the model name as-is since they don't use the publisher prefix path.

**Step 2: Write tests for discovery**

Test cache hit/miss, merge logic, publisher defaults, error fallback.

**Step 3: Commit**

```bash
git add discovery.ts tests/discovery.test.ts
git commit -m "feat: add dynamic model discovery via Model Garden API

Queries the Vertex AI publishers.models.list endpoint at startup for
each configured publisher. Results cached to disk for 24h. Unknown
models get publisher-based defaults for pricing/capabilities."
```

---

### Task 4: Refactor static model tables into a metadata registry

**Files:**
- Create: `models/registry.ts`
- Modify: `models/claude.ts` — convert to metadata-only (remove as primary source, keep as enrichment data)
- Modify: `models/gemini.ts` — same
- Modify: `models/maas.ts` — same
- Modify: `models/index.ts` — use registry + discovery

**Step 1: Create the metadata registry**

The registry is a `Map<string, VertexModelConfig>` keyed by model ID. Static model data from `claude.ts`, `gemini.ts`, `maas.ts` populates it. When discovery finds a model ID that exists in the registry, use the static metadata. When discovery finds an unknown model, generate metadata from publisher defaults.

**Step 2: Update models/index.ts**

Replace the static `ALL_MODELS` export with a function that:
1. Loads static models into the registry
2. Runs discovery (cached)
3. Merges: discovered models get static metadata if available, otherwise publisher defaults
4. Returns the merged list

Export `async function getAllModels(): Promise<VertexModelConfig[]>` instead of the current sync `ALL_MODELS` constant.

**Step 3: Commit**

```bash
git add models/
git commit -m "refactor: convert static models to metadata registry

Static model definitions now serve as enrichment data for discovered
models rather than being the sole source of truth."
```

---

### Task 5: Make index.ts async-aware for discovery

**Files:**
- Modify: `index.ts`

**Step 1: Update extension entry point**

The extension entry point needs to:
1. Call `getAllModels()` (async — does discovery + merge)
2. Register the provider with the discovered models
3. Show discovery stats in the startup widget

The pi extension API's `registerProvider` is synchronous, so we need to run discovery before calling it. The extension default export can return a Promise (pi awaits it).

**Step 2: Update startup widget to show discovery info**

Show: `[pi-vertex] Discovered N models (M from cache, K new)`

**Step 3: Commit**

```bash
git add index.ts
git commit -m "feat: integrate dynamic discovery into extension startup

Extension now discovers available models at startup via the Model
Garden API (with 24h disk cache), falling back to static-only on
network errors."
```

---

### Task 6: Add discovery cache config

**Files:**
- Modify: `config.ts`
- Modify: `types.ts`

**Step 1: Add config options**

Add to `VertexConfig`:
- `discoveryCacheTtlMs?: number` — cache TTL in ms (default: 86400000 = 24h)
- `discoveryEnabled?: boolean` — toggle discovery (default: true)
- `discoveryPublishers?: string[]` — list of publishers to query (default: all known)

**Step 2: Commit**

```bash
git add config.ts types.ts
git commit -m "feat: add discovery configuration options

Users can disable discovery, customize cache TTL, and control which
publishers are queried via pi-vertex.json config."
```

---

### Task 7: Update README and CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Update README**

Document:
- Fork origin and motivation
- Dynamic discovery feature
- Config options
- Migration from `@lhl/pi-vertex`

**Step 2: Update CHANGELOG**

Add 2.0.0 entry covering: rebrand, baseUrl fix, dynamic discovery.

**Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: update README and CHANGELOG for 2.0.0"
```

---

### Task 8: Test end-to-end and publish

**Step 1: Install and test locally**

```bash
cd ~/code/pi-vertex
npm install
npm run build
npm test
```

**Step 2: Test in pi by linking**

```bash
# Point pi settings to the local fork
cd ~/.pi/agent/npm
npm install ~/code/pi-vertex
```

Update `~/.pi/agent/settings.json`: change `"npm:@lhl/pi-vertex"` to `"npm:@cebarks/pi-vertex"` in packages.

**Step 3: Verify in pi**

Start pi, check `/model` shows discovered models including claude-sonnet-5, claude-opus-4-8, claude-haiku-4-5.

**Step 4: Publish to npm**

```bash
cd ~/code/pi-vertex
npm publish --access public
```

**Step 5: Install from npm in pi**

```bash
cd ~/.pi/agent/npm
npm install @cebarks/pi-vertex
```

**Step 6: Commit settings change**

Update both `~/.pi/agent/settings.json` and `~/.pi/agent-prodsec/settings.json` to reference the new package.
