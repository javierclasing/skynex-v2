import { glob, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { defaultOutDir, writeArtifacts } from "./artifacts.js";
import { extractTests } from "./extract.js";
import { createJevClient, JEV_MODEL, JevError, resolveApiKeyFromEnv, type JevClient } from "./jev.js";
import { judge, validateAnswers } from "./judge.js";
import { loadIntents, loadReplay, type ReplaySet } from "./replay.js";
import { buildState } from "./state.js";
import type {
  ActionCounts,
  ExtractedTest,
  FileResult,
  FileResultError,
  IntentSource,
  MechanicalCounts,
  ResultTest,
  ResultTestBase,
  ResultsFile,
  RunMode,
  RunOptions,
} from "./types.js";

const DEFAULT_GLOBS = ["**/*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs}"];
const EXCLUDED_PATTERNS = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/build/**", "**/coverage/**"];
const TOOL_NAME = "skynex-test-validator" as const;
const TOOL_VERSION = "0.1.0";

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(Math.max(value, minimum), maximum);

const resolveFiles = async (options: RunOptions, root: string): Promise<string[]> => {
  const files = new Set<string>();
  for (const file of options.files ?? []) files.add(resolve(root, file));

  const patterns = [...(options.globs ?? [])];
  if (files.size === 0 && patterns.length === 0) patterns.push(...DEFAULT_GLOBS);

  for (const pattern of patterns) {
    for await (const match of glob(pattern, { cwd: root, exclude: EXCLUDED_PATTERNS })) {
      files.add(resolve(root, match));
    }
  }
  return [...files].sort();
};

interface IntentResolution {
  intent: string;
  intentSource: IntentSource;
}

const resolveIntent = (test: ExtractedTest, intents: Map<string, string> | null, given: string | undefined): IntentResolution => {
  if (intents) {
    const mapped = intents.get(test.id) ?? intents.get(test.fullName) ?? intents.get(test.file);
    if (mapped !== undefined) return { intent: mapped, intentSource: "map" };
  }
  if (given !== undefined) return { intent: given, intentSource: "given" };
  return { intent: test.fullName, intentSource: "inferred" };
};

interface BuildContext {
  mode: RunMode;
  model: string;
  maxStateChars: number;
  intents: Map<string, string> | null;
  givenIntent: string | undefined;
  replay: ReplaySet | null;
  client: JevClient | null;
}

interface BuiltTest {
  result: ResultTest;
  consumedModel: string | undefined;
}

const buildTest = async (test: ExtractedTest, siblings: string[], context: BuildContext): Promise<BuiltTest> => {
  const { intent, intentSource } = resolveIntent(test, context.intents, context.givenIntent);
  const state = buildState(
    {
      file: test.file,
      fullName: test.fullName,
      intent,
      intentSource,
      code: test.code,
      hooks: test.hooks,
      helpers: test.helpers,
      importsReferenced: test.importsReferenced,
      siblings,
    },
    context.maxStateChars,
  );

  const base: ResultTestBase = {
    id: test.id,
    file: test.file,
    line: test.line,
    fullName: test.fullName,
    intent,
    intentSource,
    signals: test.signals,
    stateChars: state.stateChars,
    truncated: state.truncated,
    stateFlags: state.stateFlags,
  };

  if (state.tooLarge) {
    return {
      result: {
        ...base,
        status: "error",
        error: {
          kind: "state_too_large",
          message: `state of ${state.stateChars} chars exceeds --max-state-chars ${context.maxStateChars}; no request was sent (fail closed)`,
        },
      },
      consumedModel: undefined,
    };
  }

  if (context.mode === "live") {
    const client = context.client;
    if (client === null) {
      return {
        result: { ...base, status: "error", error: { kind: "provider_error", message: "live mode is missing its provider client" } },
        consumedModel: undefined,
      };
    }
    try {
      const live = await client.judge(state.state);
      const validation = validateAnswers(live.answers);
      if (!validation.ok) {
        return {
          result: { ...base, status: "error", error: { kind: "invalid_response", message: validation.message } },
          consumedModel: live.model,
        };
      }
      return {
        result: {
          ...base,
          status: "judged",
          answers: validation.answers,
          judgment: judge(validation.answers),
          error: null,
        },
        consumedModel: live.model,
      };
    } catch (error) {
      const kind = error instanceof JevError ? error.kind : "provider_error";
      const message = error instanceof Error ? error.message : String(error);
      return { result: { ...base, status: "error", error: { kind, message } }, consumedModel: undefined };
    }
  }

  if (context.mode === "dry-run" || context.replay === null) {
    return { result: { ...base, status: "extracted" }, consumedModel: undefined };
  }

  const response = context.replay.responses.get(test.id);
  if (!response) {
    return {
      result: {
        ...base,
        status: "error",
        error: { kind: "replay_missing", message: `no replay answers for test '${test.id}'` },
      },
      consumedModel: undefined,
    };
  }

  const validation = validateAnswers(response.answers);
  if (!validation.ok) {
    return {
      result: {
        ...base,
        status: "error",
        error: { kind: "invalid_response", message: validation.message },
      },
      consumedModel: undefined,
    };
  }

  return {
    result: {
      ...base,
      status: "judged",
      answers: validation.answers,
      judgment: judge(validation.answers),
      error: null,
    },
    consumedModel: response.model ?? context.replay.model,
  };
};

const parseErrorDetails = (error: unknown): { message: string; line: number | undefined } => {
  const message = error instanceof Error ? error.message : String(error);
  const loc = (error as { loc?: { line?: unknown } } | null)?.loc;
  const line = loc && typeof loc.line === "number" ? loc.line : undefined;
  return { message, line };
};

const toFileError = (kind: string, message: string, line: number | undefined): FileResultError => {
  return line === undefined ? { kind, message } : { kind, message, line };
};

/**
 * Runs the validator in offline mode: `dry-run` (extraction only) or `replay`
 * (judging against a saved answer set). Live/network mode is out of scope here.
 */
export const runTestValidator = async (
  options: RunOptions,
): Promise<{ exitCode: number; outDir: string; results: ResultsFile }> => {
  const startedAt = new Date();
  const root = resolve(options.root);
  const outDir = resolve(options.out ?? defaultOutDir());
  // `--model` is unvalidated argv and may be a secret. The pin is enforced before
  // branching on mode so every mode (`--dry-run`, `--replay`, live) fails closed
  // on a mismatch, and `run.model` is always the pinned constant, never argv.
  if (options.model !== JEV_MODEL) {
    // Never echo the received --model value: it is unvalidated argv and may be a secret.
    throw new JevError("provider_model_mismatch", `provider_model_mismatch: --model is not the pinned model '${JEV_MODEL}'; refusing to run`, true);
  }
  const model = JEV_MODEL;
  const maxStateChars = clamp(options.maxStateChars, 1000, 40000);
  const timeoutMs = clamp(options.timeoutMs, 250, 60000);

  if (options.replayPath && options.dryRun) throw new Error("--replay and --dry-run are mutually exclusive");
  let mode: RunMode;
  let replay: ReplaySet | null = null;
  let client: JevClient | null = null;
  if (options.replayPath) {
    mode = "replay";
    replay = await loadReplay(options.replayPath, model);
  } else if (options.dryRun) {
    mode = "dry-run";
  } else {
    mode = "live";
    const apiKey = options.apiKey ?? resolveApiKeyFromEnv();
    if (apiKey === undefined) {
      throw new JevError("missing_api_key", "missing_api_key: TYPESAFE_API_KEY is not set and no stored credential was found; export it, run 'skynex auth set typesafe', or use --dry-run/--replay", true);
    }
    client = createJevClient({ apiKey, timeoutMs, endpoint: options.endpoint, fetchImpl: options.fetchImpl });
  }

  const intents = options.intentsPath ? await loadIntents(options.intentsPath) : null;
  const files = await resolveFiles(options, root);
  if (files.length === 0) throw new Error("No test files matched the requested --file/--glob patterns");

  const testFilter = options.testFilter;
  const context: BuildContext = {
    mode,
    model,
    maxStateChars,
    intents,
    givenIntent: options.intent,
    replay,
    client,
  };

  const fileResults: FileResult[] = [];
  let modelResolved: string | null = null;

  for (const absolute of files) {
    const file = relative(root, absolute);
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fileResults.push({ path: file, status: "error", error: toFileError("read_error", message, undefined), tests: [] });
      continue;
    }
    let extracted: ExtractedTest[];
    try {
      extracted = extractTests(source, file);
    } catch (error) {
      const { message, line } = parseErrorDetails(error);
      fileResults.push({ path: file, status: "error", error: toFileError("parse_error", message, line), tests: [] });
      continue;
    }
    const filtered = testFilter ? extracted.filter((test) => test.fullName.includes(testFilter)) : extracted;
    const tests: ResultTest[] = [];
    for (let index = 0; index < filtered.length; index += 1) {
      const test = filtered[index]!;
      // Siblings are chosen by identity (position) so that twins sharing the
      // same `fullName` still see each other; only the test itself is excluded.
      const siblings = filtered
        .filter((_, other) => other !== index)
        .map((sibling) => sibling.fullName)
        .slice(0, 30);
      const built = await buildTest(test, siblings, context);
      if (built.consumedModel && modelResolved === null) modelResolved = built.consumedModel;
      tests.push(built.result);
    }
    fileResults.push({ path: file, status: "ok", error: null, tests });
  }

  const allTests = fileResults.flatMap((file) => file.tests);
  const allErrored = fileResults.length > 0 && fileResults.every((file) => file.status === "error");
  if (allTests.length === 0 && !allErrored) throw new Error("No tests were extracted from the matched files");

  const mechanical: MechanicalCounts = {
    only: allTests.filter((test) => test.signals.only).length,
    skip: allTests.filter((test) => test.signals.skip).length,
    noAsserts: allTests.filter((test) => test.signals.asserts.total === 0).length,
    snapshots: allTests.filter((test) => test.signals.snapshots > 0).length,
    mockHeavy: allTests.filter((test) => test.signals.mocks.length + test.signals.fileMocks.length >= 2).length,
  };

  const judgedTests = allTests.filter((test) => test.status === "judged");
  const byAction: ActionCounts = { keep: 0, strengthen: 0, rewrite: 0, delete: 0 };
  for (const test of judgedTests) {
    const action = test.judgment.recommendation.action;
    if (action === "keep" || action === "strengthen" || action === "rewrite" || action === "delete") byAction[action] += 1;
  }
  const testErrors = allTests.filter((test) => test.status === "error").length;
  const fileErrors = fileResults.filter((file) => file.status === "error").length;

  const results: ResultsFile = {
    schemaVersion: 1,
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    run: {
      mode,
      model,
      modelResolved,
      root,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      maxStateChars,
      timeoutMs,
      outDir,
      warnings: [],
    },
    summary: {
      files: fileResults.length,
      tests: allTests.length,
      judged: judgedTests.length,
      errors: fileErrors + testErrors,
      byAction,
      highConfidence: judgedTests.filter((test) => test.judgment.band === "high").length,
      needsReview: judgedTests.filter((test) => test.judgment.needsReview).length,
      mechanical,
    },
    files: fileResults,
  };

  await writeArtifacts(outDir, results);
  const exitCode = allErrored ? 1 : fileErrors + testErrors > 0 ? 2 : 0;
  return { exitCode, outDir, results };
};
