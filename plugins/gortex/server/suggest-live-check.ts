// Explicit live check of the exclusion-suggestion RPCs through the running Paseo daemon.
// Starts one real read-only agent; applies nothing. Usage: node --experimental-strip-types server/suggest-live-check.ts <repo path> [ws url]
// Dev-only: the plugin never imports this internal client; it receives `paseo` from its server context.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const path = process.argv[2];
if (!path) throw new Error("Pass an indexed repository path.");
const urls = process.argv[3] ? [process.argv[3]] : ["ws://127.0.0.1:6767/ws", "ws://127.0.0.1:6767"];
let client: DaemonClient | null = null, lastError: unknown = null;
for (const url of urls) {
  const candidate = new DaemonClient({ url, clientId: `gortex-suggest-check-${process.pid}`, clientType: "cli", connectTimeoutMs: 10000 });
  try { await candidate.connect(); client = candidate; console.log(`connected ${url}`); break; }
  catch (error) { lastError = error; await candidate.close().catch(() => {}); }
}
if (!client) throw lastError;
try {
  const invoke = (method: string, input: unknown) => client!.invokePluginRpc("gortex", method, input) as Promise<Record<string, unknown>>;
  let job = await invoke("exclusions.suggest.start", { path });
  console.log(JSON.stringify({ started: job.id, agent: job.agent, stage: job.stage }));
  const started = Date.now();
  while (job.stage !== "done" && Date.now() - started < 360_000) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    job = await invoke("exclusions.suggest.job", { id: job.id });
    process.stdout.write(`${Math.round((Date.now() - started) / 1000)}s ${job.stage}\n`);
  }
  console.log(JSON.stringify(job, null, 2));
  const latest = await invoke("exclusions.suggest.latest", { path });
  console.log(`latest matches: ${(latest.job as { id?: string } | null)?.id === job.id}`);
} finally { await client.close(); }
