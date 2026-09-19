// Explicit live check of the plugin self-update RPCs against a (test) Paseo daemon. Applies the update it finds.
// Usage: node --experimental-strip-types server/plugin-update-live-check.ts <ws url>
// Dev-only: the plugin never imports this internal client; it receives `paseo` from its server context.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const url = process.argv[2];
if (!url) throw new Error("Pass the daemon WebSocket URL, e.g. ws://127.0.0.1:59411/ws");
const client = new DaemonClient({ url, clientId: `gortex-update-check-${process.pid}`, clientType: "cli", connectTimeoutMs: 10000 });
await client.connect();
const invoke = (method: string, input: unknown) => client.invokePluginRpc("gortex", method, input) as Promise<Record<string, unknown>>;
try {
  const before = await invoke("plugin-update.check", {});
  console.log("before:", JSON.stringify(before));
  if (before.state !== "update") throw new Error(`Expected an available update, got ${String(before.state)}`);
  console.log("apply:", JSON.stringify(await invoke("plugin-update.apply", { target: before.target })));
  const started = Date.now();
  let after: Record<string, unknown> | null = null;
  while (Date.now() - started < 300_000) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    try { after = await invoke("plugin-update.check", {}); }
    catch (error) { console.log(`${Math.round((Date.now() - started) / 1000)}s reloading: ${error instanceof Error ? error.message : error}`); continue; }
    console.log(`${Math.round((Date.now() - started) / 1000)}s ${String(after.state)} ${String(after.current)}`);
    if (after.state === "current") break;
  }
  console.log("after:", JSON.stringify(after));
  if (after?.state !== "current" || after.current !== before.target) throw new Error("The plugin did not reach the reviewed target revision.");
  console.log("PASS: updated from", before.current, "to", after.current);
} finally { await client.close(); }
