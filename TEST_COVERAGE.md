# Test Coverage

## Current Status
- **Automated tests**: ✅ 93 tests across auth, config, utils, models, Gemini message conversion, streaming dispatch, mocked Gemini streaming, and mocked MaaS (Anthropic + OpenAI-compat) streaming.
- **Environment independence**: the suite passes with a real GCP environment exported (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `CLOUD_ML_REGION`). `tests/auth.test.ts` strips those keys from its per-test `process.env` baseline, because each of those assertions is about fallback order and an ambient value would outrank the fixture.
- **Lint/type checks**: Biome + TypeScript (`npm run check`, `npm run build`) — both clean.
- **CI**: GitHub Actions runs `build` + `check` and `test:coverage` (with a coverage artifact) on every PR and push to `main`.

## Test Files
| File | Coverage |
|------|----------|
| `tests/utils.test.ts` | `sanitizeText`, `retainThoughtSignature`, `mapStopReason`, `calculateCost`, `convertTools`, `convertToolsForGemini` |
| `tests/auth.test.ts` | `resolveProjectId`, `resolveLocation`, `hasAdcCredentials`, `getAuthConfig`, `buildBaseUrl` — config/env fallback chains against a scrubbed env baseline |
| `tests/config.test.ts` | `getConfigPath`, `loadConfig` (with mocked FS) |
| `tests/models.test.ts` | Model definitions integrity, uniqueness, field validation |
| `tests/convert-to-gemini.test.ts` | `convertToGeminiMessages` — user text/images, assistant text/thinking/tool calls, tool results including images and missing-result synthesis, cross-provider signatures, multi-turn conversations |
| `tests/streaming-dispatch.test.ts` | `streamVertex` endpoint type dispatch (gemini/maas routing, error on unknown type) |
| `tests/streaming-gemini.test.ts` | `streamGemini` integration-style tests with mocked `@google/genai`: Gemini 2.5 default thinking budgets, Gemini 3/3.5 native defaults, cached-token usage, safety termination |
| `tests/streaming-maas.test.ts` | `streamMaaS` Anthropic path (happy path, regional pricing, tool_use stop reason, sync error path, exactly-one `stream.end()` regression test) and OpenAI-compat path (event relay + model id rewrite, via a mocked `@earendil-works/pi-ai/compat`) |

## Not covered
- **`discovery.ts` — the 2.x headline feature has no tests.** `buildModelConfigs()` (static-metadata enrichment vs publisher defaults, anthropic `@version` apiId rewriting, sort order) and `isChatModel()` are pure and cheap to cover; `probeModelAccess()`'s response-code mapping (`200` vs `400 infeasible` vs `404`/org-policy) and the `probeAll()` cursor are the parts most likely to regress silently, and are reachable with a mocked `fetch`. Cache read/write/TTL handling touches `~/.pi/agent/cache` and needs `node:fs` mocks.

## Gaps / Next Steps
- Add broader integration tests for `streaming/gemini.ts` event sequencing (text/thinking/tool-call chunks).
- Expand `streaming/maas.ts` Anthropic-path coverage: thinking blocks with signatures, multi-turn tool-result adjacency, tool-id sanitization edge cases.
- Add tests for `index.ts` extension entry point (requires mocking `pi-coding-agent` ExtensionAPI).
- Tighten the `any` usage in `streaming/maas.ts` (currently disabled via biome override) by introducing an internal type for the normalize/replay pipeline.
