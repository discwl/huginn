export class NativeError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = "NativeError"; this.code = code; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rejectFallback(value: unknown, depth = 0): void {
  if (depth > 8) return;
  const record = object(value);
  if (!record) return;
  if (record.exact === false) throw new NativeError("inexact_view", "Gortex returned an inexact or fallback view. Select a supported native context.");
  for (const item of Object.values(record)) if (object(item)) rejectFallback(item, depth + 1);
}

export function decodeNativeResult(result: unknown): { value: unknown; meta: unknown } {
  const envelope = object(result);
  if (!envelope) throw new NativeError("invalid_response", "Gortex returned an invalid MCP envelope.");
  if (envelope.isError === true) throw new NativeError("mcp_error", "Gortex rejected the request. Check the selected context and native capabilities.");
  let value: unknown = envelope.structuredContent;
  if (value === undefined) {
    const blocks = Array.isArray(envelope.content) ? envelope.content : [];
    const text = blocks.map(object).filter((item): item is Record<string, unknown> => item !== null && item.type === "text" && typeof item.text === "string");
    if (text.length !== 1) throw new NativeError("invalid_response", "Expected one structured JSON response from Gortex.");
    try { value = JSON.parse(text[0].text as string); }
    catch { throw new NativeError("invalid_json", "Gortex returned non-JSON data for a JSON operation."); }
  }
  if (value === null || typeof value !== "object") throw new NativeError("invalid_payload", "Gortex returned an unsupported scalar payload.");
  const payload = object(value);
  if (payload && (payload.error_code || payload.error || payload.isError === true || payload.status === "error")) {
    const code = typeof payload.error_code === "string" ? payload.error_code : "native_error";
    throw new NativeError(code, `Gortex reported ${code}. The operation did not produce a successful result.`);
  }
  const meta = envelope._meta ?? null;
  rejectFallback(meta);
  rejectFallback(value);
  return { value, meta };
}
