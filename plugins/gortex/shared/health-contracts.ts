import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { hostHealthSchema } from "./health-models.ts";
export const hostHealthRpc = defineRpc({ name: "host.health", input: z.object({}), output: hostHealthSchema });
