# pi-vertex

[![npm version](https://img.shields.io/npm/v/@cebarks/pi-vertex)](https://www.npmjs.com/package/@cebarks/pi-vertex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Google Vertex AI provider for the [Pi Coding Agent](https://pi.dev) — Gemini, Claude, Llama, DeepSeek, Qwen, Mistral and the rest of the Vertex Model Garden behind a single provider, billed through your GCP project, with **dynamic model discovery** so models that are enabled in *your* project show up in the selector without a code change or a release.

```bash
pi install npm:@cebarks/pi-vertex
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json   # or: gcloud auth application-default login
```

![pi-vertex model selector](https://raw.githubusercontent.com/cebarks/pi-vertex/main/screenshot.png)

## About this fork

Lineage:

1. [`ssweens/pi-packages`](https://github.com/ssweens/pi-packages) — original `@ssweens/pi-vertex`, published inside a mono-repo
2. [`lhl/pi-vertex`](https://github.com/lhl/pi-vertex) — `git filter-repo` extraction into a standalone repo with tests, lint and CI (`@lhl/pi-vertex`, v1.1.5 → v1.1.9)
3. **this repo** — [`cebarks/pi-vertex`](https://github.com/cebarks/pi-vertex) (`@cebarks/pi-vertex`, v2.x)

The reason for the second fork is discovery. Up to v1.1.9 the model list was a hand-maintained static table: every new Vertex model required an upstream code change, a release, and a pi-package update on your side — and enabling a model your project has access to was invisible until someone shipped it. This fork queries the Model Garden API at startup, probes each model for project-level access, and registers what actually answers. Static metadata is still used where it exists, so pricing and capability limits for known models stay authoritative rather than guessed.

### What this fork adds (v2.x, on top of v1.1.9)

| Change | Details |
| -------- | --------- |
| **Dynamic model discovery** | `discovery.ts` lists `publishers/{p}/models` (`v1beta1`) for 11 publishers, filters non-chat models (TTS, embeddings, Imagen), and registers the survivors — new models appear with no code change |
| **Probe-based availability** | Each candidate is checked with a `countTokens` request against *your* project. `200` → available; `400 "…infeasible"` → available (Claude/MaaS don't implement `countTokens`); `404`/org-policy/not-servable → skipped. No more offering models your project can't reach |
| **Disk cache + `/vertex-refresh`** | Results cached to `~/.pi/agent/cache/pi-vertex-models.json` (default TTL 24 h) so startup stays fast; `/vertex-refresh` clears the cache and re-probes in-session |
| **Discovery configuration** | `discoveryEnabled`, `discoveryCacheTtlMs`, `discoveryPublishers` in the settings file; falls back to the full static table if discovery is off or fails |
| **New models** | `claude-opus-4-8`, `claude-sonnet-5` |
| **pi package scope migration** | Moved to `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` and cleared the `npm audit` findings that came with the old dependency set |
| **Bug fixes** | `baseUrl: undefined` so pi's provider-level fallback wins (empty string used to short-circuit `??`); `streamSimpleOpenAICompletions` imported via the compat root entrypoint (pi's jiti module map exposes root entrypoints only); Gemini `maxTokens` 65,536 → 65,535 (Vertex treats the bound as exclusive); legacy `thinking` config for Claude 4.5 and below, adaptive thinking for 4.6+ |

### Carried over from the previous fork

Standalone repo; ~90 unit tests (auth, config, utils, model integrity, `convertToGeminiMessages`, streaming dispatch, mocked Gemini + MaaS streams); Biome lint/format; GitHub Actions workflow for type-check, lint, coverage; real `build`/`check`/`test` scripts; Anthropic stream lifecycle fixed to `end()` exactly once; hardcoded `maxTokens / 2` halving removed; regional Claude pricing (`costRegional`) applied when the resolved endpoint isn't global; Gemini cache-token accounting, image tool-result replay, missing-tool-result synthesis, and safety/blocked finish handling.

### Provenance

- **Upstream**: [`lhl/pi-vertex`](https://github.com/lhl/pi-vertex) → [`ssweens/pi-packages`](https://github.com/ssweens/pi-packages) (path `pi-vertex/`, filtered with `git filter-repo --path pi-vertex/ --path-rename pi-vertex/:`, so upstream history is intact)
- **Fork point**: v1.1.9 (`f7b1a46`), rebranded in `d5ca3b3` (2026-08-25)
- **npm**: [`@cebarks/pi-vertex`](https://www.npmjs.com/package/@cebarks/pi-vertex) · **repo**: [`cebarks/pi-vertex`](https://github.com/cebarks/pi-vertex)
- **Requirements**: pi ≥ 0.74 (the `@earendil-works/*` scope); developed against 0.84.x

## Model discovery

At startup the extension runs four phases, then registers the provider once:

1. **List** — one `GET /v1beta1/publishers/{publisher}/models?pageSize=100` per publisher (5 s timeout each, all in parallel). Publishers: `anthropic`, `google`, `meta`, `mistralai`, `deepseek-ai`, `xai`, `qwen`, `moonshotai`, `minimaxai`, `openai`, `zai-org`.
2. **Filter** — drop IDs matching `-tts`, `-embedding`, `-imagen`, `textembedding`, `-native-audio`, `-image`.
3. **Probe** — a `countTokens` request per candidate, 8 workers, 5 s timeout each. Probing uses each publisher's serving region (`us-east5` for Anthropic, `global` for Google, `us-central1` for the rest), which is *only* an availability check — it does not change the endpoint your requests go to.
4. **Enrich** — models present in the static tables keep their real pricing, context window and capability flags; models discovered but not described statically get publisher defaults (below) and show up with a generated display name.

The result is cached as JSON on disk and reused until the TTL expires, so the probe cost is paid once per day. The startup widget reports the count and whether it came from cache:

```text
   [pi-vertex] Project: my-gcp-project | 48 models available (cached)
```

Defaults for models that aren't in the static tables (`_default` catches any publisher not listed):

| Publisher | Endpoint | Context | Max output | Input | Reasoning | Probe region |
| ----------- | ---------- | --------- | ------------ | ------- | ----------- | -------------- |
| `anthropic` | maas | 200K | 64,000 | text, image | yes | `us-east5` |
| `google` | gemini | 1M | 65,535 | text, image | yes | `global` |
| `meta` | maas | 128K | 32,000 | text | yes | `us-central1` |
| `mistralai` | maas | 128K | 32,000 | text | no | `us-central1` |
| `deepseek-ai` | maas | 160K | 32,000 | text | yes | `us-central1` |
| `xai` | maas | 200K | 32,000 | text, image | yes | `us-central1` |
| others (`_default`) | maas | 128K | 32,000 | text | yes | `us-central1` |

Because defaults include placeholder pricing, costs shown in pi for an unknown model are approximate until you add it to the static tables — that's a deliberate trade-off: surfacing a model beats hiding it, and a one-line PR to `models/maas.ts` makes it exact.

## Features

- **45 statically described models** across Gemini (9), Claude (12), Llama (3) and other MaaS (21) — plus whatever else discovery finds in your project
- **Unified streaming** through one provider: Gemini via `@google/genai`, Claude via the native `@anthropic-ai/vertex-sdk`, everything else via Vertex's OpenAI-compatible endpoint
- **Full tool calling** with multi-turn tool use and tool-result handling on every path
- **Thinking / reasoning**: Gemini 3 thinking levels, Gemini 2.5 thinking budgets, thought-signature preservation, Claude adaptive and legacy thinking formats
- **Automatic auth** via Application Default Credentials or a service-account key
- **Region awareness**: global endpoints by default, regional when required, with regional Claude pricing applied automatically
- **Cost tracking** for all statically known models, including cache reads/writes and thinking tokens

## Installation

```bash
# Via pi (recommended)
pi install npm:@cebarks/pi-vertex

# Or via npm
npm install -g @cebarks/pi-vertex

# Or from source
git clone https://github.com/cebarks/pi-vertex.git
cd pi-vertex && npm install
pi install /path/to/pi-vertex
```

## Setup

### 1. Authenticate with Google Cloud

```bash
# Option A: user credentials (development)
gcloud auth application-default login

# Option B: service account (production)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

The project also needs the Vertex AI API enabled (`gcloud services enable aiplatform.googleapis.com`), and any model you want must be enabled for the project — that's exactly what discovery probes for.

### 2. Environment variables

```bash
export GOOGLE_CLOUD_PROJECT=your-project-id    # required (GCLOUD_PROJECT also accepted)
export GOOGLE_CLOUD_LOCATION=us-central1       # optional: override the per-model region
```

### 3. Configuration file (optional)

`~/.pi/agent/settings/pi-vertex.json` — every field is optional, and **file values take priority over environment variables**:

```json
{
  "googleCloudProject": "my-gcp-project",
  "googleCloudLocation": "us-central1",
  "googleApplicationCredentials": "/path/to/service-account.json",
  "discoveryEnabled": true,
  "discoveryCacheTtlMs": 86400000,
  "discoveryPublishers": ["anthropic", "google", "meta"]
}
```

| Key | Default | Effect |
| ----- | --------- | -------- |
| `discoveryEnabled` | `true` | `false` registers the 45 static models only — no network calls at startup |
| `discoveryCacheTtlMs` | `86400000` (24 h) | Cache lifetime; `0` forces a fresh probe every start |
| `discoveryPublishers` | all 11 | Narrow the publisher set to cut startup probe time |

### 4. Verify

```bash
pi --provider vertex --model gemini-2.5-pro --version
```

## Usage

```bash
pi --provider vertex --model claude-opus-4-8
pi --provider vertex --model gemini-3.1-pro
pi --provider vertex --model llama-4-maverick
pi --provider vertex --model deepseek-v3.2
pi --provider vertex --model claude-sonnet-4-6 --reasoning high
```

Within a session, `/vertex-refresh` clears the cache, re-probes, and reports what is now available:

```text
/vertex-refresh
→ Vertex model cache refreshed. 48 models available: claude-opus-4-8, gemini-3.5-flash, …
```

Shell aliases keep the typing down — note `pi`'s `--provider vertex` plus a model id, so one alias per model you actually use:

```bash
alias pic='GOOGLE_CLOUD_PROJECT=my-project pi --provider vertex --model claude-opus-4-8'
alias pig='GOOGLE_CLOUD_PROJECT=my-project pi --provider vertex --model gemini-3.5-flash'
```

## Model reference

Static metadata; discovery may register additional models, and may omit ones listed here if your project has no access. Prices are **USD per 1M tokens** on the global endpoint unless noted.

### Gemini

| Model | Context | Max output | Input | Reasoning | Price (in/out) | Cache read |
| --- | --- | --- | --- | --- | --- | --- |
| `gemini-3.5-flash` | 1M | 65,535 | text, image | yes | $1.50/$9.00 | $0.15 |
| `gemini-3.1-pro` | 1M | 65,535 | text, image | yes | $2.00/$12.00 | $0.20 |
| `gemini-3.1-flash-lite` | 1M | 65,535 | text, image | yes | $0.25/$1.50 | $0.025 |
| `gemini-3-flash` | 1M | 65,535 | text, image | yes | $0.50/$3.00 | $0.05 |
| `gemini-2.5-pro` | 1M | 65,535 | text, image | yes | $1.25/$10.00 | $0.125 |
| `gemini-2.5-flash` | 1M | 65,535 | text, image | yes | $0.30/$2.50 | $0.03 |
| `gemini-2.5-flash-lite` | 1M | 65,535 | text, image | yes | $0.10/$0.40 | $0.01 |
| `gemini-2.0-flash` | 1M | 8,192 | text, image | no | $0.15/$0.60 | $0 |
| `gemini-2.0-flash-lite` | 1M | 8,192 | text, image | no | $0.075/$0.30 | $0 |

### Claude

Non-global regions use `costRegional` where Google publishes a regional premium.

| Model | Context | Max output | Reasoning | Global (in/out) | Regional (in/out) |
| --- | --- | --- | --- | --- | --- |
| `claude-opus-4-8` | 1M | 128,000 | yes | $5.00/$25.00 | $5.50/$27.50 |
| `claude-opus-4-7` | 1M | 128,000 | yes | $5.00/$25.00 | $5.50/$27.50 |
| `claude-opus-4-6` | 1M | 128,000 | yes | $5.00/$25.00 | $5.50/$27.50 |
| `claude-sonnet-5` | 1M | 128,000 | yes | $2.00/$10.00 | $2.20/$11.00 |
| `claude-sonnet-4-6` | 1M | 128,000 | yes | $3.00/$15.00 | $3.30/$16.50 |
| `claude-opus-4-5` | 200K | 32,000 | yes | $5.00/$25.00 | $5.50/$27.50 |
| `claude-sonnet-4-5` | 200K | 64,000 | yes | $3.00/$15.00 | $3.30/$16.50 |
| `claude-haiku-4-5` | 200K | 64,000 | yes | $1.00/$5.00 | $1.10/$5.50 |
| `claude-opus-4-1` | 200K | 32,000 | yes | $15.00/$75.00 | uniform |
| `claude-opus-4` | 200K | 32,000 | yes | $15.00/$75.00 | uniform |
| `claude-sonnet-4` | 200K | 64,000 | yes | $3.00/$15.00 | uniform |
| `claude-3-5-sonnet-v2` | 200K | 8,192 | no | $3.00/$15.00 | uniform |

### Llama

| Model | Context | Max output | Reasoning | Price (in/out) |
| --- | --- | --- | --- | --- |
| `llama-4-maverick` | 512K | 32,000 | yes | $0.35/$1.15 |
| `llama-4-scout` | 1.25M | 32,000 | yes | $0.25/$0.70 |
| `llama-3.3-70b` | 128K | 8,192 | no | $0.72/$0.72 |

### Other MaaS

| Model | Publisher | Context | Max output | Reasoning | Price (in/out) |
| --- | --- | --- | --- | --- | --- |
| `grok-4.20-reasoning` | xai | 200K | 32,000 | yes | $1.25/$2.50 |
| `grok-4.1-fast-reasoning` | xai | 128K | 32,000 | yes | $0.20/$0.50 |
| `gemma-4-26b-a4b-it` | google | 256K | 128,000 | no | $0.15/$0.60 |
| `mistral-medium-3` | mistralai | 128K | 32,000 | no | $0.40/$2.00 |
| `mistral-small-3.1` | mistralai | 128K | 32,000 | no | $0.10/$0.30 |
| `codestral-2` | mistralai | 256K | 32,000 | no | $0.30/$0.90 |
| `mistral-ocr` | mistralai | 128K | 32,000 | no | $0.0005 (per page) |
| `deepseek-v3.2` | deepseek-ai | 160K | 32,000 | yes | $0.56/$1.68 |
| `deepseek-v3.1` | deepseek-ai | 160K | 32,000 | yes | $0.60/$1.70 |
| `deepseek-r1` | deepseek-ai | 160K | 32,000 | yes | $1.35/$5.40 |
| `deepseek-ocr` | deepseek-ai | 160K | 32,000 | no | $0.30/$1.20 |
| `qwen3-235b` | qwen | 256K | 32,000 | yes | $0.22/$0.88 |
| `qwen3-next-instruct` | qwen | 256K | 32,000 | yes | $0.15/$1.20 |
| `qwen3-next-thinking` | qwen | 256K | 32,000 | yes | $0.15/$1.20 |
| `qwen3-coder` | qwen | 256K | 32,000 | yes | $0.22/$1.80 |
| `gpt-oss-120b` | openai | 128K | 32,000 | yes | $0.09/$0.36 |
| `gpt-oss-20b` | openai | 128K | 32,000 | no | $0.07/$0.25 |
| `kimi-k2-thinking` | moonshotai | 256K | 32,000 | yes | $0.60/$2.50 |
| `minimax-m2` | minimaxai | 192K | 32,000 | yes | $0.30/$1.20 |
| `glm-5` | zai-org | 200K | 32,000 | yes | $1.00/$3.20 |
| `glm-4.7` | zai-org | 200K | 32,000 | yes | $0.60/$2.20 |

`mistral-ocr` is billed per page ($0.0005/page on both sides) rather than per token; the two `*-ocr` models do not support tool calling.

## Endpoints and regions

Every static model defaults to `region: "global"`, which resolves to `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/...`. A regional endpoint looks like `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/...`.

`GOOGLE_CLOUD_LOCATION` (or `googleCloudLocation`) is a **global override** applied on top of each model's own region — setting it forces every request through that region, including for models that only serve from `global`. Use it when you have a data-residency requirement and have confirmed the models you rely on are servable there; it also switches Claude pricing to `costRegional` when a premium is defined.

## Architecture

```text
                         ┌─────────────┐
                         │     Pi      │
                         └──────┬──────┘
      registerProvider("vertex")│  /vertex-refresh
                                ▼
   ┌────────────────────────────────────────────────┐
   │                   pi-vertex                    │
   │                                                │
   │  config.ts ─ settings/pi-vertex.json           │
   │  auth.ts ───── ADC / service account, project, │
   │                location, endpoint builder      │
   │  discovery.ts ─ Model Garden list ──┐          │
   │                  countTokens probe ─┤ cache    │
   │                                     ▼          │
   │  models/ ─ static metadata ═══► merged model set (45+ registered)
   └────────────────────────────────┬───────────────┘
                                streamVertex()
                                     │ endpointType
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
        ┌───────────────────────┐        ┌──────────────────────────┐
        │  gemini (@google/genai)│        │ maas (OpenAI-compat) or  │
        │                        │        │ Claude (vertex-sdk)      │
        └───────────────────────┘        └──────────────────────────┘
```

## Development

```bash
npm ci
npm run build         # tsc --noEmit
npm run check         # biome check
npm test              # vitest run
npm run test:coverage
```

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs type-check + lint and tests + coverage upload. Two things worth knowing before you trust either number:

- Actions does not run automatically on a fork until it is enabled in the repo's Settings → Actions → General; check `gh run list -R cebarks/pi-vertex` before assuming the badge reflects reality.
- `npm test` passes cleanly only in an environment without a real `~/.pi/agent/settings/pi-vertex.json` or gcloud ADC: `tests/auth.test.ts` asserts on `resolveProjectId()`/`resolveLocation()` fallbacks, and `loadConfig()` picks up your actual settings file, so a few assertions pick up local values instead of the mocked ones. `tests/streaming-maas.test.ts` additionally cannot be collected under plain Node — `streaming/maas.ts` reaches `streamSimpleOpenAICompletions` through a `require()` of pi's root compat entrypoint, which exists only inside pi's jiti virtual-module map.

Both are test-harness gaps, not runtime bugs; `index.ts` works under pi because pi provides that module map.

## Dependencies

- `@google/genai` — Gemini generateContent streaming
- `@anthropic-ai/vertex-sdk` — native Claude-on-Vertex streaming
- `google-auth-library` — ADC/service-account tokens
- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` — peer dependencies (provided by pi)

## License

MIT — see [LICENSE](LICENSE). Copyright for the original work is held by `ssweens`; this fork preserves the upstream notice and full commit history.
