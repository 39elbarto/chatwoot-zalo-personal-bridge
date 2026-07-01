import fs from "fs";
import path from "path";

export type ZaloMention = {
  pos: number;
  uid: string;
  len: number;
};

type AliasConfig = {
  uid?: string;
  label?: string;
  members?: string[];
  disabled?: boolean;
};

type GroupConfig = Record<string, AliasConfig>;

type MentionConfig = {
  groups: Record<string, GroupConfig>;
};

export type MentionResolution = {
  text: string;
  mentions: ZaloMention[];
  aliases: string[];
  missingAliases: string[];
  insertedLabels: string[];
  configuredGroup: boolean;
};

type LoadedConfig = {
  mtimeMs: number | null;
  config: MentionConfig;
};

const EMPTY_CONFIG: MentionConfig = { groups: {} };
const MARKER_RE = /\[\[zalo:([^\]]+)\]\]/gi;

function normalizeAlias(alias: string) {
  return alias.trim().toLowerCase();
}

export function extractZaloMentionMarkers(text: string): { text: string; aliases: string[] } {
  const aliases: string[] = [];
  const cleaned = text.replace(MARKER_RE, (_match, rawAliases: string) => {
    for (const rawAlias of String(rawAliases).split(",")) {
      const alias = normalizeAlias(rawAlias);
      if (alias) aliases.push(alias);
    }
    return "";
  });

  const seen = new Set<string>();
  return {
    text: cleaned.replace(/[ \t]+\n/g, "\n").trim(),
    aliases: aliases.filter((alias) => {
      if (seen.has(alias)) return false;
      seen.add(alias);
      return true;
    }),
  };
}

function normalizeLabel(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function normalizeConfig(raw: any): MentionConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_CONFIG;
  const rawGroups = raw.groups && typeof raw.groups === "object" && !Array.isArray(raw.groups) ? raw.groups : raw;
  const groups: Record<string, GroupConfig> = {};

  for (const [threadId, rawGroup] of Object.entries(rawGroups)) {
    if (!threadId || !rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) continue;
    const group: GroupConfig = {};
    for (const [aliasName, rawAlias] of Object.entries(rawGroup)) {
      if (!rawAlias || typeof rawAlias !== "object" || Array.isArray(rawAlias)) continue;
      const alias = normalizeAlias(aliasName);
      if (!alias) continue;
      const entry = rawAlias as Record<string, unknown>;
      const uid = typeof entry.uid === "string" ? entry.uid.trim() : undefined;
      const label = typeof entry.label === "string" ? normalizeLabel(entry.label) : undefined;
      const members = Array.isArray(entry.members)
        ? entry.members.map((member) => normalizeAlias(String(member))).filter(Boolean)
        : undefined;
      const disabled = entry.disabled === true;
      if (disabled || members?.length || (uid && label)) {
        group[alias] = { uid, label, members, disabled };
      }
    }
    groups[threadId] = group;
  }

  return { groups };
}

export class ZaloMentionResolver {
  private loaded: LoadedConfig | null = null;
  private warnedMissingConfig = false;

  constructor(private configFile: string) {}

  resolve(threadId: string, text: string): MentionResolution {
    const parsed = extractZaloMentionMarkers(text);
    if (!parsed.aliases.length) {
      return {
        text,
        mentions: [],
        aliases: [],
        missingAliases: [],
        insertedLabels: [],
        configuredGroup: false,
      };
    }

    const config = this.loadConfig();
    const group = config.groups[threadId];
    if (!group) {
      console.warn("[zalo-mentions-unconfigured-group]", { threadId, aliases: parsed.aliases });
      return {
        text: parsed.text,
        mentions: [],
        aliases: parsed.aliases,
        missingAliases: parsed.aliases,
        insertedLabels: [],
        configuredGroup: false,
      };
    }

    const missingAliases: string[] = [];
    const resolved = this.resolveAliases(group, parsed.aliases, missingAliases);
    const unique = new Map<string, { uid: string; label: string }>();
    for (const item of resolved) {
      if (!unique.has(item.uid)) unique.set(item.uid, item);
    }

    let finalText = parsed.text;
    const insertedLabels: string[] = [];
    for (const item of unique.values()) {
      if (!finalText.includes(item.label)) insertedLabels.push(item.label);
    }
    if (insertedLabels.length) {
      finalText = `${insertedLabels.join(" ")}${finalText ? ` ${finalText}` : ""}`.trim();
    }

    const mentions: ZaloMention[] = [];
    let searchFrom = 0;
    for (const item of unique.values()) {
      let pos = finalText.indexOf(item.label, searchFrom);
      if (pos < 0) pos = finalText.indexOf(item.label);
      if (pos < 0) {
        missingAliases.push(item.label);
        continue;
      }
      mentions.push({ pos, uid: item.uid, len: item.label.length });
      searchFrom = pos + item.label.length;
    }

    if (missingAliases.length) {
      console.warn("[zalo-mentions-alias-missing]", { threadId, aliases: missingAliases });
    }

    return {
      text: finalText,
      mentions,
      aliases: parsed.aliases,
      missingAliases,
      insertedLabels,
      configuredGroup: true,
    };
  }

  private resolveAliases(
    group: GroupConfig,
    aliases: string[],
    missingAliases: string[],
    seen = new Set<string>(),
  ): Array<{ uid: string; label: string }> {
    const out: Array<{ uid: string; label: string }> = [];
    for (const alias of aliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      const entry = group[alias];
      if (!entry || entry.disabled) {
        missingAliases.push(alias);
        continue;
      }
      if (entry.members?.length) {
        out.push(...this.resolveAliases(group, entry.members, missingAliases, seen));
        continue;
      }
      if (entry.uid && entry.label) {
        out.push({ uid: entry.uid, label: entry.label });
      } else {
        missingAliases.push(alias);
      }
    }
    return out;
  }

  private loadConfig(): MentionConfig {
    const resolvedPath = path.resolve(this.configFile);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(resolvedPath);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn("[zalo-mentions-config-error]", { path: resolvedPath, message: err?.message || String(err) });
      } else if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true;
        console.log("[zalo-mentions-config-missing]", { path: resolvedPath });
      }
      this.loaded = { mtimeMs: null, config: EMPTY_CONFIG };
      return EMPTY_CONFIG;
    }

    if (this.loaded && this.loaded.mtimeMs === stat.mtimeMs) return this.loaded.config;

    try {
      const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
      const config = normalizeConfig(raw);
      this.loaded = { mtimeMs: stat.mtimeMs, config };
      console.log("[zalo-mentions-config-loaded]", { path: resolvedPath, groups: Object.keys(config.groups).length });
      return config;
    } catch (err: any) {
      console.warn("[zalo-mentions-config-error]", { path: resolvedPath, message: err?.message || String(err) });
      this.loaded = { mtimeMs: stat.mtimeMs, config: EMPTY_CONFIG };
      return EMPTY_CONFIG;
    }
  }
}
