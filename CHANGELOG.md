# Changelog

All notable changes to this project will be documented in this file.

## [2.1.2] - 2026-08-29
### Fixed
- **`streamSimpleOpenAICompletions` is imported from `@earendil-works/pi-ai/compat`.** The bare specifier resolves to `pi-ai/dist/index.js` under plain Node, which does not re-export it — only pi's extension loader aliases root → compat (`getAliases()` for node mode, `VIRTUAL_MODULES` for the compiled binary). The previous top-level `require("@earendil-works/pi-ai")` therefore worked inside pi but threw `ERR_MODULE_NOT_FOUND: No "exports" main defined` under Node, which made `tests/streaming-maas.test.ts` impossible to collect. `/compat` is present in both pi maps *and* in pi-ai's `exports`, so the MaaS path is now importable everywhere and the loose hand-written function signature (plus its `eslint-disable` for `no-require-imports`) is gone — `tsc` type-checks the real call site.
- **`npm run check` passes on `main`.** Import ordering and formatting had drifted in `index.ts`, `models/index.ts`, `discovery.ts`, `streaming/gemini.ts` and `tests/models.test.ts` — invisible because GitHub Actions has never executed on this fork.
- **Stale `require("node:fs")`** in the discovery cache write-cleanup replaced with the `unlinkSync` already imported at the top of the file.

### Changed
- `probeAll()` hands work to its 8 workers from a shared cursor instead of `queue.shift()!`: no non-null assertion (the last `biome check` failure in application code) and no O(n) shift per item.
- **Test suite is hermetic to the developer's environment.** `tests/auth.test.ts` now builds its `process.env` baseline with `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `CLOUD_ML_REGION` and `GOOGLE_APPLICATION_CREDENTIALS` removed. Those tests assert on fallback *order*, so a shell that exports a real project ID inverted two of them (`resolveProjectId()` returned the ambient project, `resolveLocation()` the ambient region). Test count: 93 passing across 8 files.
- `biome.json` disables the formatter for `package.json`. npm rewrites that file on every `npm version` and re-expands short arrays onto separate lines, which biome then reports as a format error — a release bump should not redden CI.

## [2.1.1] - 2026-08-25
### Fixed
- `streamSimpleOpenAICompletions` reached through a `require()` of the root `@earendil-works/pi-ai` specifier, sidestepping pi's jiti module map not exposing `pi-ai/api/*` subpaths. Superseded in 2.1.2 by the `/compat` subpath import, which resolves under both pi and plain Node.

## [2.1.0] - 2026-08-25
### Changed
- Dependencies and peer dependencies moved from the `@mariozechner/pi-*` scope to `@earendil-works/pi-*` (pi-ai, pi-coding-agent).
- `npm audit` findings cleared, with `protobufjs` ^7.6.5, `ws` ^8.21.0 and `uuid` ^11.1.1 pinned via `overrides`.

## [2.0.1] - 2026-08-25
### Added
- `/vertex-refresh` command: clears the discovery cache, re-probes, rebuilds the id → model lookup used by `streamSimple`, and reports the resulting model list in-session.

## [2.0.0] - 2026-08-25
### Added
- **Dynamic model discovery** (`discovery.ts`): lists `publishers/{publisher}/models` (v1beta1) for 11 publishers, filters non-chat models, then enriches each hit with static metadata or publisher defaults. Results cached to `~/.pi/agent/cache/pi-vertex-models.json` (24 h TTL) and used to build the registered model set at startup; falls back to the static table when discovery is disabled or yields nothing. Configured by `discoveryEnabled`, `discoveryCacheTtlMs`, `discoveryPublishers`.
- Startup widget line reporting project, registered model count and whether discovery came from cache; cleared on first user input.
- `claude-opus-4-8` and `claude-sonnet-5` (static table now 45 models).
### Changed
- **Probe-based availability**: each discovered model is checked with a `countTokens` request against the user's project instead of being filtered down to the static table, so models Google enables appear without a code change and unreachable ones are not offered. (Replaces the short-lived "register only models present in the static table" behaviour.)
- Claude 4.5 and below send the legacy `thinking: {type: "enabled", budget_tokens}` config; adaptive thinking stays on 4.6+.
### Fixed
- Model `baseUrl` is `undefined` rather than `""`, so pi's provider-level `baseUrl` fallback wins instead of being short-circuited by the empty string.
- Gemini `maxTokens` 65,536 → 65,535: Vertex treats the output bound as exclusive, so the previous value was rejected.

## [1.1.9] - 2026-05-20
### Added
- **Gemini 3.5 Flash** (`gemini-3.5-flash`) — GA Vertex model with 1M input context, 65,535 max output tokens, reasoning, tool support, and $1.50/$9.00 per 1M token global pricing.
- **xAI Grok models** via Vertex MaaS: `grok-4.20-reasoning` and `grok-4.1-fast-reasoning`, including cache-read pricing.
- **Gemma 4 26B A4B IT** (`gemma-4-26b-a4b-it`) via Vertex MaaS.
- **Regional Claude pricing metadata** through optional `costRegional` model costs.

### Fixed
- Preserve Gemini 3/3.5 native thinking defaults when Pi reasoning is not explicitly requested by omitting `thinkingConfig` for those models.
- Apply a healthy default thinking budget for Gemini 2.5 models when Pi reasoning is not explicitly requested.
- Use regional Claude pricing when the resolved Vertex endpoint is non-global.

## [1.1.8] - 2026-05-06
### Fixed
- **Double `stream.end()` on the Anthropic path**: `streamAnthropic()` was calling `stream.end()` internally and then `streamMaaS()` was calling it again. Made `streamAnthropic()` lifecycle-neutral (pushes start/deltas/done but does not end the stream) so end() is called exactly once, matching the OpenAI-compat path. Idempotent in pi-ai today, but now correct by construction.
### Added
- **Tests for `streaming/maas.ts`** (`tests/streaming-maas.test.ts`): Anthropic happy path, tool-use stop reason, sync error path, OpenAI-compat model rewriting, and a regression test asserting `stream.end()` is called exactly once. Test count: 86 → 88.
### Changed
- **Removed dead branches in `convertToGeminiMessages`**: the `claude-` / `gpt-oss-` modelId checks (and the `requiresToolCallId` helper) only ran inside the Gemini streaming path, where modelId is always a Gemini apiId — they were unreachable in production. Three corresponding tests removed.
- **Lint cleanup**: tightened `any` usage in `index.ts`, `streaming/index.ts`, `streaming/gemini.ts`, and `utils.ts` (proper Tool / GeminiContent / discriminated-union types, exhaustive-check `never`). `noExplicitAny` is now disabled for `tests/**` (mock objects) and `streaming/maas.ts` (Anthropic message-shaping pipeline mixes intermediate shapes; cleanup tracked as a follow-up). `npm run check` is now a real signal: 53 warnings → 0.
- **Dropped `screenshot.png` from the npm tarball**: README now references the GitHub raw URL. Tarball size: ~730 kB → 24 kB (~30× smaller).
- **Added `.pi/` to biome ignore list** so internal task state isn't linted.

## [1.1.7] - 2026-05-06
### Added
- Claude Opus 4.7 model definition and README references using current Vertex metadata.
- Integration-style tests for `streamGemini()` with mocked `@google/genai` streaming responses.
- Additional Gemini conversion tests for valid Unicode, image tool results, and missing tool result synthesis.
### Fixed
- Preserve valid Unicode surrogate pairs while removing only unpaired surrogates before provider requests.
- Avoid double-counting Gemini cached input tokens as both uncached input and cache reads.
- Replay Gemini image tool results instead of silently dropping images.
- Insert synthetic Gemini tool results for missing tool call responses before replaying the next turn.
- Map unsupported Gemini 3 Pro `minimal` reasoning to `LOW` while preserving supported `MEDIUM` and `HIGH` levels.
- Use Gemini 2.5 Pro's lowest supported thinking budget when Pi reasoning is disabled instead of sending an invalid zero budget.
- Emit Gemini safety/blocked finishes as `error` stream events instead of `done` events with an invalid error stop reason.
- Update Claude 4.6 Vertex model metadata to current 128K output limits and current token pricing.

## [1.1.6] - 2026-05-05
### Added
- Comprehensive unit tests for `convertToGeminiMessages` (27 test cases covering user text, images, assistant text/thinking/tool calls, tool results, cross-provider signatures, and multi-turn conversations).
- Unit tests for `streamVertex` dispatch logic (gemini vs maas routing, unknown endpoint type errors).
### Fixed
- `streamAnthropic()` now calls `stream.end()` internally instead of relying on the caller, preventing potential stream hangs on early returns or mid-stream errors.
- Removed hardcoded `maxTokens / 2` halving in `streaming/gemini.ts` and `streaming/maas.ts`. Models now use their full advertised output capacity unless explicitly overridden via `options.maxTokens`.

## [1.1.5] - 2026-05-05
### Changed
- Forked to `lhl/pi-vertex` with standalone repository, CI, tests, and linting.
- Renamed package to `@lhl/pi-vertex`.
- Added Biome for linting and formatting.
- Added Vitest with coverage for unit tests (auth, config, utils, models).
- Added GitHub Actions CI workflow for type-check, lint, and test.
- Replaced placeholder `npm run check/build/clean` scripts with real implementations.

## [1.1.4] - 2026-03-30
### Fixed
- Removed error message override for `400 (no body)` responses from Vertex MaaS models. The original message now passes through to `isContextOverflow()` which already handles this pattern, enabling proper auto-compact instead of showing a raw error to the user.
- Use `zai` thinking format for `zai-org` publisher models (GLM-5). Previously using `openai` format which never sent `enable_thinking`, causing intermittent 400 errors from the ZAI API.

## [1.1.3] - 2026-03-26
### Fixed
- Hardened Claude-on-Vertex replay for mid-session model switching (tool ID normalization, tool result adjacency, thinking signature validation).
- Prevented Anthropic tool replay errors by inserting synthetic tool results when missing.

### Updated
- Claude 4.6 models use native Anthropic Vertex SDK streaming.
- Claude 4.6 context window updated to 1M.
- Model list order in the selector is now alphabetized by ID.

## [1.1.2] - 2026-03-24
### Changed
- Initial Claude 4.x support on Vertex.
