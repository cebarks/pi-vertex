/**
 * Streaming handler dispatcher
 */

import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamOptions, TranscriptContext, VertexModelConfig } from "../types.js";
import { streamGemini } from "./gemini.js";
import { streamMaaS } from "./maas.js";

export function streamVertex(
  model: VertexModelConfig,
  context: TranscriptContext,
  options?: StreamOptions,
): AssistantMessageEventStream {
  switch (model.endpointType) {
    case "gemini":
      return streamGemini(model, context, options);
    case "maas":
      return streamMaaS(model, context, options);
    default: {
      const exhaustive: never = model.endpointType;
      throw new Error(`Unknown endpoint type: ${String(exhaustive)}`);
    }
  }
}

export { streamGemini, streamMaaS };
