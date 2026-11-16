import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LibrarySurface } from "./client/workspace-library.tsx";
import { Settings } from "./client/settings.tsx";
import { WorkspaceInspector } from "./client/workspace-inspector.tsx";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { GortexRowBadge } from "./client/workspace-row-badge.tsx";

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
  // Paseo 0.16 apps: a badge on workspace rows Gortex doesn't index or is paused for. Older apps have neither API.
  if (typeof client.addWorkspaceRowBadgeItem === "function" && WorkspaceRowBadge) {
    remove.push(client.addWorkspaceRowBadgeItem({ id: "gortex-status", title: "Gortex status", icon: "Network", Component: GortexRowBadge }));
  }
  return () => { for (const cleanup of remove.reverse()) cleanup(); };
}
