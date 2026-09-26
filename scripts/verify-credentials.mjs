import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  listCredentials,
  maskKey,
  readCredential,
  removeCredential,
  resolveTypeSafeApiKey,
  writeCredential,
} from "../packages/installer/dist/index.js";

const CLI = fileURLToPath(new URL("../apps/cli/dist/index.js", import.meta.url));
const FAKE_KEY = "test-key-do-not-leak-0f3a9c";
const SAMPLE = `it("ok", () => { expect(1).toBe(1); });\n`;

await mkdir("/tmp/opencode", { recursive: true });
const BASE = await mkdtemp(join("/tmp/opencode", "skynex-credentials-"));
let counter = 0;
const workdir = async (name) => {
  const path = join(BASE, `${String(++counter).padStart(2, "0")}-${name}`);
  await mkdir(path, { recursive: true });
  return path;
};

const cases = [];
async function test(name, fn) {
  try {
    await fn();
    cases.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

/** Always clear the ambient key so cases are deterministic regardless of the shell. */
function runCli(args, { env = {}, input, cwd = BASE } = {}) {
  const childEnv = { ...process.env };
  delete childEnv.TYPESAFE_API_KEY;
  Object.assign(childEnv, env);
  const options = { cwd, env: childEnv, encoding: "utf8" };
  if (input !== undefined) options.input = input;
  const res = spawnSync(process.execPath, [CLI, ...args], options);
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { status: res.status, stdout, stderr, output: `${stdout}${stderr}` };
}

async function walkFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walkFiles(path)));
    else found.push(path);
  }
  return found;
}

async function writeSample(dir) {
  await writeFile(join(dir, "sample.spec.ts"), SAMPLE);
}

try {
  await test("store-round-trip", async () => {
    const stateRoot = join(await workdir("round-trip"), "state");
    await writeCredential(stateRoot, "typesafe", FAKE_KEY);
    assert.equal(await readCredential(stateRoot, "typesafe"), FAKE_KEY);
    const raw = JSON.parse(await readFile(join(stateRoot, "credentials.json"), "utf8"));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.credentials.typesafe.key, FAKE_KEY);
    assert.equal(typeof raw.credentials.typesafe.updatedAt, "string");
  });

  await test("store-permissions", async () => {
    const stateRoot = join(await workdir("permissions"), "nested", "state");
    await writeCredential(stateRoot, "typesafe", FAKE_KEY);
    assert.equal((await lstat(stateRoot)).mode & 0o777, 0o700, "state root directory must be 0700");
    assert.equal((await lstat(join(stateRoot, "credentials.json"))).mode & 0o777, 0o600, "credentials file must be 0600");
  });

  await test("mask-never-reveals", async () => {
    const masked = maskKey(FAKE_KEY);
    assert.equal(masked, `****${FAKE_KEY.slice(-4)}`);
    assert.notEqual(masked, FAKE_KEY);
    assert.ok(!masked.includes(FAKE_KEY), "mask must not contain the full key");
    assert.ok(masked.startsWith("****"));
    assert.equal(maskKey("abc"), "****");
    assert.ok(!maskKey("abc").includes("abc"));
  });

  await test("remove-reports-existence", async () => {
    const stateRoot = join(await workdir("remove"), "state");
    await writeCredential(stateRoot, "typesafe", FAKE_KEY);
    assert.equal(await removeCredential(stateRoot, "typesafe"), true);
    assert.equal(await readCredential(stateRoot, "typesafe"), undefined);
    assert.equal(await removeCredential(stateRoot, "typesafe"), false);
    assert.deepEqual(await listCredentials(stateRoot), []);
  });

  await test("missing-and-corrupt-are-undefined", async () => {
    const missingRoot = join(await workdir("missing"), "never-created");
    assert.equal(await readCredential(missingRoot, "typesafe"), undefined);
    const corruptRoot = join(await workdir("corrupt"), "state");
    await mkdir(corruptRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(corruptRoot, "credentials.json"), "{ not json");
    assert.equal(await readCredential(corruptRoot, "typesafe"), undefined);
    await writeFile(join(corruptRoot, "credentials.json"), JSON.stringify({ schemaVersion: 99, credentials: {} }));
    assert.equal(await readCredential(corruptRoot, "typesafe"), undefined);
  });

  await test("symlink-is-rejected", async () => {
    const stateRoot = join(await workdir("symlink"), "state");
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const victim = join(stateRoot, "..", "victim.json");
    await writeFile(victim, "ORIGINAL");
    await symlink(victim, join(stateRoot, "credentials.json"));
    await assert.rejects(() => writeCredential(stateRoot, "typesafe", FAKE_KEY), /symlink|regular file/i);
    await assert.rejects(() => readCredential(stateRoot, "typesafe"), /symlink|regular file/i);
    assert.equal(await readFile(victim, "utf8"), "ORIGINAL");
  });

  await test("integration-allowlist", async () => {
    const stateRoot = join(await workdir("allowlist"), "state");
    await assert.rejects(() => writeCredential(stateRoot, "other", FAKE_KEY), /integration/i);
    await assert.rejects(() => readCredential(stateRoot, "other"), /integration/i);
    await assert.rejects(() => removeCredential(stateRoot, "other"), /integration/i);
  });

  await test("resolution-precedence", async () => {
    assert.deepEqual(resolveTypeSafeApiKey({ env: { TYPESAFE_API_KEY: "env-key" }, stored: "store-key" }), { key: "env-key", source: "env" });
    assert.deepEqual(resolveTypeSafeApiKey({ env: {}, stored: "store-key" }), { key: "store-key", source: "store" });
    assert.deepEqual(resolveTypeSafeApiKey({ env: {} }), {});
    assert.deepEqual(resolveTypeSafeApiKey({ env: { TYPESAFE_API_KEY: "" }, stored: "store-key" }), { key: "store-key", source: "store" });
  });

  await test("cli-auth-status-empty", async () => {
    const stateRoot = join(await workdir("status-empty"), "state");
    const res = runCli(["auth", "status", "--state-dir", stateRoot]);
    assert.equal(res.status, 0, res.output);
    assert.match(res.output, /no configurada/);
  });

  await test("cli-validate-tests-missing-key", async () => {
    const dir = await workdir("missing-key");
    await writeSample(dir);
    const res = runCli([
      "validate-tests",
      "--root",
      dir,
      "--file",
      "sample.spec.ts",
      "--out",
      join(dir, "out"),
      "--state-dir",
      join(dir, "state"),
    ]);
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /missing_api_key/);
  });

  await test("no-leak", async () => {
    const dir = await workdir("no-leak");
    await writeSample(dir);
    const stateRoot = join(dir, "state");
    const setRes = runCli(["auth", "set", "typesafe", "--state-dir", stateRoot], { input: `${FAKE_KEY}\r` });
    assert.equal(setRes.status, 0, setRes.output);
    assert.ok(!setRes.output.includes(FAKE_KEY), "auth set must not print the key");
    assert.match(setRes.output, /\*{4}/);

    const out = join(dir, "out");
    const dryRun = runCli([
      "validate-tests",
      "--dry-run",
      "--root",
      dir,
      "--file",
      "sample.spec.ts",
      "--out",
      out,
      "--state-dir",
      stateRoot,
    ]);
    assert.equal(dryRun.status, 0, dryRun.output);
    assert.ok(!dryRun.output.includes(FAKE_KEY), "validate-tests must not print the key");

    const credentialPath = join(stateRoot, "credentials.json");
    const artifactHits = [];
    for (const file of await walkFiles(out)) {
      if ((await readFile(file, "utf8")).includes(FAKE_KEY)) artifactHits.push(file);
    }
    assert.deepEqual(artifactHits, [], `artifacts leaked the key: ${artifactHits.join(", ")}`);

    const strayHits = [];
    for (const file of await walkFiles(stateRoot)) {
      if (file === credentialPath) continue;
      if ((await readFile(file, "utf8")).includes(FAKE_KEY)) strayHits.push(file);
    }
    assert.deepEqual(strayHits, [], `state root leaked the key outside credentials.json: ${strayHits.join(", ")}`);
    assert.ok((await readFile(credentialPath, "utf8")).includes(FAKE_KEY), "sanity: the store itself holds the key");
  });

  await test("cli-status-masked-only", async () => {
    const dir = await workdir("status-masked");
    const stateRoot = join(dir, "state");
    const setRes = runCli(["auth", "set", "typesafe", "--state-dir", stateRoot], { input: `${FAKE_KEY}\r` });
    assert.equal(setRes.status, 0, setRes.output);
    const status = runCli(["auth", "status", "--state-dir", stateRoot]);
    assert.equal(status.status, 0, status.output);
    assert.ok(!status.output.includes(FAKE_KEY), "auth status must never print the key");
    assert.match(status.output, new RegExp(`\\*\\*\\*\\*${FAKE_KEY.slice(-4)}`));
    const remove = runCli(["auth", "remove", "typesafe", "--state-dir", stateRoot]);
    assert.equal(remove.status, 0, remove.output);
    assert.ok(!remove.output.includes(FAKE_KEY), "auth remove must never print the key");
    const second = runCli(["auth", "remove", "typesafe", "--state-dir", stateRoot]);
    assert.equal(second.status, 0, second.output);
    assert.match(second.output, /No typesafe credential was stored/);
  });

  await test("cli-surfaces-intact", async () => {
    const stateRoot = join(await workdir("surfaces"), "state");
    const validateHelp = runCli(["validate-tests", "--help"]);
    assert.equal(validateHelp.status, 0, validateHelp.output);
    assert.match(validateHelp.stdout, /Skynex test validator/);
    const generalHelp = runCli(["--help"]);
    assert.equal(generalHelp.status, 0, generalHelp.output);
    assert.match(generalHelp.stdout, /Skynex v2/);
    const authHelp = runCli(["auth", "--help"]);
    assert.equal(authHelp.status, 0, authHelp.output);
    assert.match(authHelp.stdout, /Skynex credentials/);
    const authBare = runCli(["auth"]);
    assert.equal(authBare.status, 0, authBare.output);
    assert.match(authBare.stdout, /Skynex credentials/);
    const doctor = runCli(["doctor", "--json", "--state-dir", stateRoot]);
    assert.equal(doctor.status, 0, doctor.output);
    const jsonMatch = doctor.stdout.match(/\{"ok":.*\}/);
    assert.ok(jsonMatch, `doctor --json must print a JSON object: ${doctor.stdout}`);
    assert.equal(JSON.parse(jsonMatch[0]).ok, true);
  });

  await test("cli-unknown-flag-never-leaks-value", async () => {
    const secret = "SECRETO_FICTICIO_FLAG_LEAK";
    const res = runCli(["auth", "set", "typesafe", `--key=${secret}`]);
    assert.notEqual(res.status, 0, `unknown flag must fail: ${res.output}`);
    assert.ok(!res.output.includes(secret), `unknown flag echoed the secret: ${res.output}`);
    assert.ok(res.output.includes("--key"), `error must name the flag without its value: ${res.output}`);
  });

  await test("cli-integration-position-never-leaks-value", async () => {
    // Real key shape (lowercase/digits/dashes, <= 32 chars): the old shape guard echoed exactly this.
    const secret = "sklive0123456789abcdef";
    const mismatch = "0f3a9c8b7d6e5f4a3b2c1d0e9f8a7b6c";
    const setRes = runCli(["auth", "set", secret]);
    assert.notEqual(setRes.status, 0, `unknown integration must fail: ${setRes.output}`);
    assert.ok(!setRes.output.includes(secret), `auth set echoed the supplied value: ${setRes.output}`);
    assert.match(setRes.output, /Unknown integration/);
    const removeRes = runCli(["auth", "remove", mismatch]);
    assert.notEqual(removeRes.status, 0, `unknown integration must fail: ${removeRes.output}`);
    assert.ok(!removeRes.output.includes(mismatch), `auth remove echoed the supplied value: ${removeRes.output}`);
    assert.match(removeRes.output, /Unknown integration/);
  });

  await test("cli-auth-rejects-project-scope", async () => {
    const dir = await workdir("auth-project");
    for (const sub of [["set", "typesafe"], ["status"], ["remove", "typesafe"]]) {
      const res = runCli(["auth", ...sub, "--project", dir], { input: `${FAKE_KEY}\r` });
      assert.notEqual(res.status, 0, `auth ${sub[0]} --project must fail: ${res.output}`);
      assert.ok(!res.output.includes(FAKE_KEY), `auth ${sub[0]} --project must not print the key: ${res.output}`);
      assert.match(res.output, /does not accept --project/);
    }
    await assert.rejects(() => lstat(join(dir, ".skynex", "credentials.json")), { code: "ENOENT" });
  });

  await test("cli-validate-tests-rejects-project-scope", async () => {
    const dir = await workdir("validate-tests-project");
    await writeSample(dir);
    await writeCredential(join(dir, ".skynex"), "typesafe", FAKE_KEY);
    const res = runCli([
      "validate-tests",
      "--dry-run",
      "--project",
      dir,
      "--root",
      dir,
      "--file",
      "sample.spec.ts",
      "--out",
      join(dir, "out"),
    ]);
    assert.notEqual(res.status, 0, `validate-tests --project must fail: ${res.output}`);
    assert.ok(!res.output.includes(FAKE_KEY), `validate-tests must not use project-scoped credentials: ${res.output}`);
    assert.match(res.output, /does not accept --project/);
  });

  console.log(JSON.stringify({ ok: true, cases: cases.length }));
  await rm(BASE, { recursive: true, force: true });
} catch (error) {
  console.error(`verifier failed; artifacts kept at ${BASE}`);
  throw error;
}
