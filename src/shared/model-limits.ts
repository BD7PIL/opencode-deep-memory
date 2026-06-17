const KNOWN_MODEL_LIMITS: Record<string, number> = {
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4": 1_000_000,
  "deepseek-v3": 64_000,
  "deepseek-r1": 64_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "gpt-4o": 128_000,
  "o1": 200_000,
  "o3-mini": 200_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "qwen-max": 131_072,
};

export function lookupModelLimit(modelID: string): number | undefined {
  if (KNOWN_MODEL_LIMITS[modelID]) return KNOWN_MODEL_LIMITS[modelID];
  for (const [key, limit] of Object.entries(KNOWN_MODEL_LIMITS)) {
    if (modelID.includes(key)) return limit;
  }
  return undefined;
}

export const DEFAULT_MAX_CONTEXT = 1_000_000;
