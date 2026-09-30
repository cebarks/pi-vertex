# Test Coverage

## Current Status
- **Automated tests**: ✅ 128 tests across 9 files — auth, config, utils, models, discovery enrichment, Gemini message conversion, streaming dispatch, mocked Gemini streaming, and mocked MaaS (Anthropic + OpenAI-compat) streaming including the thinking payload and transcript replay.
- **Environment independence**: the suite passes with a real GCP environment exported (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `CLOUD_ML_REGION`). `tests/auth.test.ts` strips those keys from its per-test `process.env` baseline, because each of those assertions is about fallback order and an ambient value would outrank the fixture.
- **Lint/type checks**: Biome + TypeScript (`npm run check`, `npm run build`) — both clean.
- **CI**: GitHub Actions runs `build` + `check` and `test:coverage` (with a coverage artifact) on every PR and push to `main`.

## Test Files
| File | Coverage |
|------|----------|
| `tests/utils.test.ts` | `sanitizeText`, `retainThoughtSignature`, `mapStopReason`, `calculateCost`, `convertTools`, `convertToolsForGemini`, and the Claude thinking helpers: `claudeVersion` parsing, `claudeSupportsAdaptiveThinking` (4.6+/5.x vs 4.5-, unparseable ids default adaptive), `claudeEffortLevels` (4.6 has no `xhigh`), `mapAnthropicEffort` rung stepping |
| `tests/auth.test.ts` | `resolveProjectId`, `resolveLocation`, `hasAdcCredentials`, `getAuthConfig`, `buildBaseUrl` — config/env fallback chains against a scrubbed env baseline |
| `tests/config.test.ts` | `getConfigPath`, `loadConfig` (with mocked FS) |
| `tests/models.test.ts` | Model definitions integrity, uniqueness, field validation |
| `tests/convert-to-gemini.test.ts` | `convertToGeminiMessages` — user text/images, assistant text/thinking/tool calls, tool results including images and missing-result synthesis, cross-provider signatures, multi-turn conversations |
| `tests/streaming-dispatch.test.ts` | `streamVertex` endpoint type dispatch (gemini/maas routing, error on unknown type) |
| `tests/streaming-gemini.test.ts` | `streamGemini` integration-style tests with mocked `@google/genai`: Gemini 2.5 default thinking budgets, Gemini 3/3.5 native defaults, cached-token usage, safety termination |
| `tests/discovery.test.ts` | `buildModelConfigs()` static-vs-synthesized enrichment, including thinking mode derived from the model id for undiscovered Claude models (the `claude-opus-5` 400), and `isChatModel()` filtering |
| `tests/streaming-maas.test.ts` | `streamMaaS` Anthropic path (happy path, regional pricing, tool_use stop reason, sync error path, exactly-one `stream.end()` regression test), OpenAI-compat path (event relay + model id rewrite, via a mocked `@earendil-works/pi-ai/compat`), transcript replay (system prompt from the leading system message, tool declarations, mid-conversation tool deltas, no system role in the message array, tool-name sanitization round-trip), and the thinking payload (adaptive vs legacy budget per model family, effort ladder, budget clamp, no-thinking when no reasoning level) |

## Not covered
- **`discovery.ts` probing and cache plumbing.** `buildModelConfigs()` and `isChatModel()` are now covered, but `probeModelAccess()`'s response-code mapping (`200` vs `400 infeasible` vs `404`/org-policy) and the `probeAll()` cursor are not, and they are the parts most likely to regress silently; both are reachable with a mocked `fetch`. Cache read/write/TTL handling touches `~/.pi/agent/cache` and needs `node:fs` mocks.

## Gaps / Next Steps
- Add broader integration tests for `streaming/gemini.ts` event sequencing (text/thinking/tool-call chunks).
- Expand `streaming/maas.ts` Anthropic-path coverage: thinking blocks *with signatures* replayed across turns (payload selection is covered; signature validity/`isSameModel` handling is not), multi-turn tool-result adjacency, tool-id sanitization edge cases.
- Add tests for `index.ts` extension entry point (requires mocking `pi-coding-agent` ExtensionAPI).
- Tighten the `any` usage in `streaming/maas.ts` (currently disabled via biome override) by introducing an internal type for the normalize/replay pipeline.
