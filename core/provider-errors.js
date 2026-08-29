const PROVIDER_NAMES = Object.freeze({ groq: "Groq", gemini: "Gemini", openai: "OpenAI", compatible: "OpenAI-compatible provider", ollama: "local Ollama" });

function failureReason(failure) {
  if (failure.status === 429) return "quota or rate limit";
  if (failure.status === 401) return "API key rejected";
  if (failure.reason) return failure.reason;
  if (failure.status) return `HTTP ${failure.status}`;
  return "unavailable";
}

export function formatProviderError(error) {
  if (Array.isArray(error?.providerFailures)) {
    const detail = error.providerFailures.map((failure) => `${PROVIDER_NAMES[failure.provider] || failure.provider}: ${failureReason(failure)}`).join("; ");
    return `All configured AI providers failed (${detail}). Check provider limits or start the local Ollama fallback.`;
  }
  const name = PROVIDER_NAMES[error?.jarvisProvider] || "The selected AI provider";
  if (error?.status === 401) return `${name} rejected its private API key.`;
  if (error?.status === 429) return `${name} reached its quota or rate limit. Try again later or select another configured provider.`;
  return error?.message || "AI provider request failed.";
}
