import { useCallback, useRef } from "react";
import { View } from "react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Notice } from "./controls.tsx";
import { RepositoryUntrack } from "./repository-untrack.tsx";

type Props = Pick<PluginSurfaceProps, "host" | "theme"> & {
  name: string; path: string; onClose: () => void; onChanged: () => void;
};

export function RepositoryUntrackDialog({ host, theme, name, path, onClose, onChanged }: Props) {
  const working = useRef(false);
  const onBusy = useCallback((_locked: boolean, pending: boolean) => { working.current = pending; }, []);
  function dismiss() { if (!working.current) onClose(); }
  return <Modal title={`Untrack ${name}?`} icon={<Icon name="Trash2" size={18} color={theme.colors.statusDanger} />} open onOpenChange={open => { if (!open) dismiss(); }}>
    <Modal.Content>
      <View style={{ gap: 14 }}>
        <Notice theme={theme} text={`${host.label} · ${path}`} />
        <Notice theme={theme} text="Gortex will remove the explicit tracking entry and release its dedicated index, including the associated graph data it no longer needs. Your source folder and Paseo workspaces will be kept." />
        <RepositoryUntrack key={`${host.id}:${path}`} host={host} theme={theme} path={path} disabled={false} autoReview onDismiss={dismiss} onBusy={onBusy} onChanged={onChanged} />
      </View>
    </Modal.Content>
  </Modal>;
}
