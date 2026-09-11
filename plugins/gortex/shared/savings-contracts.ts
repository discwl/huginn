import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { hostSavingsSchema } from "./savings-models.ts";
export const hostSavingsRpc = defineRpc({ name: "host.savings", input: z.object({}), output: hostSavingsSchema });
