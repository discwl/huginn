export type LibrarySelection = { workspaceId: string; repositoryPath: string | null } | null;
type SelectableRepository = { path: string; workspaceId: string | null; state: string };

/** Called only after an explicit workspace click, never on load or refresh. */
export function chooseWorkspace(repositories: readonly SelectableRepository[], workspaceId: string): LibrarySelection {
  const members = repositories.filter(repo => repo.state === "resolved" && repo.workspaceId === workspaceId);
  if (members.length === 0) return null;
  return { workspaceId, repositoryPath: members.length === 1 ? members[0].path : null };
}

export function chooseRepository(repositories: readonly SelectableRepository[], path: string): LibrarySelection {
  const repo = repositories.find(item => item.path === path && item.state === "resolved" && item.workspaceId !== null);
  return repo?.workspaceId ? { workspaceId: repo.workspaceId, repositoryPath: repo.path } : null;
}

export function selectedRepository<T extends SelectableRepository>(repositories: readonly T[], selection: LibrarySelection): T | null {
  if (!selection?.repositoryPath) return null;
  return repositories.find(repo => repo.state === "resolved" && repo.path === selection.repositoryPath && repo.workspaceId === selection.workspaceId) ?? null;
}
