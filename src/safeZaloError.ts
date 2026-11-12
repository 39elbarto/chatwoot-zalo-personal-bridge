// Never log SDK messages, stacks, request/response bodies or arbitrary strings.
export function safeZaloError(error: unknown) {
  const e = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = e.code ?? e.error_code;
  const numericCode = typeof code === "number" ? code : typeof code === "string" && /^-?\d{1,9}$/.test(code) ? Number(code) : null;
  const knownTypes = ["Error", "ZaloApiError", "ZcaApiError", "ZaloError", "TypeError", "AbortError", "TimeoutError"];
  return {
    error_type: typeof e.name === "string" && knownTypes.includes(e.name) ? e.name : "unclassified",
    provider_code: typeof numericCode === "number" && Number.isSafeInteger(numericCode) ? numericCode : null,
  };
}
