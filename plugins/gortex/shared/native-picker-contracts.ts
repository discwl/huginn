import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const path = z.string().min(1).max(32767).refine(value => !value.includes("\0"));
const id = z.object({ id: z.string().uuid() });
export const nativePickerCapabilitiesRpc = defineRpc({ name: "nativepicker.capabilities", input: z.object({}), output: z.object({ available: z.boolean(), reason: z.string() }) });
export const nativePickerStartRpc = defineRpc({ name: "nativepicker.start", input: z.object({ initialPath: path.optional() }), output: id });
export const nativePickerPollRpc = defineRpc({ name: "nativepicker.poll", input: id, output: z.object({ id: z.string().uuid(), state: z.enum(["open", "selected", "cancelled", "error"]), path: path.nullable(), error: z.string().nullable() }) });
export const nativePickerCancelRpc = defineRpc({ name: "nativepicker.cancel", input: id, output: z.object({ cancelled: z.boolean() }) });
