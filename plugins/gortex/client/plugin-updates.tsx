import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { pluginUpdateApplyRpc, pluginUpdateCheckRpc } from "../shared/plugin-update-contracts.ts";
import { Action, Badge, Button, Card, Notice, SectionHeading } from "./controls.tsx";
import { useHostDateTime } from "./host-time.tsx";

const shortRevision = (value: string | null) => value ? value.slice(0, 7) : "unknown";
const UPDATE_BUDGET_MS = 5 * 60_000;

/** Updates this plugin on the selected host through Paseo's Git-managed `plugin update` flow. */
export function PluginUpdatesPanel({ host, theme }: Pick<PluginSurfaceProps, "host" | "theme">) {
  const check = useRpc(pluginUpdateCheckRpc), apply = useRpc(pluginUpdateApplyRpc);
  const dateTime = useHostDateTime();
  const [confirming, setConfirming] = useState(false);
  const [updatingSince, setUpdatingSince] = useState<number | null>(null);
  const status = useQuery({
    queryKey: [host.id, "gortex", "plugin-update-check"], queryFn: () => check({}), retry: false, staleTime: 10 * 60_000, refetchOnWindowFocus: false,
    // While updating, keep rechecking: the plugin reloads mid-update, so failures here are expected for a moment.
    refetchInterval: updatingSince !== null ? 5000 : false,
  });
  const start = useMutation({ mutationFn: (target: string) => apply({ target }), onSuccess: () => { setConfirming(false); setUpdatingSince(Date.now()); } });
  const data = status.data;
  useEffect(() => {
    if (updatingSince === null) return;
    if (data?.state === "current" || Date.now() - updatingSince > UPDATE_BUDGET_MS) setUpdatingSince(null);
  }, [data, updatingSince]);
  const updating = updatingSince !== null;
  const badge = !data ? null
    : data.state === "update" ? <Badge theme={theme} label="Update available" tone="warning" icon="CircleArrowUp" />
    : data.state === "current" ? <Badge theme={theme} label="Up to date" tone="success" icon="CircleCheck" />
    : data.state === "local" ? <Badge theme={theme} label="Folder install" tone="neutral" />
    : data.state === "installed-newer" ? <Badge theme={theme} label="Ahead of branch" tone="neutral" />
    : <Badge theme={theme} label="Check failed" tone="danger" />;
  return <Card theme={theme}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <SectionHeading theme={theme} title="Gortex plugin" icon="Puzzle" subtitle={`This Paseo plugin on ${host.label}`} />
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        {badge}
        <Action title={status.isFetching && !updating ? "Checking…" : "Check for updates"} icon="RefreshCw" theme={theme} disabled={status.isFetching || updating} onPress={() => { void status.refetch(); }} />
      </View>
    </View>
    {updating && <Notice theme={theme} text="Updating… Paseo downloads, builds and reloads the plugin. This screen may briefly disconnect; it rechecks automatically." />}
    {!updating && status.error && <Notice theme={theme} error text={status.error.message} />}
    {data && !updating && <>
      {data.state === "update" && <>
        <Text style={{ color: theme.colors.foreground }}>{shortRevision(data.current)} → {shortRevision(data.target)}</Text>
        {data.links[0] && <ExternalLink href={data.links[0]} accessibilityLabel="Review the plugin changes on GitHub"><Text style={{ color: theme.colors.accent }}>Review changes</Text></ExternalLink>}
        {!confirming && <View style={{ flexDirection: "row" }}><Action title="Update plugin" icon="Download" primary theme={theme} onPress={() => setConfirming(true)} /></View>}
        {confirming && <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 12, gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Update the Gortex plugin on {host.label}?</Text>
          <Notice theme={theme} text="Runs paseo plugin update gortex. Paseo installs its dependencies, builds it, and reloads it for every client of this host. Gortex itself, its indexes and your settings are not changed." />
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Action title={start.isPending ? "Starting…" : "Confirm update"} icon="Check" primary theme={theme} disabled={start.isPending} onPress={() => start.mutate(data.target!)} />
            <Button title="Cancel" theme={theme} disabled={start.isPending} onPress={() => setConfirming(false)} />
          </View>
        </View>}
      </>}
      {data.state === "current" && <Notice theme={theme} text={`Installed revision ${shortRevision(data.current)} is the latest.`} />}
      {data.state === "local" && <Notice theme={theme} text="Installed from a folder on this host, so Paseo can't update it from Git. Pull the latest changes into that folder, then choose Reload in Settings → Plugins. To get one-click updates, reinstall with: paseo plugin add discwl/huginn:plugins/gortex --ref main" />}
      {data.state === "installed-newer" && <Notice theme={theme} text={`Installed ${shortRevision(data.current)} is newer than the tracked branch (${shortRevision(data.target)}); keeping it.`} />}
      {(data.state === "error" || data.state === "unavailable") && data.error && <Notice theme={theme} error text={data.error} />}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Checked {dateTime(data.checkedAt)}</Text>
    </>}
    {start.error && <Notice theme={theme} error text={start.error.message} />}
  </Card>;
}
