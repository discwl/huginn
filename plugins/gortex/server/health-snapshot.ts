import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { daemonHealthSchema, type DaemonHealth } from "../shared/health-models.ts";
import { decodeNativeResult, NativeError } from "./native-response.ts";

const notificationSchema = z.object({ method: z.literal("notifications/daemon_health"), params: z.unknown() });

/** A bounded subscription on a pooled connection; never a daemon lifecycle operation. */
export async function sampleDaemonHealth(client: Client, waitMs = 5000): Promise<DaemonHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscribed = false;
  const previousClose = client.onclose;
  let rejectSnapshot: (error: Error) => void = () => {};
  const snapshot = new Promise<DaemonHealth>((resolve, reject) => {
    rejectSnapshot = reject;
    timer = setTimeout(() => reject(new NativeError("health_timeout", "The daemon did not provide a health snapshot. Refresh to retry.")), waitMs);
    client.setNotificationHandler(notificationSchema, event => {
      const parsed = daemonHealthSchema.safeParse(event.params);
      if (parsed.success) resolve(parsed.data);
      else reject(new NativeError("health_shape", "The daemon health response has an unsupported shape."));
    });
  });
  // Subscription may reject before the snapshot promise is awaited.
  void snapshot.catch(() => {});
  const onclose = () => { previousClose?.(); rejectSnapshot(new NativeError("health_disconnected", "The Gortex connection closed during the health check.")); };
  client.onclose = onclose;
  try {
    subscribed = true; // A timeout does not prove the server ignored the subscription.
    decodeNativeResult(await client.callTool({ name: "session", arguments: { operation: "subscribe", channel: "daemon_health", arguments: { interval_ms: 1000 } } }, undefined, { timeout: waitMs }));
    return await snapshot;
  } finally {
    if (timer) clearTimeout(timer);
    client.removeNotificationHandler("notifications/daemon_health");
    if (client.onclose === onclose) client.onclose = previousClose;
    if (subscribed) {
      try {
        decodeNativeResult(await client.callTool({ name: "session", arguments: { operation: "unsubscribe", channel: "daemon_health" } }, undefined, { timeout: 2000 }));
      } catch {
        // Disconnect releases the server-side subscription even if its acknowledgement was lost.
        await client.close().catch(() => {});
      }
    }
  }
}
