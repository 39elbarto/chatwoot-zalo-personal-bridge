import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

type CookieLike = Record<string, any>;

function stripOuterQuotes(value: string | undefined): string | undefined {
  if (!value) return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function requireString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is missing.`);
  return value;
}

async function upsertEnvFile(envPath: string, updates: Record<string, string>) {
  let raw = "";
  try {
    raw = await fs.promises.readFile(envPath, "utf8");
  } catch {
    raw = "";
  }

  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  await fs.promises.writeFile(envPath, nextLines.join("\n"), "utf8");
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  ts-node scripts/import-browser-session.ts --cookies /path/to/cookies.json [--user-agent \"...\"] [--imei \"...\"] [--language vi]",
      "",
      "Accepted cookie JSON shapes:",
      "  - raw array of cookies",
      "  - { cookies: [...] }",
      "",
      "The script updates both ./data/session.json and ./.env.",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) usage();
    out[arg.slice(2)] = next;
    i += 1;
  }
  if (!out.cookies) usage();
  return out;
}

function normalizeCookie(cookie: CookieLike) {
  const key = cookie.key || cookie.name;
  const value = cookie.value;
  if (!key || typeof value !== "string") return null;

  const normalized: Record<string, any> = {
    key,
    value,
    domain: cookie.domain,
    path: cookie.path || "/",
  };

  if (typeof cookie.secure === "boolean") normalized.secure = cookie.secure;
  if (typeof cookie.httpOnly === "boolean") normalized.httpOnly = cookie.httpOnly;
  if (typeof cookie.hostOnly === "boolean") normalized.hostOnly = cookie.hostOnly;
  if (typeof cookie.sameSite === "string") normalized.sameSite = cookie.sameSite;
  if (typeof cookie.maxAge === "number") normalized.maxAge = cookie.maxAge;
  if (typeof cookie.expirationDate === "number") normalized.expires = new Date(cookie.expirationDate * 1000).toISOString();
  if (typeof cookie.expires === "string" || typeof cookie.expires === "number") normalized.expires = cookie.expires;
  if (cookie.creation) normalized.creation = cookie.creation;
  if (cookie.lastAccessed) normalized.lastAccessed = cookie.lastAccessed;

  return normalized;
}

async function loadCookies(cookiePath: string) {
  const raw = await fs.promises.readFile(cookiePath, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid cookie JSON in ${cookiePath}: ${(err as Error).message}`);
  }

  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : null;
  if (!source) {
    throw new Error("Unsupported cookie JSON format. Expected an array or { cookies: [...] }");
  }

  const normalized = source
    .map((cookie: CookieLike) => normalizeCookie(cookie))
    .filter((cookie: Record<string, any> | null): cookie is Record<string, any> => !!cookie);

  if (normalized.length === 0) {
    throw new Error("No usable cookies found in input JSON");
  }

  return normalized;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookies = await loadCookies(path.resolve(args.cookies));

  const language = args.language || process.env.ZALO_LANGUAGE || "vi";
  const imei = requireString(args.imei || process.env.ZALO_IMEI, "IMEI. Pass --imei or set ZALO_IMEI first");
  const userAgent = requireString(
    args["user-agent"] || stripOuterQuotes(process.env.ZALO_USER_AGENT),
    "User-Agent. Pass --user-agent or set ZALO_USER_AGENT first",
  );
  const sessionFile = stripOuterQuotes(process.env.ZALO_SESSION_FILE) || "./data/session.json";

  const sessionPath = path.resolve(sessionFile);
  await fs.promises.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.promises.writeFile(
    sessionPath,
    JSON.stringify(
      {
        imei,
        userAgent,
        language,
        cookie: cookies,
      },
      null,
      2,
    ),
    "utf8",
  );

  const envPath = path.resolve(process.cwd(), ".env");
  const quotedUA = `"${userAgent.replace(/"/g, '\\"')}"`;
  await upsertEnvFile(envPath, {
    ZALO_IMEI: imei,
    ZALO_USER_AGENT: quotedUA,
    ZALO_LANGUAGE: language,
    ZALO_COOKIE_JSON: JSON.stringify(cookies),
    ZALO_SESSION_FILE: sessionFile,
  });

  const keys = new Set(cookies.map((cookie: Record<string, any>) => cookie.key));
  console.log("[import:browser-session] Imported cookies:", cookies.length);
  console.log("[import:browser-session] Cookie keys:", Array.from(keys).sort().join(", "));
  console.log("[import:browser-session] Saved session:", sessionPath);
  console.log("[import:browser-session] Updated env:", envPath);
}

main().catch((err) => {
  console.error("[import:browser-session] Failed:", err);
  process.exit(1);
});
