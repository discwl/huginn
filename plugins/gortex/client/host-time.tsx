import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { createDateTimeFormatter, hostTimeRpc } from "../shared/date-time.ts";

const HostTime = createContext(createDateTimeFormatter(null));
export function HostTimeProvider({ hostId, children }: { hostId: string; children: ReactNode }) {
  const read = useRpc(hostTimeRpc);
  const settings = useQuery({ queryKey: [hostId, "gortex", "host-time-settings"], queryFn: () => read({}), staleTime: 60000, refetchInterval: 60000, refetchIntervalInBackground: false, retry: false });
  const format = useMemo(() => createDateTimeFormatter(settings.isError ? null : settings.data ?? null), [settings.isError, settings.data]);
  return <HostTime.Provider value={format}>{children}</HostTime.Provider>;
}
export function useHostDateTime() { return useContext(HostTime); }
