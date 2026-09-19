import { open, opendir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExclusionSources } from "../shared/exclusions.ts";

export interface FolderStat { path: string; files: number }
export interface ExclusionFacts {
  root: string;
  gitignore: string | null;
  nestedGitignores: string[];
  folders: FolderStat[];
  extensions: { extension: string; files: number }[];
  totals: { files: number; truncated: boolean };
  current: { repository: string[]; sources: ExclusionSources };
}
export interface FactsOptions { maxEntries?: number; budgetMs?: number }

async function readBounded(path: string, limit: number): Promise<string | null> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return null;
  try {
    const buffer = Buffer.alloc(limit), { bytesRead } = await file.read(buffer, 0, limit, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return bytesRead === limit ? `${text}\n# … truncated` : text;
  } finally { await file.close(); }
}

/**
 * Metadata-only survey for exclusion suggestions: folder file counts, extensions, and ignore files.
 * Never reads source contents, never follows symlinks, skips .git, and stops at an entry and time budget.
 */
export async function gatherExclusionFacts(root: string, current: ExclusionFacts["current"], options: FactsOptions = {}): Promise<ExclusionFacts> {
  const maxEntries = options.maxEntries ?? 150_000, deadline = performance.now() + (options.budgetMs ?? 5000);
  const folders = new Map<string, FolderStat>(), extensions = new Map<string, number>(), nestedGitignores: string[] = [];
  let files = 0, entries = 0, truncated = false;
  const stack = [root];
  while (stack.length) {
    if (entries >= maxEntries || performance.now() > deadline) { truncated = true; break; }
    const directory = stack.pop()!;
    const handle = await opendir(directory).catch(() => null);
    if (!handle) continue;
    for await (const entry of handle) {
      if (++entries >= maxEntries) { truncated = true; break; }
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== ".git") stack.push(full); continue; }
      if (!entry.isFile()) continue;
      const rel = relative(root, full), parts = rel.split(sep);
      if (entry.name === ".gitignore" && parts.length > 1 && nestedGitignores.length < 20) nestedGitignores.push(rel.split(sep).join("/"));
      // Group by the first two folder levels so large generated trees stand out.
      const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : "(root files)";
      const stat = folders.get(key) ?? { path: key, files: 0 };
      stat.files++; folders.set(key, stat);
      const extension = extname(entry.name).toLowerCase() || "(none)";
      extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
      files++;
    }
  }
  return {
    root,
    gitignore: await readBounded(join(root, ".gitignore"), 8192),
    nestedGitignores,
    folders: [...folders.values()].sort((a, b) => b.files - a.files).slice(0, 40),
    extensions: [...extensions].map(([extension, count]) => ({ extension, files: count })).sort((a, b) => b.files - a.files).slice(0, 15),
    totals: { files, truncated },
    current,
  };
}

/** The agent's whole brief. Everything it needs is inline, so it has no reason to run tools. */
export function suggestionPrompt(facts: ExclusionFacts): string {
  const list = (items: string[]) => items.length ? items.map(item => `  ${item}`).join("\n") : "  (none)";
  const s = facts.current.sources;
  return [
    "You are recommending Gortex index exclusion and inclusion rules for one repository.",
    "Gortex is a code-intelligence indexer (symbols, call graphs, search). Excluding generated, vendored, build-output, dependency, cache, large binary/data and lock files keeps the index fast and search results relevant. Source code, tests, configuration that code reads, and docs that explain code should stay indexed.",
    "",
    "Do not run tools, read files, or edit anything. Everything you need is below.",
    "Reply with only one JSON object, no prose, markdown or YAML, in exactly this shape:",
    "{\"exclude\":[{\"pattern\":\"**/bin/\",\"reason\":\"Build output\",\"confidence\":\"high\"}],\"include\":[],\"notes\":\"\"}",
    "confidence is \"high\", \"medium\" or \"low\". Use empty arrays when nothing is worth changing.",
    "",
    "Rules:",
    "- Patterns are gitignore-style, relative to the repository root, e.g. \"**/bin/\", \"dist/\", \"*.min.js\". Never start a pattern with \"!\".",
    "- \"exclude\": things to drop from the index. Do not repeat patterns already excluded by any layer below, and do not re-list what .gitignore already covers while respect_gitignore is true.",
    "- \"include\": only for files or folders that are excluded (by .gitignore or a broader rule) but are worth indexing, such as checked-in generated API clients that code calls. The plugin applies them as \"!pattern\". Usually empty.",
    "- Prefer a few precise, high-value rules over many speculative ones. Use confidence \"low\" when unsure.",
    "- Put anything the user should know (e.g. the survey was truncated) in \"notes\"; keep it short.",
    "",
    `Repository: ${facts.root}`,
    `Survey: ${facts.totals.files} files${facts.totals.truncated ? " (truncated: the tree is larger than the survey budget)" : ""}.`,
    "",
    "Largest folders by file count (first two levels):",
    list(facts.folders.map(folder => `${folder.path} — ${folder.files} files`)),
    "",
    "Most common file extensions:",
    list(facts.extensions.map(item => `${item.extension} — ${item.files}`)),
    "",
    `Root .gitignore:${facts.gitignore === null ? " (none)" : ""}`,
    facts.gitignore === null ? "" : facts.gitignore.split(/\r?\n/).map(line => `  ${line}`).join("\n"),
    "Nested .gitignore files:",
    list(facts.nestedGitignores),
    "",
    `Gortex respect_gitignore: ${s.respectGitignore}`,
    "Current Gortex exclusions by layer:",
    `  This repository (editable here): ${facts.current.repository.join(", ") || "(none)"}`,
    `  Global: ${s.global.join(", ") || "(none)"}`,
    `  Repository .gortex.yaml exclude: ${s.local.join(", ") || "(none)"}`,
    `  Repository .gortex.yaml include: ${s.include.join(", ") || "(none)"}`,
    `  Legacy index/watch excludes: ${[...s.legacyIndex, ...s.legacyWatch].join(", ") || "(none)"}`,
  ].join("\n");
}
