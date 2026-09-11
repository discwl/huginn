import { homedir } from "node:os";
import { nativeSavingsSchema } from "../shared/savings-models.ts";
import { runProcess } from "./process-runner.ts";
import { NativeError } from "./native-response.ts";

export async function readHostSavings() {
  const text = await runProcess("gortex", ["savings", "--json"], homedir());
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new NativeError("savings_shape", "Gortex returned an invalid savings report."); }
  const report = nativeSavingsSchema.safeParse(value);
  if (!report.success) throw new NativeError("savings_shape", "The Gortex savings report has an unsupported shape.");
  return { scope: "host" as const, observedAt: new Date().toISOString(), lastUpdated: report.data.last_updated, buckets: report.data.buckets };
}
