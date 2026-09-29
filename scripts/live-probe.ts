/**
 * Manual live probe — NOT part of `npm test` (requires network + ADC).
 *
 * Proves end-to-end that the system prompt and tool declarations reach Vertex,
 * by forcing a real Claude/Gemini call that can only be satisfied by emitting a
 * tool_use block. A large `input` token count is the corroborating signal: the
 * system prompt and tool schema are billed as input tokens, so a bare
 * "what's the weather" prompt should land in the hundreds, not the tens.
 *
 *   npx tsx scripts/live-probe.ts [modelId]
 */

import { type Tool, normalizeContext } from "@earendil-works/pi-ai";
import { getModelById } from "../models/index.js";
import { streamVertex } from "../streaming/index.js";

const modelId = process.argv[2] ?? "claude-haiku-4-5";
const model = getModelById(modelId);
if (!model) {
  console.error(`Unknown model: ${modelId}`);
  process.exit(1);
}

const weatherTool: Tool = {
  name: "get_weather",
  description: "Get the current weather for a city. Always use this tool for weather questions.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  } as any,
};

const context = normalizeContext({
  systemPrompt:
    "You are a test harness. You MUST respond by calling the get_weather tool. " +
    "Never answer in plain text.",
  tools: [weatherTool],
  messages: [
    { role: "user", content: "What is the weather in Prague?", timestamp: Date.now() },
  ],
});

const stream = streamVertex(model, context, {
  ...(model.reasoning ? { reasoning: "low" as const } : {}),
});

let toolCalls: Array<{ name: string; args: unknown }> = [];
let text = "";
let usage: any;
let stopReason: string | undefined;

for await (const event of stream) {
  if (event.type === "error") {
    console.error(`PROBE ERROR: ${event.error.errorMessage ?? "unknown"}`);
    process.exit(2);
  }
  if (event.type !== "done") continue;
  stopReason = event.reason;
  usage = event.message.usage;
  for (const block of event.message.content) {
    if (block.type === "toolCall") toolCalls.push({ name: block.name, args: block.arguments });
    if (block.type === "text") text += block.text;
  }
}

const result = {
  modelId,
  endpointType: model.endpointType,
  stopReason,
  inputTokens: usage?.input,
  outputTokens: usage?.output,
  toolCalls,
  text: text.slice(0, 200),
  verdict:
    toolCalls.length > 0 && toolCalls[0].name === "get_weather"
      ? "PASS — tool was exposed and the model called it"
      : "FAIL — no tool call came back",
};

console.log(JSON.stringify(result, null, 2));
process.exit(toolCalls.length > 0 ? 0 : 3);
