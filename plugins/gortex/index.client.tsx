import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LibrarySurface } from "./client/workspace-library.tsx";
import { Settings } from "./client/settings.tsx";

export default function contribute(client: PluginClientContext) {
  const remove = [
    client.addSurface("library", LibrarySurface),
    client.addSidebarItem({ id: "library", title: "Gortex", icon: "Network", surface: "library" }),
    client.addSettingsScreen({ id: "preferences", title: "Gortex", icon: "Settings", Component: Settings }),
    client.addCommandCenterItem({ id: "open-library", title: "Open Gortex library", icon: "Network", context: "global", onSelect({ openSurface }) { openSurface("library"); } }),
  ];
  return () => { for (const cleanup of remove.reverse()) cleanup(); };
}
