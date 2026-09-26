import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  runTestValidator,
  extractTests,
  sanitize,
  buildState,
  judge,
  validateAnswers,
  JEV_MODEL,
} from "../packages/test-validator/dist/index.js";

const CLI = fileURLToPath(new URL("../apps/cli/dist/index.js", import.meta.url));
const CLI_SOURCE = fileURLToPath(new URL("../apps/cli/src/index.ts", import.meta.url));
const PKG_SRC = fileURLToPath(new URL("../packages/test-validator/src", import.meta.url));
// Versioned reference artifact: resolved relative to this script so a clean CI
// checkout never depends on the author's machine-local /tmp path.
const REFERENCE = fileURLToPath(new URL("./fixtures/test-validator/results.json", import.meta.url));
const MODEL = "jev-1.13.0";
const FAKE_KEY = "test-key-do-not-leak-0f3a9c";
// Real key shape (lowercase/digits, long): proves argv values never reach output or artifacts.
const KEY_SHAPED = "sklive0123456789abcdef0123456789abcdef";

await mkdir("/tmp/opencode", { recursive: true });
const BASE = await mkdtemp(join("/tmp/opencode", "skynex-test-validator-"));
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

function runCli(args, { env = {}, unset = [], cwd = BASE } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const key of unset) delete childEnv[key];
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv, encoding: "utf8" });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { status: res.status, stdout, stderr, output: `${stdout}${stderr}` };
}

const validAnswers = () => ({
  declared: {
    type: "choice",
    probabilities: { verifies: 0.9, partially: 0.04, different: 0.03, nothing: 0.03 },
    choice: "verifies",
    confidence: 0.9,
  },
  value: {
    type: "choice",
    probabilities: { regression: 0.9, documentation: 0.04, implementation_coupled: 0.03, trivial: 0.02, duplicate: 0.01 },
    choice: "regression",
    confidence: 0.9,
  },
  recommendation: {
    type: "choice",
    probabilities: { keep: 0.9, strengthen: 0.04, rewrite: 0.03, delete: 0.03 },
    choice: "keep",
    confidence: 0.9,
  },
  fragile_time: { type: "noul", noul: 0.05 },
  fragile_order: { type: "noul", noul: 0.05 },
  fragile_randomness: { type: "noul", noul: 0.05 },
  fragile_network: { type: "noul", noul: 0.05 },
});

async function startMock(respond) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
      const outcome = await respond(body, req);
      if (outcome === "hang") return;
      const { status = 200, json } = outcome ?? {};
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json ?? {}));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    requests,
    endpoint: `http://127.0.0.1:${port}/`,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runLive(root, files, respond, options = {}) {
  const mock = await startMock(respond);
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = FAKE_KEY;
  try {
    const out = options.out ?? (await workdir("live-out"));
    const result = await runTestValidator({
      root,
      files,
      model: MODEL,
      timeoutMs: options.timeoutMs ?? 5000,
      maxStateChars: options.maxStateChars ?? 8000,
      dryRun: false,
      out,
      endpoint: mock.endpoint,
      fetchImpl: (input, init) => globalThis.fetch(input, init),
    });
    return { result, requests: mock.requests };
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    await mock.close();
  }
}

const SAMPLE_SOURCE = `import { createUser } from "../src/user";
import { db } from "../src/db";

jest.mock("../src/db");

const makePayload = () => ({ name: "x" });

describe("user creation", () => {
  beforeEach(() => {
    db.reset();
  });

  it("rejects an invalid name", () => {
    const spy = vi.spyOn(db, "insert");
    expect(() => createUser(makePayload())).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("creates a user", () => {
    expect(createUser(makePayload())).toEqual({ id: "1" });
  });

  it("rejects a %s name", () => {
    expect(createUser(makePayload())).toBeDefined();
  });
});
`;

const writeSample = async (dir) => {
  await writeFile(join(dir, "sample.spec.ts"), SAMPLE_SOURCE);
};

const readResults = async (out) => JSON.parse(await readFile(join(out, "results.json"), "utf8"));

// Scans every artifact in `out` (when the directory exists) for a forbidden value.
const outContains = async (out, needle) => {
  let names;
  try {
    names = await readdir(out);
  } catch {
    return false;
  }
  for (const name of names) {
    if ((await readFile(join(out, name), "utf8")).includes(needle)) return true;
  }
  return false;
};

// Structure signature: sorted `path:type` entries, arrays normalized by element, values ignored.
function structureSignature(value) {
  const out = new Set();
  const visit = (node, path) => {
    if (node === null) {
      out.add(`${path.join(".")}:null`);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, [...path, "[]"]);
      return;
    }
    if (typeof node === "object") {
      for (const key of Object.keys(node).sort()) visit(node[key], [...path, key]);
      return;
    }
    out.add(`${path.join(".")}:${typeof node}`);
  };
  visit(value, []);
  return [...out].sort();
}

try {
  await test("extract-sample", async () => {
    const tests = extractTests(SAMPLE_SOURCE, "sample.spec.ts");
    assert.equal(tests.length, 3);
    const [invalid, creates, parameterized] = tests;
    assert.equal(invalid.fullName, "user creation > rejects an invalid name");
    assert.deepEqual(invalid.mocks, [{ kind: "spyOn", target: "db.insert" }]);
    assert.deepEqual(invalid.fileMocks, [{ kind: "mock", target: "../src/db" }]);
    assert.deepEqual(invalid.signals.hooks, ["beforeEach"]);
    assert.deepEqual(invalid.helpers, ["makePayload"]);
    assert.deepEqual(invalid.importsReferenced, ["createUser from ../src/user", "db from ../src/db"]);
    assert.equal(invalid.signals.asserts.expect, 2);
    assert.equal(invalid.signals.parameterized, false);
    assert.deepEqual(creates.mocks, []);
    assert.equal(parameterized.fullName, "user creation > rejects a %s name");
    assert.equal(parameterized.signals.parameterized, true);
    assert.ok(tests.every((entry) => entry.fileMocks.length === 1));
  });

  await test("cli-help", async () => {
    const res = runCli(["validate-tests", "--help"]);
    assert.equal(res.status, 0, res.output);
    assert.match(res.stdout, /Skynex test validator/);
  });

  await test("cli-dry-run", async () => {
    const dir = await workdir("dry-run");
    await writeSample(dir);
    const out = join(dir, "out");
    const res = runCli(["validate-tests", "--dry-run", "--root", dir, "--file", "sample.spec.ts", "--out", out]);
    assert.equal(res.status, 0, res.output);
    const results = await readResults(out);
    assert.equal(results.run.mode, "dry-run");
    assert.equal(results.summary.tests, 3);
    assert.ok(results.files[0].tests.every((entry) => entry.status === "extracted"));
    assert.ok(!("answers" in results.files[0].tests[0]));
    await lstat(join(out, "report.md"));
  });

  await test("cli-replay", async () => {
    const dir = await workdir("replay");
    await writeSample(dir);
    const extracted = extractTests(SAMPLE_SOURCE, "sample.spec.ts");
    const responses = Object.fromEntries(extracted.map((entry) => [entry.id, { answers: validAnswers() }]));
    const replay = join(dir, "answers.json");
    await writeFile(replay, JSON.stringify({ model: MODEL, responses }));
    const out = join(dir, "out");
    const res = runCli(["validate-tests", "--replay", replay, "--root", dir, "--file", "sample.spec.ts", "--out", out]);
    assert.equal(res.status, 0, res.output);
    const results = await readResults(out);
    assert.deepEqual(Object.keys(results), ["schemaVersion", "tool", "toolVersion", "run", "summary", "files"]);
    assert.equal(results.tool, "skynex-test-validator");
    assert.equal(results.run.mode, "replay");
    assert.equal(results.run.modelResolved, MODEL);
    assert.equal(results.summary.judged, 3);
    assert.equal(results.summary.errors, 0);
    const first = results.files[0].tests[0];
    assert.equal(first.status, "judged");
    assert.equal(first.error, null);
    assert.ok(first.answers && first.judgment);
  });

  await test("cli-replay-partial", async () => {
    const dir = await workdir("replay-partial");
    await writeSample(dir);
    const extracted = extractTests(SAMPLE_SOURCE, "sample.spec.ts");
    const responses = Object.fromEntries(extracted.slice(0, 1).map((entry) => [entry.id, { answers: validAnswers() }]));
    const replay = join(dir, "answers.json");
    await writeFile(replay, JSON.stringify({ model: MODEL, responses }));
    const out = join(dir, "out");
    const res = runCli(["validate-tests", "--replay", replay, "--root", dir, "--file", "sample.spec.ts", "--out", out]);
    assert.equal(res.status, 2, res.output);
    const results = await readResults(out);
    const missing = results.files[0].tests.filter((entry) => entry.status === "error");
    assert.equal(missing.length, 2);
    assert.ok(missing.every((entry) => entry.error.kind === "replay_missing"));
    assert.equal(results.summary.judged, 1);
  });

  await test("missing-api-key", async () => {
    const dir = await workdir("missing-key");
    await writeSample(dir);
    const res = runCli(["validate-tests", "--root", dir, "--file", "sample.spec.ts", "--out", join(dir, "out")], {
      unset: ["TYPESAFE_API_KEY"],
    });
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /missing_api_key/);
  });

  await test("model-pin", async () => {
    const dir = await workdir("model-pin");
    await writeSample(dir);
    // Real key shape (lowercase/digits/dashes, <= 32 chars): the message must not echo any --model value.
    const spoof = "sklive0123456789abcdef";
    const res = runCli(["validate-tests", "--model", spoof, "--root", dir, "--file", "sample.spec.ts", "--out", join(dir, "out")], {
      env: { TYPESAFE_API_KEY: FAKE_KEY },
    });
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /provider_model_mismatch/);
    // Fail closed at the pin gate, before any client is created (no network contact).
    assert.match(res.output, /--model is not the pinned model 'jev-1\.13\.0'; refusing to run/);
    assert.ok(!res.output.includes(spoof), `pin mismatch echoed the --model value: ${res.output}`);
  });

  await test("model-pin-dry-run", async () => {
    const dir = await workdir("model-pin-dry-run");
    await writeSample(dir);
    const out = join(dir, "out");
    const res = runCli(["validate-tests", "--dry-run", "--model", KEY_SHAPED, "--root", dir, "--file", "sample.spec.ts", "--out", out]);
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /provider_model_mismatch/);
    assert.ok(!res.output.includes(KEY_SHAPED), `dry-run pin mismatch echoed the --model value: ${res.output}`);
    assert.equal(await outContains(out, KEY_SHAPED), false, "dry-run artifacts persisted the --model value");
  });

  await test("model-pin-replay", async () => {
    const dir = await workdir("model-pin-replay");
    await writeSample(dir);
    const extracted = extractTests(SAMPLE_SOURCE, "sample.spec.ts");
    const responses = Object.fromEntries(extracted.map((entry) => [entry.id, { answers: validAnswers() }]));
    const replay = join(dir, "answers.json");
    // Replay file model deliberately matches the spoofed --model: in the vulnerable
    // code the replay load succeeds and the argv value is persisted as run.model.
    await writeFile(replay, JSON.stringify({ model: KEY_SHAPED, responses }));
    const out = join(dir, "out");
    const res = runCli(["validate-tests", "--replay", replay, "--model", KEY_SHAPED, "--root", dir, "--file", "sample.spec.ts", "--out", out]);
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /provider_model_mismatch/);
    assert.ok(!res.output.includes(KEY_SHAPED), `replay pin mismatch echoed the --model value: ${res.output}`);
    assert.equal(await outContains(out, KEY_SHAPED), false, "replay artifacts persisted the --model value");
  });

  await test("unknown-command-no-echo", async () => {
    const dir = await workdir("unknown-command");
    const env = {
      HOME: join(dir, "home"),
      XDG_CONFIG_HOME: join(dir, "xdg-config"),
      XDG_DATA_HOME: join(dir, "xdg-data"),
      XDG_STATE_HOME: join(dir, "xdg-state"),
    };
    for (const path of Object.values(env)) await mkdir(path, { recursive: true });
    const res = runCli([KEY_SHAPED, "--project", dir], { env });
    assert.notEqual(res.status, 0, res.output);
    assert.match(res.output, /Unknown command/);
    assert.ok(!res.output.includes(KEY_SHAPED), `unknown command echoed the token: ${res.output}`);
  });

  await test("provider-model-mismatch", async () => {
    const dir = await workdir("model-mismatch");
    await writeSample(dir);
    const { result } = await runLive(dir, ["sample.spec.ts"], () => ({ json: { model: "otro-modelo", answers: validAnswers() } }));
    assert.equal(result.exitCode, 2);
    const tests = result.results.files[0].tests;
    assert.ok(tests.every((entry) => entry.status === "error" && entry.error.kind === "provider_model_mismatch"));
  });

  await test("invalid-response", async () => {
    const dir = await workdir("invalid-response");
    await writeSample(dir);
    const answers = validAnswers();
    answers.declared = { type: "choice", probabilities: { verifies: 0.9 }, choice: "verifies", confidence: 0.9 };
    const { result } = await runLive(dir, ["sample.spec.ts"], () => ({ json: { model: MODEL, answers } }));
    assert.equal(result.exitCode, 2);
    const tests = result.results.files[0].tests;
    assert.ok(tests.every((entry) => entry.status === "error" && entry.error.kind === "invalid_response"));
  });

  await test("provider-timeout", async () => {
    const dir = await workdir("provider-timeout");
    await writeSample(dir);
    const { result } = await runLive(dir, ["sample.spec.ts"], () => "hang", { timeoutMs: 250 });
    assert.equal(result.exitCode, 2);
    const tests = result.results.files[0].tests;
    assert.ok(tests.every((entry) => entry.status === "error" && entry.error.kind === "provider_timeout"));
  });

  await test("live-happy-path", async () => {
    const dir = await workdir("live-happy");
    await writeSample(dir);
    const { result, requests } = await runLive(dir, ["sample.spec.ts"], () => ({ json: { model: MODEL, answers: validAnswers() } }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.results.run.modelResolved, MODEL);
    assert.equal(requests.length, 3);
    const expectedTypes = {
      declared: "choice",
      value: "choice",
      recommendation: "choice",
      fragile_time: "noul",
      fragile_order: "noul",
      fragile_randomness: "noul",
      fragile_network: "noul",
    };
    for (const request of requests) {
      assert.equal(request.body.model, MODEL);
      assert.deepEqual(Object.keys(request.body.questions), [
        "declared",
        "value",
        "fragile_time",
        "fragile_order",
        "fragile_randomness",
        "fragile_network",
        "recommendation",
      ]);
      for (const [key, type] of Object.entries(expectedTypes)) assert.equal(request.body.questions[key].type, type);
      assert.equal(typeof request.body.state, "string");
    }
  });

  await test("no-api-key-leak", async () => {
    const dir = await workdir("key-leak");
    await writeSample(dir);
    const out = join(dir, "out");
    const { result, requests } = await runLive(dir, ["sample.spec.ts"], () => ({ json: { model: MODEL, answers: validAnswers() } }), { out });
    assert.equal(result.exitCode, 0);
    assert.ok(requests.length > 0);
    assert.equal(requests[0].headers.authorization, `Bearer ${FAKE_KEY}`);
    for (const entry of await readdir(out)) {
      const text = await readFile(join(out, entry), "utf8");
      assert.ok(!text.includes(FAKE_KEY), `artifact ${entry} leaked the api key`);
    }
  });

  await test("no-tests", async () => {
    const dir = await workdir("no-tests");
    await writeFile(join(dir, "empty.spec.ts"), "export const value = 1;\n");
    const res = runCli(["validate-tests", "--dry-run", "--root", dir, "--file", "empty.spec.ts", "--out", join(dir, "out")]);
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /No tests were extracted/);
  });

  await test("broken-file", async () => {
    const dir = await workdir("broken-file");
    await writeFile(join(dir, "good.spec.ts"), `it("ok", () => { expect(1).toBe(1); });\n`);
    await writeFile(join(dir, "broken.spec.ts"), `it("broken", () => { expect(1).toBe(\n`);
    const partial = runCli([
      "validate-tests",
      "--dry-run",
      "--root",
      dir,
      "--file",
      "good.spec.ts",
      "--file",
      "broken.spec.ts",
      "--out",
      join(dir, "out-partial"),
    ]);
    assert.equal(partial.status, 2, partial.output);
    const partialResults = await readResults(join(dir, "out-partial"));
    const errorFile = partialResults.files.find((entry) => entry.status === "error");
    assert.ok(errorFile && errorFile.error.kind === "parse_error");
    assert.equal(partialResults.files.filter((entry) => entry.status === "ok").length, 1);
    const all = runCli(["validate-tests", "--dry-run", "--root", dir, "--file", "broken.spec.ts", "--out", join(dir, "out-all")]);
    assert.equal(all.status, 1, all.output);
    const allResults = await readResults(join(dir, "out-all"));
    assert.equal(allResults.files.length, 1);
    assert.equal(allResults.files[0].status, "error");
  });

  await test("file-mocks", async () => {
    const tests = extractTests(
      `vi.mock("./outer");
it("with in-test mock", () => { vi.mock("./inner"); expect(1).toBe(1); });
it("plain", () => { expect(2).toBe(2); });
`,
      "mocks.spec.ts",
    );
    assert.equal(tests.length, 2);
    const outer = [{ kind: "mock", target: "./outer" }];
    assert.deepEqual(tests[0].fileMocks, outer);
    assert.deepEqual(tests[1].fileMocks, outer);
    assert.deepEqual(tests[0].mocks, [{ kind: "mock", target: "./inner" }]);
    assert.deepEqual(tests[1].mocks, []);
  });

  await test("hook-order", async () => {
    const tests = extractTests(
      `describe("hooks", () => {
  it("runs", () => { expect(1).toBe(1); });
  afterEach(() => { cleanup(); });
  beforeEach(() => { setup(); });
});
`,
      "hooks.spec.ts",
    );
    assert.equal(tests.length, 1);
    assert.deepEqual(tests[0].signals.hooks, ["afterEach", "beforeEach"]);
  });

  await test("mock-heavy", async () => {
    const dir = await workdir("mock-heavy");
    await writeFile(
      join(dir, "mocks.spec.ts"),
      `vi.mock("./a");
it("heavy", () => { vi.mock("./b"); expect(1).toBe(1); });
it("light", () => { expect(2).toBe(2); });
`,
    );
    const res = runCli(["validate-tests", "--dry-run", "--root", dir, "--file", "mocks.spec.ts", "--out", join(dir, "out")]);
    assert.equal(res.status, 0, res.output);
    const results = await readResults(join(dir, "out"));
    assert.equal(results.summary.mechanical.mockHeavy, 1);
  });

  await test("state-cap", async () => {
    const dir = await workdir("state-cap");
    const importPath = "./" + "a".repeat(2800);
    await writeFile(join(dir, "big.spec.ts"), `import { thing } from "${importPath}";\nit("uses thing", () => { expect(thing).toBeDefined(); });\n`);
    const res = runCli([
      "validate-tests",
      "--dry-run",
      "--max-state-chars",
      "1000",
      "--root",
      dir,
      "--file",
      "big.spec.ts",
      "--out",
      join(dir, "out"),
    ]);
    assert.equal(res.status, 2, res.output);
    const results = await readResults(join(dir, "out"));
    const entry = results.files[0].tests[0];
    assert.equal(entry.status, "error");
    assert.equal(entry.error.kind, "state_too_large");
    assert.ok(entry.stateChars > 1000, `stateChars ${entry.stateChars} should exceed 1000`);
    assert.match(entry.error.message, /fail closed/);
  });

  await test("code-retention", async () => {
    const code = `HEAD_SENTINEL${"A".repeat(80)}MIDDLE_MARKER${"B".repeat(20000)}TAIL_SENTINEL`;
    const outcome = buildState(
      {
        file: "retention.spec.ts",
        fullName: "retains",
        intent: "retains",
        intentSource: "inferred",
        code,
        hooks: [],
        helpers: [],
        importsReferenced: [],
        siblings: [],
      },
      1000,
    );
    assert.equal(outcome.tooLarge, false);
    assert.equal(outcome.truncated, true);
    assert.equal(outcome.stateFlags.codeTruncated, true);
    const codeStart = outcome.state.indexOf("code:\n") + "code:\n".length;
    const portion = outcome.state.slice(codeStart);
    const marker = /\n\.\.\. \[truncated (\d+) chars\] \.\.\.\n/.exec(portion);
    assert.ok(marker, "expected a truncation marker in the code section");
    const head = portion.slice(0, marker.index);
    const tail = portion.slice(marker.index + marker[0].length);
    const keep = head.length + tail.length;
    const removed = Number(marker[1]);
    assert.equal(removed, code.length - keep);
    assert.equal(head, code.slice(0, head.length));
    assert.equal(tail, code.slice(code.length - tail.length));
    assert.equal(head.length, Math.floor((keep * 2) / 3));
    assert.equal(tail.length, keep - Math.floor((keep * 2) / 3));
    assert.ok(head.startsWith("HEAD_SENTINEL"));
    assert.ok(tail.endsWith("TAIL_SENTINEL"));
    assert.ok(keep > 0 && keep < code.length);
  });

  await test("sanitize", async () => {
    const raw = "a\nb\rc\u2028d\u2029e\u0085f`g\u001b[31m";
    const clean = sanitize(raw);
    assert.ok(!/[\n\r\u2028\u2029\u0085]/.test(clean));
    assert.ok(!clean.includes("`"));
    assert.ok(!clean.includes("\u001b"));
    assert.ok(clean.includes("\\n"));
    assert.ok(clean.includes("f'g"));
    assert.ok(clean.includes("[31m"));

    const dir = await workdir("sanitize");
    const literal = '"a`b\\nc\\u2028d\\u2029e\\u0085f\\u001b[31m"';
    const source = `it(${literal}, () => { expect(1).toBe(1); });\n`;
    await writeFile(join(dir, "weird.spec.ts"), source);
    const id = extractTests(source, "weird.spec.ts")[0].id;
    assert.ok(id.includes("a`b"));
    const replay = join(dir, "answers.json");
    await writeFile(replay, JSON.stringify({ model: MODEL, responses: { [id]: { answers: validAnswers() } } }));
    const out = join(dir, "out");
    const res = runCli(["validate-tests", "--replay", replay, "--root", dir, "--file", "weird.spec.ts", "--out", out]);
    assert.equal(res.status, 0, res.output);
    const report = await readFile(join(out, "report.md"), "utf8");
    assert.ok(!report.includes("a`b"), "raw backtick in the test name must be neutralized");
    assert.ok(!/[\u2028\u2029\u0085]/.test(report));
    assert.ok(!report.includes("\u001b"));
    assert.ok(report.includes("weird.spec.ts::a'b"));
    assert.ok(report.includes("a'b\\nc\\nd\\ne\\nf[31m"));
  });

  await test("out-perms", async () => {
    const dir = await workdir("out-perms");
    await writeSample(dir);
    const out = join(dir, "artifacts");
    const res = runCli(["validate-tests", "--dry-run", "--root", dir, "--file", "sample.spec.ts", "--out", out]);
    assert.equal(res.status, 0, res.output);
    assert.equal((await lstat(out)).mode & 0o777, 0o700);
    for (const name of ["results.json", "report.md"]) {
      assert.equal((await lstat(join(out, name))).mode & 0o777, 0o600, `${name} should be 0600`);
    }
  });

  await test("out-symlink", async () => {
    const dir = await workdir("out-symlink");
    await writeSample(dir);
    const victim = join(dir, "victim");
    await mkdir(victim);
    const link = join(dir, "link");
    await symlink(victim, link);
    const res = runCli(["validate-tests", "--dry-run", "--root", dir, "--file", "sample.spec.ts", "--out", link]);
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /symlink/i);
    assert.deepEqual(await readdir(victim), []);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  });

  await test("atomic-write", async () => {
    const dir = await workdir("atomic-write");
    await writeSample(dir);
    const out = join(dir, "out");
    await mkdir(out);
    const victim = join(dir, "victim.json");
    await writeFile(victim, "ORIGINAL");
    await symlink(victim, join(out, "results.json"));
    await symlink(victim, join(out, "report.md"));
    const res = runCli(["validate-tests", "--dry-run", "--root", dir, "--file", "sample.spec.ts", "--out", out]);
    assert.equal(res.status, 0, res.output);
    assert.equal(await readFile(victim, "utf8"), "ORIGINAL");
    assert.equal((await lstat(join(out, "results.json"))).isSymbolicLink(), false);
    assert.equal((await lstat(join(out, "report.md"))).isSymbolicLink(), false);
    const results = await readResults(out);
    assert.equal(results.tool, "skynex-test-validator");
  });

  await test("static-no-exec", async () => {
    const forbidden = /child_process|eval\s*\(|new\s+Function|import\s*\(|require\s*\(/;
    const files = (await readdir(PKG_SRC)).filter((name) => name.endsWith(".ts"));
    assert.ok(files.length > 0);
    for (const name of files) {
      assert.doesNotMatch(await readFile(join(PKG_SRC, name), "utf8"), forbidden, `forbidden execution in packages/test-validator/src/${name}`);
    }
    const cliSource = await readFile(CLI_SOURCE, "utf8");
    assert.doesNotMatch(cliSource, forbidden, "forbidden execution in apps/cli/src/index.ts");
  });

  await test("report-structure", async () => {
    const dir = await workdir("report-structure");
    await writeSample(dir);
    const res = runCli(["validate-tests", "--dry-run", "--root", dir, "--file", "sample.spec.ts", "--out", join(dir, "out")]);
    assert.equal(res.status, 0, res.output);
    const report = await readFile(join(dir, "out", "report.md"), "utf8");
    const headers = [
      "# Triaje semántico de tests",
      "## Resumen por acción",
      "## Alta confianza",
      "### Mantener",
      "### Reforzar",
      "### Reescribir",
      "### Borrar",
      "## Revisar a mano",
      "## Señales mecánicas",
      "## Errores",
    ];
    let previous = -1;
    for (const header of headers) {
      const index = report.indexOf(header);
      assert.ok(index > previous, `expected header in order: ${header}`);
      previous = index;
    }
  });

  await test("snapshot-signals", async () => {
    const source = `it("snap", () => {
  expect({ a: 1 }).toMatchSnapshot();
  expect({ b: 2 }).toMatchInlineSnapshot("{ b: 2 }");
});
it("plain", () => { expect(1).toBe(1); });
`;
    const extracted = extractTests(source, "snap.spec.ts");
    assert.equal(extracted.length, 2);
    assert.equal(extracted[0].signals.snapshots, 2, "expect(...).toMatchSnapshot()/toMatchInlineSnapshot() must count");
    assert.equal(extracted[1].signals.snapshots, 0);

    const dir = await workdir("snapshot-signals");
    await writeFile(join(dir, "snap.spec.ts"), source);
    const responses = Object.fromEntries(extracted.map((entry) => [entry.id, { answers: validAnswers() }]));
    const replay = join(dir, "answers.json");
    await writeFile(replay, JSON.stringify({ model: MODEL, responses }));
    const out = join(dir, "out");
    const res = runCli(["validate-tests", "--replay", replay, "--root", dir, "--file", "snap.spec.ts", "--out", out]);
    assert.equal(res.status, 0, res.output);
    const results = await readResults(out);
    assert.equal(results.summary.mechanical.snapshots, 1);
  });

  await test("noul-boundary", async () => {
    const judgedAt = (noul) => {
      const raw = validAnswers();
      raw.fragile_network = { type: "noul", noul };
      const validated = validateAnswers(raw);
      assert.equal(validated.ok, true, `valid answers expected at noul=${noul}`);
      return judge(validated.answers);
    };
    assert.equal(judgedAt(0.3).fragility.fragile_network.flag, "not_fragile", "0.30 is the inclusive lower boundary");
    assert.equal(judgedAt(0.31).fragility.fragile_network.flag, "uncertain");
    assert.equal(judgedAt(0.5).fragility.fragile_network.flag, "fragile");
  });

  await test("schema", async () => {
    const dir = await workdir("schema");
    const source = `import { createUser } from "../src/user";
import { db } from "../src/db";

jest.mock("../src/db");

function makePayload() {
  return { name: "x" };
}

describe("shape", () => {
  beforeEach(() => {
    db.reset();
  });

  it("covers everything", () => {
    const spy = vi.spyOn(db, "insert");
    expect(createUser(makePayload())).toEqual({});
    expect(spy).toHaveBeenCalled();
  });
});
`;
    await writeFile(join(dir, "shape.spec.ts"), source);
    const id = extractTests(source, "shape.spec.ts")[0].id;
    const replay = join(dir, "answers.json");
    await writeFile(replay, JSON.stringify({ model: MODEL, responses: { [id]: { answers: validAnswers() } } }));
    const out = join(dir, "out");
    const res = runCli(["validate-tests", "--replay", replay, "--root", dir, "--file", "shape.spec.ts", "--out", out]);
    assert.equal(res.status, 0, res.output);
    const mine = await readResults(out);
    const reference = JSON.parse(await readFile(REFERENCE, "utf8"));
    assert.deepEqual(structureSignature(mine), structureSignature(reference));
  });

  // Last: this case records the known twin identity contract and keeps prior evidence intact.
  await test("sibling-tests", async () => {
    const dir = await workdir("siblings");
    await writeFile(
      join(dir, "twins.spec.ts"),
      `describe("dup", () => {
  it("same name", () => { expect(1).toBe(1); });
  it("same name", () => { expect(2).toBe(2); });
});
`,
    );
    const { result, requests } = await runLive(dir, ["twins.spec.ts"], () => ({ json: { model: MODEL, answers: validAnswers() } }));
    assert.equal(result.exitCode, 0);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const section = /sibling_tests:\n((?:- .*\n?)+)/.exec(request.body.state);
      assert.ok(section, "expected each twin to see the other in sibling_tests");
      assert.match(section[1], /- dup > same name/);
    }
  });

  console.log(JSON.stringify({ ok: true, cases: cases.length }));
  await rm(BASE, { recursive: true, force: true });
} catch (error) {
  console.error(`verifier failed; artifacts kept at ${BASE}`);
  throw error;
}
