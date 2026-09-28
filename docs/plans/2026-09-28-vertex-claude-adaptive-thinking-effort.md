# Vertex Claude Adaptive Thinking + Effort Ladder Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make every Vertex Claude model — static or dynamically discovered — receive the correct thinking mode (`adaptive` vs legacy `enabled`) and a valid `output_config.effort`, and expose per-model thinking-level support to pi.

**Architecture:** One source of truth for Anthropic capabilities: a version parser (`claude-*[-<major>[-<minor>]]`) that derives `adaptiveThinking` + `effortLevels` in `utils.ts`, consumed by (1) `discovery.ts` for models absent from the static table, (2) `models/claude.ts` as authoritative overrides, (3) `streaming/maas.ts` for request shaping, and (4) `index.ts#toPiModel()` to publish `thinkingLevelMap` so pi hides levels a model cannot accept.

**Tech Stack:** TypeScript (ESM, `tsc --noEmit` typecheck only — pi loads source via its extension loader), vitest, biome.

---

## Verified facts this plan is built on (2026-09-28, live probes against project `itpc-ca-780c4215ac`, global endpoint)

| probe | result |
|---|---|
| `claude-opus-5` + `thinking:{type:"enabled",budget_tokens:1024}` | **400** `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"` |
| `claude-opus-5` + `thinking:{type:"adaptive"}` + `output_config.effort` low/medium/high/xhigh/max | 200 (all five) |
| `claude-opus-5`, no `thinking` key | 200 (only the reasoning-on path breaks) |
| `claude-sonnet-4-5` / `claude-haiku-4-5` + adaptive | **400** `adaptive thinking is not supported on this model` |
| `claude-opus-4-6` / `claude-sonnet-4-6` | both `enabled` and `adaptive` accepted (200) |
| `claude-opus-4-6` / `claude-sonnet-4-6` + `effort:"xhigh"` | **400** `This model does not support effort level 'xhigh'. Supported levels: high, low, max, medium.` |
| `claude-opus-4-8` + `effort` low/medium/high/xhigh/max | 200 (all five) |
| tool loop with tools + either thinking mode, all 7 available models | 200, `stop_reason: tool_use` — tools themselves are not model-gated |
| assistant replay shapes (thinking kept / downgraded to text / absent) | all 200 — Vertex does not enforce thinking-first on these models |
| `countTokens` availability for `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`, `claude-opus-4-7`, `claude-opus-4-5@20251101` | 404 in **both** us-east5 and global → genuinely not enabled in this project (Fable additionally needs the Advanced AI Safety Addendum + Marketplace consent) |

Model specs (Google Cloud + Anthropic docs, 2026-09-28):

| model | id | context | max output | $/MTok in/out | thinking | default effort | effort ladder |
|---|---|---|---|---|---|---|---|
| Claude Opus 5 | `claude-opus-5` | 1,000,000 | 128,000 | 5 / 25 | adaptive | high | low,medium,high,xhigh,max |
| Claude Opus 5.5 | `claude-opus-5-5` | 1,000,000 | 128,000 | 4 / 20 | adaptive (always on) | medium | all five |
| Claude Fable 5 | `claude-fable-5` | 1,000,000 | 128,000 | 10 / 50 | adaptive (always on) | high | all five |
| Claude Fable 5.1 | `claude-fable-5-1` | 1,000,000 | 128,000 | 10 / 50 | adaptive (always on) | high | all five |
| Claude Opus 4.6 / Sonnet 4.6 | — | 1,000,000 | 128,000 | existing | adaptive | high | low,medium,high,max (**no xhigh**) |
| Claude ≤4.5 | — | existing | existing | existing | legacy `enabled` | n/a | n/a (budget only) |

Cache-price convention already used by the table (and confirmed by Anthropic's pricing page): `cacheRead = 0.1 × input`, `cacheWrite(5m) = 1.25 × input`, `costRegional = global × 1.1`.

pi side (pi-ai 0.84.3 / pi 0.87.1): `Model.thinkingLevelMap?: Partial<Record<"off"|ThinkingLevel, string|null>>`; `null` = unsupported; `xhigh`/`max` are **opt-in** — `getSupportedThinkingLevels()` hides them unless a non-null map entry exists, which is why pi-vertex currently cannot reach them from the UI.

---

## Task 1: Anthropic capability derivation in `utils.ts`

**Files:**
- Modify: `utils.ts` (append near `getGeminiMajorVersion`, line ~59)
- Test: `tests/utils.test.ts`

**Step 1: Write the failing tests** — append to `tests/utils.test.ts`:

```ts
describe("claudeSupportsAdaptiveThinking", () => {
  it("returns true for Claude 4.6+ and every Claude 5.x", () => {
    for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-8",
      "claude-sonnet-5", "claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"])
      expect(claudeSupportsAdaptiveThinking(id), id).toBe(true);
  });
  it("returns false for Claude 4.5 and older", () => {
    for (const id of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5", "claude-opus-4-1",
      "claude-opus-4", "claude-sonnet-4", "claude-3-5-sonnet-v2", "claude-3-7-sonnet"])
      expect(claudeSupportsAdaptiveThinking(id), id).toBe(false);
  });
  it("defaults to adaptive for unparseable Anthropic ids (new releases are 4.6+)", () => {
    expect(claudeSupportsAdaptiveThinking("claude-pro-next")).toBe(true);
  });
  it("returns false for non-claude ids", () => {
    expect(claudeSupportsAdaptiveThinking("gemini-2.5-pro")).toBe(false);
  });
});

describe("claudeEffortLevels", () => {
  it("omits xhigh on the 4.6 series (verified 400 from Vertex)", () => {
    expect(claudeEffortLevels("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(claudeEffortLevels("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
  });
  it("offers the full ladder on 4.7+ / 5.x", () => {
    expect(claudeEffortLevels("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  it("returns no effort levels for legacy models", () => {
    expect(claudeEffortLevels("claude-sonnet-4-5")).toEqual([]);
  });
});
```

**Step 2:** `npx vitest run tests/utils.test.ts` → expect FAIL (`claudeSupportsAdaptiveThinking is not exported`).

**Step 3: Implement** in `utils.ts`:

```ts
export type AnthropicEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Major/minor of a `claude-<family>-<major>[-<minor>]` id; minor defaults to 0. */
export function claudeVersion(modelId: string): { major: number; minor: number } | undefined {
  const m = /^claude-[a-z]+-(\d+)(?:-(\d+))?/.exec(modelId);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0) };
}

/**
 * Adaptive thinking (`thinking.type: "adaptive"` + `output_config.effort`) is required on
 * Claude 4.6+ and rejected by 4.5 and older, which need `enabled` + `budget_tokens`.
 * Verified against the Vertex global endpoint 2026-09-28. Unparseable ids are treated as
 * adaptive: a model we have never seen is newer than 4.6 far more often than it is older.
 */
export function claudeSupportsAdaptiveThinking(modelId: string): boolean {
  const v = claudeVersion(modelId);
  if (!v) return modelId.startsWith("claude-");
  return v.major > 4 || (v.major === 4 && v.minor >= 6);
}

/**
 * Effort ladder per family. 4.6 rejects `xhigh` (400: "Supported levels: high, low, max,
 * medium"); 4.7+ and 5.x accept all five. Legacy models have no effort parameter.
 */
export function claudeEffortLevels(modelId: string): AnthropicEffortLevel[] {
  if (!claudeSupportsAdaptiveThinking(modelId)) return [];
  const v = claudeVersion(modelId);
  const noXhigh = v?.major === 4 && v?.minor === 6;
  return noXhigh ? ["low", "medium", "high", "max"] : ["low", "medium", "high", "xhigh", "max"];
}
```

**Step 4:** `npx vitest run tests/utils.test.ts` → PASS.
**Step 5:** `npm run build && npm run check` → clean.
**Step 6:** Commit `feat(vertex): derive Claude adaptive-thinking + effort ladder from model id`.

---

## Task 2: `effortLevels` on the model config + discovery fallback

**Files:**
- Modify: `types.ts` (next to `adaptiveThinking`, line ~56)
- Modify: `discovery.ts` (`buildModelConfigs`, line ~425)
- Test: `tests/models.test.ts` (or new `tests/discovery.test.ts`)

**Step 1:** Test that a discovered model absent from the static table still gets adaptive thinking:

```ts
it("derives adaptive thinking for undiscovered Claude models instead of legacy budgets", () => {
  const configs = buildModelConfigs(
    [{ publisher: "anthropic", modelId: "claude-opus-5", versionId: "default" }],
    STATIC_MODELS,
  );
  expect(configs.find((c) => c.id === "claude-opus-5")).toMatchObject({
    adaptiveThinking: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  });
});

it("keeps legacy budget thinking for undiscovered 4.5-era Claude models", () => {
  const configs = buildModelConfigs(
    [{ publisher: "anthropic", modelId: "claude-sonnet-4-5", versionId: "20250929" }],
    [],
  );
  expect(configs[0]).toMatchObject({ adaptiveThinking: false, effortLevels: [] });
});
```

Run `npx vitest run tests/discovery.test.ts` → FAIL.

**Step 2:** Add to `types.ts`:

```ts
  /** Accepted output_config.effort values. Empty/undefined = no effort parameter. */
  effortLevels?: AnthropicEffortLevel[];
```

**Step 3:** In `discovery.ts#buildModelConfigs`, replace `adaptiveThinking: defaults.adaptiveThinking` with derivation for Anthropic, keeping publisher defaults for everyone else:

```ts
        adaptiveThinking:
          am.publisher === "anthropic" ? claudeSupportsAdaptiveThinking(am.modelId) : defaults.adaptiveThinking,
        effortLevels:
          am.publisher === "anthropic" ? claudeEffortLevels(am.modelId) : undefined,
```

**Step 4:** Tests PASS; `npm run build`; commit `fix(vertex): derive thinking mode for undiscovered Anthropic models in discovery`.

---

## Task 3: Static table — add Claude 5.x, declare ladders

**Files:**
- Modify: `models/claude.ts`
- Test: `tests/models.test.ts`

**Step 1:** Extend `tests/models.test.ts`:

```ts
it("registers Claude Opus 5 with adaptive thinking and 1M/128K specs", () => {
  expect(getModelById("claude-opus-5")).toMatchObject({
    contextWindow: 1000000,
    maxTokens: 128000,
    adaptiveThinking: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  });
});
it("excludes xhigh from the 4.6 series (Vertex rejects it)", () => {
  for (const id of ["claude-opus-4-6", "claude-sonnet-4-6"])
    expect(getModelById(id)!.effortLevels, id).not.toContain("xhigh");
});
```

**Step 2:** Implement: add `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1` entries (specs/prices from the table above, `region: "global"`, `costRegional` = ×1.1, following the existing entry shape) and add explicit `effortLevels` to every Anthropic entry ≥4.6.

**Step 3:** `npx vitest run tests/models.test.ts && npm run build` → PASS; commit `feat(vertex): add Claude Opus 5/5.5 and Fable 5/5.1 model definitions`.

---

## Task 4: Request shaping — clamp effort, fix `max`, accept mapped values

**Files:**
- Modify: `streaming/maas.ts:33-39` (`mapAnthropicEffort`), `:270-293` (thinking branch)
- Test: `tests/streaming-maas.test.ts` (assert on `mocks.anthropicStream.mock.calls[0][0]`)

**Step 1:** Tests covering the verified failure surface:

```ts
it("sends adaptive thinking + effort for undiscovered-then-derived opus-5", ...)      // was 400 before Task 2
it("maps pi max to Anthropic max instead of silently downgrading to high", ...)      // pi --thinking max
it("maps xhigh to max on models whose ladder lacks xhigh", ...)                       // 4.6 series
it("maps xhigh to xhigh on models that support it", ...)                               // 4.7+/5.x
it("keeps legacy budget_tokens for 4.5-era models and never sends output_config", ...)
it("accepts provider-mapped effort strings already produced by thinkingLevelMap", ...)
it("omits thinking entirely when reasoning is off and never sends type:disabled", ...)
```

**Step 2:** Implement `mapAnthropicEffort(level: string | undefined, levels: AnthropicEffortLevel[])`:

- `minimal|low → low`, `medium → medium`, `high|undefined → high`;
- already-valid effort strings (`xhigh`, `max`) pass through;
- requested level missing from `levels` → step down one rung, then up one rung (`xhigh→max`, `max→xhigh→high`);
- return `undefined` when `levels` is empty (legacy path).

Raise the legacy budget so `xhigh` cannot exceed the model's output cap (`Math.min(budget, maxTokens - 1024)`), keeping the existing `max_tokens > budget_tokens` invariant.

**Step 3:** `npx vitest run tests/streaming-maas.test.ts`; commit `fix(vertex): honor per-model effort ladder and support pi max level`.

---

## Task 5: Publish `thinkingLevelMap` so pi only offers supported levels

**Files:**
- Modify: `index.ts#toPiModel` (line 53)
- Test: `tests/models.test.ts` or new `tests/to-pi-model.test.ts`

**Step 1:** Test: for a 4.6 model the map has `xhigh: null`; for 4.7+/5.x it has `xhigh: "xhigh"`, `max: "max"`; for ≤4.5 `max: null`, `xhigh: "xhigh"`; non-Anthropic models get no map.

**Step 2:** Implement by threading `config.effortLevels` into `thinkingLevelMap`. This is what makes `xhigh`/`max` reachable at all: pi hides them without a non-null entry.

**Step 3:** `npx vitest run && npm run build && npm run check` → commit `feat(vertex): expose per-model thinking levels to pi`.

---

## Task 6: Docs

- `CHANGELOG.md`: Added/Fixed entries for the 400 root cause, opus-5/5.5/fable definitions, `max` level, xhigh rejection.
- `README.md`: model table rows for the four new models + a "Thinking modes" note (adaptive ≥4.6, legacy ≤4.5, `output_config.effort`).
- Run the `updating-documentation` skill against the diff before PR/merge.

---

## Out of scope (tracked, not silently skipped)

1. **Tool-name validation** — Anthropic requires `^[a-zA-Z0-9_-]{1,128}$` on `tools.N.name` and `maas.ts:248` forwards `t.name` unfiltered (only call/result *ids* are sanitized), so one bad name 400s the whole request and no tools work. Awaiting the E2E probe + the reporter's exact symptom before changing replay semantics.
2. **`thinking.display` / `usage.output_tokens_details.thinking_tokens`** — adaptive responses expose these; surfacing them is a separate feature.
3. **Opus 4.5 effort** — Anthropic allows `output_config.effort` alongside `budget_tokens` on Opus 4.5 only; not verifiable in this project (404), so left as `// TODO(debt)`.
