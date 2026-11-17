import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LibrarySurface } from "./client/workspace-library.tsx";
import { Settings } from "./client/settings.tsx";
import { WorkspaceInspector } from "./client/workspace-inspector.tsx";

export default function contribute(client: PluginClientContext) {
  const remove = [
    client.addSurface("library", LibrarySurface),
    client.addWorkspacePanel({ id: "workspace-inspector", title: "Gortex inspector", icon: "Network", locations: ["explorer"], Component: WorkspaceInspector }),
    client.addCommandCenterItem({
      id: "inspect-workspace", title: "Inspect workspace with Gortex", icon: "Network", context: "workspace",
      onSelect({ openPanel }) { openPanel("workspace-inspector", { location: "explorer" }); },
    }),
    client.addSidebarItem({ id: "library", title: "Gortex", icon: "Network", surface: "library" }),
    client.addSettingsScreen({ id: "preferences", title: "Gortex", icon: "Settings", Component: Settings }),
    client.addCommandCenterItem({ id: "open-library", title: "Open Gortex library", icon: "Network", context: "global", onSelect({ openSurface }) { openSurface("library"); } }),
  ];
  return () => { for (const cleanup of remove.reverse()) cleanup(); };
}
