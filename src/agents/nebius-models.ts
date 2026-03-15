import type { ModelDefinitionConfig } from "../config/types.models.js";

export const NEBIUS_BASE_URL = "https://api.studio.nebius.ai/v1";

export const NEBIUS_MODEL_CATALOG: Array<{
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number };
}> = [
  {
    id: "nvidia/Llama-3.1-Nemotron-70B-Instruct",
    name: "Nemotron 3 Super 120B (NVIDIA)",
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0.30, output: 0.90 },
  },
  {
    id: "moonshot/Kimi-k2.5",
    name: "Kimi K2.5 (Moonshot AI)",
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0.50, output: 2.50 },
  },
  {
    id: "zai/GLM-5-Plus",
    name: "GLM-5 (Z.ai)",
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 1.00, output: 3.20 },
  },
];

export function buildNebiusModelDefinition(params: {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number };
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: {
      input: params.cost.input,
      output: params.cost.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  };
}
