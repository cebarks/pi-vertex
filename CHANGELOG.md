# Changelog

All notable changes to this project will be documented in this file.

## [3.0.0] - 2026-09-29

### Fixed

- **System prompt and tools were silently dropped from every request** (all Vertex
  models, both the Claude/MaaS and Gemini paths). pi-ai 0.87 replaced the provider
  stream contract: `streamSimple` now receives a branded `TranscriptContext`
  (`{ messages }` only), and the prompt plus tool declarations are carried by
  `SystemMessage` entries *inside* `messages`. pi-vertex still read the pre-0.87
  `context.systemPrompt` and `context.tools` fields, which no longer exist at
  runtime. Both were inside conditional spreads, so they vanished without an error,
  and the message-replay loops dropped the leading system message as well. Models
  answered as bare chat models with no AGENTS.md, no tool schemas, no skills, and
  no pi conventions — a real request carried ~222 input tokens instead of ~47k.
  Now replayed through pi-ai's own helpers (`getCurrentSystemPrompt`,
  `getCurrentTools`), so named prompt sections and mid-conversation
  `toolsAdded`/`toolsRemoved` deltas resolve correctly too.
- **`streamSimpleOpenAICompletions` was imported from the wrong entrypoint.** It
  only exists on `@earendil-works/pi-ai/compat`; the root export has no such
  symbol, and `require()` of the root throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
  because pi-ai's exports map defines no `require` condition. That broke the
  OpenAI-compatible MaaS path (Llama, Mistral, Grok, GLM, …) and made
  `tests/streaming-maas.test.ts` uncollectable under vitest. v2.1.1 intended this
  fix but imported from the root.
- **Tool names Anthropic rejects now get sanitized.** Anthropic requires
  `tools[].name` to match `^[a-zA-Z0-9_-]{1,128}$`; a single MCP-namespaced name
  containing `:` or `.` returned 400 and took *every* tool down with it. Names are
  sanitized outbound and mapped back inbound so pi can still dispatch the call.
  Collisions are disambiguated with a numeric suffix.
- Two pre-existing type errors in `streaming/gemini.ts`: pi-ai 0.87 tightened
  `ToolCall.arguments` from `Record<string, unknown>` to `JsonObject`.
- `tests/auth.test.ts` no longer fails on machines with a real gcloud/ADC setup.
  It copied the ambient environment wholesale, so a host `GOOGLE_CLOUD_PROJECT` or
  `CLOUD_ML_REGION` overrode the values the fallback-ordering tests set.

### Changed

- **BREAKING:** `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` peer
  dependencies are floored at `>=0.87.0` (previously `*`). Hosts older than 0.87
  pass the legacy `Context` shape and can no longer install this package. The `*`
  range is what let the contract break silently: dev and test resolved pi-ai 0.84.3
  from the lockfile while the running host was 0.87.1, so `tsc` and `vitest` were
  both green against a version production never used. Dev dependencies are now
  pinned to exact `0.87.1` so typecheck tracks the real host.
- Provider stream callbacks are typed `TranscriptContext` instead of `Context`, so
  the compiler enforces the new contract. `index.ts` calls `normalizeContext()` at
  the extension boundary — idempotent on a `TranscriptContext` and correct for a
  legacy `Context`, which papers over pi's own stale `ProviderConfig.streamSimple`
  typing (still declared as `Context` in `model-registry.d.ts`).

### Added

- `scripts/live-probe.ts` — manual, network-gated probe (excluded from `npm test`)
  that forces a real Vertex call which can only be satisfied by emitting a
  `tool_use` block. Verified live against `claude-haiku-4-5`, `claude-opus-4-8`
  (adaptive thinking), `gemini-2.5-flash`, and `gemini-3.5-flash`.
- 9 regression tests covering the transcript contract on both endpoint types:
  prompt extraction, `toolsAdded` declarations, mid-conversation tool deltas,
  system-role messages never leaking into the provider message array, tool-name
  sanitization round-trip, and the no-system-message case.

## [2.1.2] - 2026-08-29

### Fixed

- **`streamSimpleOpenAICompletions` is imported from `@earendil-works/pi-ai/compat`.**
  The bare specifier resolves to `pi-ai/dist/index.js` under plain Node, which does not
  re-export it — only pi's extension loader aliases root → compat (`getAliases()` for
  node mode, `VIRTUAL_MODULES` for the compiled binary). The previous top-level
  `require("@earendil-works/pi-ai")` therefore worked inside pi but threw
  `ERR_MODULE_NOT_FOUND: No "exports" main defined` under Node, which made
  `tests/streaming-maas.test.ts` impossible to collect. `/compat` is present in both pi
  maps *and* in pi-ai's `exports`, so the MaaS path is importable everywhere.
- **`npm run check` passes on `main`.** Import ordering and formatting had drifted in
  `index.ts`, `models/index.ts`, `discovery.ts`, `streaming/gemini.ts` and
  `tests/models.test.ts` — invisible because GitHub Actions has never executed on this
  fork.
- **Stale `require("node:fs")`** in the discovery cache write-cleanup replaced with the
  `unlinkSync` already imported at the top of the file.

### Changed

- `probeAll()` hands work to its 8 workers from a shared cursor instead of
  `queue.shift()!`: no non-null assertion and no O(n) shift per item.
- **Test suite is hermetic to the developer's environment.** `tests/auth.test.ts` builds
  its `process.env` baseline with `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`,
  `GOOGLE_CLOUD_LOCATION`, `CLOUD_ML_REGION` and `GOOGLE_APPLICATION_CREDENTIALS`
  removed, so a host gcloud setup can no longer invert the fallback-ordering asserts.
- `biome.json` disables the formatter for `package.json`: npm rewrites that file on
  every `npm version` and re-expands short arrays, which biome then reported as a
  format error — a release bump should not redden CI.

## [2.1.1] - 2026-08-25

### Fixed

- Attempted to load `streamSimpleOpenAICompletions` from the compat entrypoint.
  The import still targeted the root export, so the fix did not take effect until
  3.0.0.

## [2.1.0] - 2026-08-25

### Changed

- Migrated to the `@earendil-works/pi-ai` package namespace and resolved reported
  dependency audit vulnerabilities.

## [2.0.1] - 2026-08-25

### Added

- **Probe-based model availability.** Models are now included based on a live
  `countTokens` probe against the caller's GCP project rather than being filtered
  by the static table, so newly published Vertex models show up without a release.
- **`/vertex-refresh` command** to re-probe model availability and update the
  discovery cache on demand.

### Fixed

- Gemini `maxTokens` 65536 → 65535 (the upper bound is exclusive).

## [2.0.0] - 2026-08-25

### Added

- **Rebranded to `@cebarks/pi-vertex`** as a fork of `@lhl/pi-vertex`.
- **Dynamic model discovery** via the Vertex AI Model Garden API, with a
  disk-cached, configurable-TTL result set.

### Fixed

- Use legacy `thinking: { type: "enabled", budget_tokens }` for Claude 4.5 and
  below; adaptive thinking is a 4.6+ feature.
- Set `baseUrl` to `undefined` (not `""`) so pi's `applyExtension()` falls through
  to the provider-level URL — an empty string wins the `??` coalesce but then fails
  the falsy check.

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
