/**
 * Test validator domain types. Matches the `results.json` schema (schemaVersion 1)
 * of the original engine: `<root>/results.json` and `<root>/report.md`.
 */
export type RunMode = "dry-run" | "replay" | "live";
export type IntentSource = "map" | "given" | "inferred";
export type ChoiceBand = "high" | "review";
export type FragilityFlag = "fragile" | "uncertain" | "not_fragile";
export type TestStatus = "extracted" | "judged" | "error";

export interface RunOptions {
  files?: string[];
  globs?: string[];
  root: string;
  testFilter?: string;
  intent?: string;
  intentsPath?: string;
  out?: string;
  model: string;
  timeoutMs: number;
  maxStateChars: number;
  dryRun: boolean;
  replayPath?: string;
  /**
   * Resolved API key for live mode. When absent the runner falls back to
   * `TYPESAFE_API_KEY`, then fails closed with `missing_api_key`.
   */
  apiKey?: string;
  /** Override the System One endpoint. Injected by tests; the CLI never exposes it. */
  endpoint?: string;
  /** Override `fetch`. Injected by tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface AssertCounts {
  expect: number;
  assert: number;
  total: number;
}

/** `jest.mock`/`vi.mock` -> "mock"; `jest.spyOn`/`vi.spyOn` -> "spyOn". */
export interface MockRef {
  kind: "mock" | "spyOn";
  target: string;
}

export interface SignalHints {
  time: boolean;
  random: boolean;
  network: boolean;
}

export interface TestSignals {
  asserts: AssertCounts;
  mocks: MockRef[];
  fileMocks: MockRef[];
  skip: boolean;
  only: boolean;
  todo: boolean;
  snapshots: number;
  async: boolean;
  parameterized: boolean;
  hooks: string[];
  helpers: string[];
  importsReferenced: string[];
  hints: SignalHints;
}

export interface TestHook {
  name: string;
  code: string;
}

export interface StateFlags {
  codeTruncated: boolean;
  intentTruncated: boolean;
  siblingsTruncated: boolean;
  nameTruncated: boolean;
  helpersDropped: boolean;
  hooksDropped: boolean;
  codeFloored: boolean;
  intentFloored: boolean;
}

/** Extracted test with internal fields (`code`, hook code) stripped before serialization. */
export interface ExtractedTest {
  id: string;
  file: string;
  line: number;
  fullName: string;
  name: string;
  code: string;
  hooks: TestHook[];
  mocks: MockRef[];
  fileMocks: MockRef[];
  helpers: string[];
  importsReferenced: string[];
  signals: TestSignals;
  placeholders: boolean;
}

export type ChoiceQuestionKey = "declared" | "value" | "recommendation";
export type NoulQuestionKey = "fragile_time" | "fragile_order" | "fragile_randomness" | "fragile_network";
export type QuestionKey = ChoiceQuestionKey | NoulQuestionKey;

export interface ChoiceAnswer {
  type: "choice";
  probabilities: Record<string, number>;
  choice: string;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface Answers {
  declared: ChoiceAnswer;
  value: ChoiceAnswer;
  recommendation: ChoiceAnswer;
  fragile_time: NoulAnswer;
  fragile_order: NoulAnswer;
  fragile_randomness: NoulAnswer;
  fragile_network: NoulAnswer;
}

export interface ChoiceJudgment {
  verdict: string;
  probability: number;
  margin: number;
  confidence: number;
  band: ChoiceBand;
}

export interface RecommendationJudgment {
  action: string;
  probability: number;
  margin: number;
  confidence: number;
  band: ChoiceBand;
}

export interface NoulJudgment {
  probability: number;
  derivedConfidence: number;
  flag: FragilityFlag;
}

export interface FragilityJudgment {
  fragile_time: NoulJudgment;
  fragile_order: NoulJudgment;
  fragile_randomness: NoulJudgment;
  fragile_network: NoulJudgment;
}

export interface Judgment {
  declared: ChoiceJudgment;
  value: ChoiceJudgment;
  fragility: FragilityJudgment;
  recommendation: RecommendationJudgment;
  needsReview: boolean;
  band: ChoiceBand;
  reasons: string[];
  inconsistencies: string[];
}

export interface ResultTestBase {
  id: string;
  file: string;
  line: number;
  fullName: string;
  intent: string;
  intentSource: IntentSource;
  signals: TestSignals;
  stateChars: number;
  truncated: boolean;
  stateFlags: StateFlags;
}

export interface ExtractedResultTest extends ResultTestBase {
  status: "extracted";
}

export interface JudgedResultTest extends ResultTestBase {
  status: "judged";
  answers: Answers;
  judgment: Judgment;
  error: null;
}

export interface ErroredResultTest extends ResultTestBase {
  status: "error";
  error: { kind: string; message: string };
}

export type ResultTest = ExtractedResultTest | JudgedResultTest | ErroredResultTest;

export interface FileResultError {
  kind: string;
  message: string;
  line?: number;
}

export interface FileResult {
  path: string;
  status: "ok" | "error";
  error: FileResultError | null;
  tests: ResultTest[];
}

export interface ResultsRun {
  mode: RunMode;
  model: string;
  modelResolved: string | null;
  root: string;
  startedAt: string;
  finishedAt: string;
  maxStateChars: number;
  timeoutMs: number;
  outDir: string;
  warnings: string[];
}

export interface MechanicalCounts {
  only: number;
  skip: number;
  noAsserts: number;
  snapshots: number;
  mockHeavy: number;
}

export interface ActionCounts {
  keep: number;
  strengthen: number;
  rewrite: number;
  delete: number;
}

export interface ResultsSummary {
  files: number;
  tests: number;
  judged: number;
  errors: number;
  byAction: ActionCounts;
  highConfidence: number;
  needsReview: number;
  mechanical: MechanicalCounts;
}

export interface ResultsFile {
  schemaVersion: 1;
  tool: "skynex-test-validator";
  toolVersion: string;
  run: ResultsRun;
  summary: ResultsSummary;
  files: FileResult[];
}
