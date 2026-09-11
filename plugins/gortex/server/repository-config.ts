import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { homedir } from "node:os";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import { z } from "zod";
import type { RepositoryFields } from "../shared/metadata-contracts.ts";
import { exclusionPatternsSchema, type ExclusionSources } from "../shared/exclusions.ts";

const MAX_CONFIG_BYTES = 1024 * 1024;
const entrySchema = z.object({ path: z.string().min(1), name: z.string().optional(), workspace: z.string().optional(), project: z.string().optional(), ref: z.string().optional(), exclude: z.array(z.string()).max(2000).optional() }).passthrough();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function sameRepositoryPath(a: string, b: string): boolean {
  const fold = (value: string) => process.platform === "win32" ? normalize(value).toLowerCase() : normalize(value);
  return fold(a) === fold(b);
}
export function globalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && isAbsolute(xdg) ? join(xdg, "gortex", "config.yaml") : join(homedir(), ".gortex", "config.yaml");
}
async function boundedText(path: string, optional = false): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
    const size = (await handle.stat()).size;
    if (size > MAX_CONFIG_BYTES) throw new Error("Configuration exceeds the 1 MiB editor budget.");
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_CONFIG_BYTES) throw new Error("Configuration exceeds the 1 MiB editor budget.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  } finally { await handle?.close(); }
}
function parseConfig(text: string) {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, logLevel: "silent", intAsBigInt: true });
  if (doc.errors.length || doc.warnings.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error("Configuration has unsupported or invalid YAML. Check it on the host before editing.");
  let indirect = false;
  visit(doc, (_key, node) => { if (isAlias(node) || ((isMap(node) || isSeq(node) || isScalar(node)) && node.anchor)) indirect = true; });
  if (indirect) throw new Error("The metadata editor does not modify YAML with anchors or aliases. Edit that configuration on the host.");
  return doc;
}

export interface ConfigSnapshot {
  path: string; configPath: string; text: string; localText: string; revision: string; entryIndex: number;
  configured: RepositoryFields; effective: RepositoryFields;
  extra: { ref: string | null; exclude: string[]; unknownKeys: string[] };
  exclusionSources: ExclusionSources;
  canRebuild: boolean; warnings: string[];
}
export class RepositoryConfig {
  private configPath: string;
  constructor(configPath = globalConfigPath()) { this.configPath = configPath; }

  async load(path: string): Promise<ConfigSnapshot> {
    const canonical = await realpath(path);
    const [text, localText, configStat] = await Promise.all([boundedText(this.configPath), boundedText(join(canonical, ".gortex.yaml"), true), lstat(this.configPath)]);
    if (!configStat.isFile() || configStat.isSymbolicLink()) throw new Error("The metadata editor requires a regular global configuration file, not a symbolic link.");
    const doc = parseConfig(text);
    const repos = z.array(entrySchema).max(10000).parse(doc.toJS({ maxAliasCount: 0 })?.repos);
    const matches: number[] = [];
    for (const [i, entry] of repos.entries()) {
      if (!isAbsolute(entry.path)) throw new Error("Resolve relative repository paths in the global config before using the editor.");
      try { if (sameRepositoryPath(await realpath(entry.path), canonical)) matches.push(i); } catch { /* An inaccessible unrelated repository cannot match. */ }
    }
    if (matches.length !== 1) throw new Error("Expected exactly one native repos entry for this path. Refresh or resolve duplicate entries on the host.");
    const entryIndex = matches[0];
    const entry = repos[entryIndex];
    const patterns = z.array(z.string()).max(2000).optional();
    const local = z.object({
      workspace: z.string().optional(), project: z.string().optional(), projects: z.array(z.unknown()).optional(),
      exclude: patterns, include: patterns, respect_gitignore: z.boolean().optional(),
      index: z.object({ exclude: patterns }).optional(), watch: z.object({ exclude: patterns }).optional(),
    }).parse(parseConfig(localText).toJS({ maxAliasCount: 0 }) ?? {});
    const exclusionSources: ExclusionSources = {
      global: patterns.parse(doc.toJS({ maxAliasCount: 0 })?.exclude) ?? [],
      local: local.exclude ?? [], include: local.include ?? [],
      legacyIndex: local.exclude?.length ? [] : local.index?.exclude ?? [],
      legacyWatch: local.exclude?.length ? [] : local.watch?.exclude ?? [],
      respectGitignore: local.respect_gitignore ?? true,
    };
    const configured = { name: entry.name ?? "", workspace: entry.workspace ?? "", project: entry.project ?? "" };
    const effective = effectiveFields(entry.path, configured, local);
    const warnings: string[] = [];
    let canRebuild = false;
    try { canRebuild = (await lstat(join(canonical, ".git"))).isDirectory(); } catch { /* Plain folders and automatic worktrees need different admission contracts. */ }
    if (!canRebuild) warnings.push("Index refresh from this editor is limited to a Git repository with its own .git directory. Worktree and plain-folder refresh is unavailable.");
    if (local.projects?.length) { canRebuild = false; warnings.push("This repository has per-file project mappings in .gortex.yaml; a single project value cannot describe that graph."); }
    const known = new Set(["path", "name", "workspace", "project", "ref", "exclude"]);
    const extra = { ref: entry.ref ?? null, exclude: entry.exclude ?? [], unknownKeys: Object.keys(entry).filter(key => !known.has(key)) };
    if (extra.unknownKeys.length) warnings.push("Some keys under this repo are not part of Gortex 0.64.3's RepoEntry schema. Their values will be preserved.");
    return { path: canonical, configPath: this.configPath, text, localText, revision: digest(JSON.stringify([canonical, text, localText])), entryIndex, configured, effective, extra, exclusionSources, canRebuild, warnings };
  }

  prepare(snapshot: ConfigSnapshot, input: RepositoryFields, exclude?: string[]): { text: string; effective: RepositoryFields; configured: RepositoryFields; exclude: string[] } {
    const configured = { name: input.name.trim(), workspace: input.workspace.trim(), project: input.project.trim() };
    for (const [key, value] of Object.entries(configured)) {
      if (value && !/^[\p{L}\p{N}_][\p{L}\p{N}_.@-]*$/u.test(value)) throw new Error(`${key}: use letters, numbers, underscores, dots, @ or hyphens, starting with a letter, number or underscore.`);
    }
    const doc = parseConfig(snapshot.text);
    const entry = doc.getIn(["repos", snapshot.entryIndex], true);
    if (!isMap(entry)) throw new Error("Unsupported repository entry structure.");
    for (const [key, value] of Object.entries(configured)) {
      if (value) entry.set(key, value); else entry.delete(key);
    }
    const candidateExclude = exclude === undefined ? snapshot.extra.exclude : exclusionPatternsSchema.parse(exclude);
    if (exclude !== undefined) {
      if (candidateExclude.length) entry.set("exclude", doc.createNode(candidateExclude)); else entry.delete("exclude");
    }
    const raw = doc.toJS({ maxAliasCount: 0 });
    const groups = [raw.repos, ...Object.values(raw.projects ?? {}).map((group: unknown) => (group as { repos?: unknown }).repos ?? [])];
    const newName = configured.name || basename(raw.repos[snapshot.entryIndex].path);
    for (const group of groups) {
      for (const candidate of z.array(entrySchema).parse(group)) {
        if (!sameRepositoryPath(candidate.path, raw.repos[snapshot.entryIndex].path) && (candidate.name || basename(candidate.path)) === newName) throw new Error("Another repository already uses that name. Choose a unique repository name.");
        if (sameRepositoryPath(candidate.path, raw.repos[snapshot.entryIndex].path) && (candidate.name || basename(candidate.path)) !== newName) throw new Error("This repository also has a different name in a legacy projects group. Resolve that conflict on the host first.");
      }
    }
    const text = doc.toString({ lineWidth: 0 });
    const local = parseConfig(snapshot.localText).toJS({ maxAliasCount: 0 }) ?? {};
    return { text: snapshot.text.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text, configured, exclude: candidateExclude, effective: effectiveFields(raw.repos[snapshot.entryIndex].path, configured, local) };
  }

  async save(snapshot: ConfigSnapshot, text: string): Promise<string> {
    const fresh = await this.load(snapshot.path);
    if (fresh.revision !== snapshot.revision) throw new Error("Configuration changed since the preview. Review a fresh preview before saving.");
    const id = randomUUID();
    const backupPath = join(dirname(this.configPath), `config.yaml.paseo-${id}.bak`);
    const temporary = join(dirname(this.configPath), `.config.yaml.paseo-${id}.tmp`);
    // Exclusive creation, private permissions, and fsync before atomic replacement.
    try {
      for (const [path, value] of [[backupPath, snapshot.text], [temporary, text]]) {
        const handle = await open(path, "wx", 0o600);
        try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); }
      }
      if ((await this.load(snapshot.path)).revision !== snapshot.revision) throw new Error("Configuration changed during save. No replacement was made; refresh the preview.");
      await rename(temporary, this.configPath);
    } finally { await unlink(temporary).catch(() => {}); }
    return backupPath;
  }
}
function effectiveFields(path: string, fields: RepositoryFields, local: { workspace?: string; project?: string }): RepositoryFields {
  const name = fields.name || basename(path);
  return { name, workspace: fields.workspace || local.workspace || name, project: fields.project || local.project || name };
}
