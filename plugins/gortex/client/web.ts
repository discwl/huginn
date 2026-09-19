import { Platform } from "react-native";

/**
 * The only file allowed to touch browser globals. Paseo's desktop app (Electron) exposes `window.paseoDesktop`,
 * which its own Add project → Browse uses for the native folder dialog. It is not part of the public plugin API,
 * so every call is feature-checked and callers fall back when it is missing or changes shape.
 * Source: getpaseo/paseo packages/desktop/src/preload.ts (dialog.open, invoke "desktop_daemon_status").
 */
type DesktopBridge = {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  dialog: { open(options?: Record<string, unknown>): Promise<unknown> };
};

function bridge(): DesktopBridge | null {
  if (Platform.OS !== "web") return null;
  const candidate = (globalThis as { paseoDesktop?: Partial<DesktopBridge> }).paseoDesktop;
  return candidate && typeof candidate.invoke === "function" && typeof candidate.dialog?.open === "function" ? candidate as DesktopBridge : null;
}

/** The server ID of the daemon this desktop app runs, or null outside the desktop app. */
export async function localDaemonServerId(): Promise<string | null> {
  const desktop = bridge();
  if (!desktop) return null;
  const status = await desktop.invoke("desktop_daemon_status").catch(() => null) as { serverId?: unknown } | null;
  return typeof status?.serverId === "string" && status.serverId.trim() ? status.serverId.trim() : null;
}

/** Opens the desktop app's native folder dialog on this computer. Resolves null when cancelled. */
export async function openDesktopFolderDialog(options: { title?: string; defaultPath?: string } = {}): Promise<string | null> {
  const desktop = bridge();
  if (!desktop) throw new Error("The desktop folder dialog is unavailable in this app.");
  const result = await desktop.dialog.open({ directory: true, title: options.title, defaultPath: options.defaultPath });
  if (result === null || result === undefined) return null;
  if (typeof result !== "string" || !result.trim()) throw new Error("The folder dialog returned an unexpected result.");
  return result;
}
