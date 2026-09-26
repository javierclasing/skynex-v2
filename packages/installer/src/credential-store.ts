import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { assertSafeRoot, validateManagedPath } from "./path-policy.js";
import { syncDirectory } from "./fs-sync.js";

/**
 * Skynex-owned credential store. Secrets live only in the global state root
 * (`~/.config/skynex`) and never in the repository, the OpenCode store or logs.
 */
export const CREDENTIALS_FILE = "credentials.json";
export const CREDENTIALS_SCHEMA_VERSION = 1 as const;
/** Only integrations the CLI is allowed to persist a secret for. */
export const ALLOWED_INTEGRATIONS = ["typesafe"] as const;
export type IntegrationId = (typeof ALLOWED_INTEGRATIONS)[number];

export interface CredentialSummary {
  integrationId: string;
  updatedAt: string;
  /** Masked key: never the full secret. */
  masked: string;
}

interface StoredCredential {
  key: string;
  updatedAt: string;
}

interface CredentialsFile {
  schemaVersion: typeof CREDENTIALS_SCHEMA_VERSION;
  credentials: Record<string, StoredCredential>;
}

/**
 * Reject any integration id outside the allowlist.
 *
 * The message is intentionally fixed and NEVER echoes the received value: an
 * unknown positional argument is most likely a mis-pasted secret, and any echo
 * would land in stderr, shell history and CI logs. Shape heuristics (e.g. "looks
 * like an id") are not a safe gate, because a real API key can itself be
 * lowercase/digits/dashes.
 */
export const assertAllowedIntegration = (integrationId: string): IntegrationId => {
  if (!(ALLOWED_INTEGRATIONS as readonly string[]).includes(integrationId)) {
    throw new Error(`Unknown integration; allowed integrations: ${ALLOWED_INTEGRATIONS.join(", ")}`);
  }
  return integrationId as IntegrationId;
};

/** Show only the last four characters; short secrets are fully hidden. */
export const maskKey = (key: string): string => (key.length <= 4 ? "****" : `****${key.slice(-4)}`);

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const credentialsPath = (stateRoot: string): string => validateManagedPath(stateRoot, CREDENTIALS_FILE);

const ensureStateDirectory = async (stateRoot: string): Promise<void> => {
  await assertSafeRoot(stateRoot);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await assertSafeRoot(stateRoot);
  await syncDirectory(dirname(stateRoot));
};

/** Refuse to follow a symlink (or non-file) sitting at credentials.json. */
const rejectUnsafeTarget = async (path: string): Promise<void> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe credentials file: ${path} is not a regular file`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
};

const atomicWrite = async (path: string, contents: string): Promise<void> => {
  const temporary = `${path}.skynex-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** Parse the store; missing, symlinked (unsafe) and corrupt files are handled by callers. */
const readFileValue = async (stateRoot: string): Promise<CredentialsFile | undefined> => {
  const path = credentialsPath(stateRoot);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe credentials file: ${path} is not a regular file`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return undefined;
    const file = value as { schemaVersion?: unknown; credentials?: unknown };
    if (file.schemaVersion !== CREDENTIALS_SCHEMA_VERSION) return undefined;
    if (!file.credentials || typeof file.credentials !== "object" || Array.isArray(file.credentials)) return undefined;
    const credentials: Record<string, StoredCredential> = {};
    for (const [id, entry] of Object.entries(file.credentials as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") return undefined;
      const candidate = entry as { key?: unknown; updatedAt?: unknown };
      if (typeof candidate.key !== "string" || typeof candidate.updatedAt !== "string") return undefined;
      credentials[id] = { key: candidate.key, updatedAt: candidate.updatedAt };
    }
    return { schemaVersion: CREDENTIALS_SCHEMA_VERSION, credentials };
  } catch {
    return undefined;
  }
};

/** Read a stored secret. Missing or corrupt store resolves to `undefined`. */
export const readCredential = async (stateRoot: string, integrationId: string): Promise<string | undefined> => {
  const id = assertAllowedIntegration(integrationId);
  await assertSafeRoot(stateRoot);
  const file = await readFileValue(stateRoot);
  return file?.credentials[id]?.key;
};

/** Store a secret atomically (0600 file, 0700 directory). Refuses symlinks. */
export const writeCredential = async (stateRoot: string, integrationId: string, key: string): Promise<void> => {
  const id = assertAllowedIntegration(integrationId);
  if (typeof key !== "string" || key.trim().length === 0) throw new Error("Refusing to store an empty credential");
  const secret = key.trim();
  await ensureStateDirectory(stateRoot);
  const path = credentialsPath(stateRoot);
  await rejectUnsafeTarget(path);
  const file = await readFileValue(stateRoot);
  const credentials = { ...(file?.credentials ?? {}), [id]: { key: secret, updatedAt: new Date().toISOString() } };
  await atomicWrite(path, `${JSON.stringify({ schemaVersion: CREDENTIALS_SCHEMA_VERSION, credentials }, null, 2)}\n`);
};

/** Remove a stored secret. Returns whether one existed. */
export const removeCredential = async (stateRoot: string, integrationId: string): Promise<boolean> => {
  const id = assertAllowedIntegration(integrationId);
  await assertSafeRoot(stateRoot);
  const path = credentialsPath(stateRoot);
  const file = await readFileValue(stateRoot);
  if (!file || file.credentials[id] === undefined) return false;
  delete file.credentials[id];
  await rejectUnsafeTarget(path);
  await atomicWrite(path, `${JSON.stringify({ schemaVersion: CREDENTIALS_SCHEMA_VERSION, credentials: file.credentials }, null, 2)}\n`);
  return true;
};

/** List stored integrations without ever exposing the raw secret. */
export const listCredentials = async (stateRoot: string): Promise<CredentialSummary[]> => {
  await assertSafeRoot(stateRoot);
  const file = await readFileValue(stateRoot);
  if (!file) return [];
  return Object.entries(file.credentials)
    .map(([integrationId, entry]) => ({ integrationId, updatedAt: entry.updatedAt, masked: maskKey(entry.key) }))
    .sort((left, right) => left.integrationId.localeCompare(right.integrationId));
};

export interface ApiKeyResolution {
  key?: string;
  source?: "env" | "store";
}

/**
 * Pure precedence resolver, testable without touching disk or the network:
 * `TYPESAFE_API_KEY` (env) wins, then the stored credential, otherwise nothing.
 */
export const resolveTypeSafeApiKey = (input: { env: Record<string, string | undefined>; stored?: string }): ApiKeyResolution => {
  const fromEnv = input.env.TYPESAFE_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return { key: fromEnv, source: "env" };
  if (typeof input.stored === "string" && input.stored.length > 0) return { key: input.stored, source: "store" };
  return {};
};
