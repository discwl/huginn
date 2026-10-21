import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { hostHealthSchema } from "./health-models.ts";
// retryNow (Try now): send Gortex requests again right away, even where the plugin had paused them.
export const hostHealthRpc = defineRpc({ name: "host.health", input: z.object({ retryNow: z.boolean().default(false) }), output: hostHealthSchema });
