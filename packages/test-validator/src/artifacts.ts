import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Judgment, ResultTest, ResultsFile } from "./types.js";

const RESULTS_FILE = "results.json";
const REPORT_FILE = "report.md";
const MAX_SANITIZED_CHARS = 300;

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** Filesystem-safe UTC stamp, e.g. `20260919T195409Z`. */
export const defaultOutDir = (): string =>
  `/tmp/opencode/test-validator/${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;

/**
 * Neutralizes any repo-derived string before it reaches `report.md`: literalizes
 * line breaks, drops control and bidi-override code points, defuses backticks and
 * caps the length.
 */
export const sanitize = (value: string): string => {
  let result = value
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[\u2028\u2029\u0085]/g, "\\n")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/`/g, "'");
  if (result.length > MAX_SANITIZED_CHARS) result = result.slice(0, MAX_SANITIZED_CHARS);
  return result;
};

/** Keeps the out dir a real directory and never traverses a symlink. */
const ensureOutDir = async (outDir: string): Promise<void> => {
  try {
    const stats = await lstat(outDir);
    if (stats.isSymbolicLink()) throw new Error(`--out must not be a symlink: ${outDir}`);
    if (!stats.isDirectory()) throw new Error(`--out must be a directory: ${outDir}`);
    await chmod(outDir, 0o700);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await mkdir(outDir, { recursive: true, mode: 0o700 });
  }
  const verified = await lstat(outDir);
  if (verified.isSymbolicLink() || !verified.isDirectory()) {
    throw new Error(`--out must be a real directory: ${outDir}`);
  }
};

/** Writes atomically via an exclusive temp file plus rename, mode 0600. */
const writeFileAtomic = async (directory: string, name: string, content: string): Promise<void> => {
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const actionLabels: ReadonlyArray<{ readonly action: "keep" | "strengthen" | "rewrite" | "delete"; readonly label: string }> = [
  { action: "keep", label: "Mantener" },
  { action: "strengthen", label: "Reforzar" },
  { action: "rewrite", label: "Reescribir" },
  { action: "delete", label: "Borrar" },
];

const fragilityText = (judgment: Judgment): string => {
  const { fragility } = judgment;
  return [
    `fragile_time=${fragility.fragile_time.probability.toFixed(2)}:${fragility.fragile_time.flag}`,
    `fragile_order=${fragility.fragile_order.probability.toFixed(2)}:${fragility.fragile_order.flag}`,
    `fragile_randomness=${fragility.fragile_randomness.probability.toFixed(2)}:${fragility.fragile_randomness.flag}`,
    `fragile_network=${fragility.fragile_network.probability.toFixed(2)}:${fragility.fragile_network.flag}`,
  ].join(", ");
};

const highConfidenceLine = (test: ResultTest & { status: "judged" }): string => {
  const { judgment } = test;
  return (
    `- \`${sanitize(test.id)}\` — declarado: ${sanitize(judgment.declared.verdict)} (confianza ${judgment.declared.confidence.toFixed(2)}); ` +
    `valor: ${sanitize(judgment.value.verdict)} (confianza ${judgment.value.confidence.toFixed(2)}); ` +
    `recomendación: ${sanitize(judgment.recommendation.action)} (confianza ${judgment.recommendation.confidence.toFixed(2)}); ` +
    `fragilidad: ${fragilityText(judgment)}`
  );
};

const reviewLine = (test: ResultTest & { status: "judged" }): string => {
  const { judgment } = test;
  const reasons = judgment.reasons.map((reason) => sanitize(reason)).join("; ");
  return (
    `- \`${sanitize(test.id)}\` — recomendación: ${sanitize(judgment.recommendation.action)} ` +
    `(confianza ${judgment.recommendation.confidence.toFixed(2)}); fragilidad: ${fragilityText(judgment)}; motivos: ${reasons}`
  );
};

const buildResultsJson = (results: ResultsFile): string => `${JSON.stringify(results, null, 2)}\n`;

const buildReport = (results: ResultsFile): string => {
  const { summary, run } = results;
  const lines: string[] = [];

  lines.push("# Triaje semántico de tests");
  lines.push("");
  lines.push(`- Modo: ${sanitize(run.mode)}`);
  lines.push(`- Modelo solicitado: ${sanitize(run.model)}`);
  lines.push(`- Modelo resuelto: ${run.modelResolved === null ? "(ninguno)" : sanitize(run.modelResolved)}`);
  lines.push(`- Raíz: ${sanitize(run.root)}`);
  lines.push(`- Inicio: ${sanitize(run.startedAt)}`);
  lines.push(`- Fin: ${sanitize(run.finishedAt)}`);
  lines.push("");

  lines.push("## Resumen por acción");
  lines.push("");
  lines.push("| Acción | Tests |");
  lines.push("| --- | --- |");
  lines.push(`| keep | ${summary.byAction.keep} |`);
  lines.push(`| strengthen | ${summary.byAction.strengthen} |`);
  lines.push(`| rewrite | ${summary.byAction.rewrite} |`);
  lines.push(`| delete | ${summary.byAction.delete} |`);
  lines.push("");
  lines.push(
    `Archivos: ${summary.files} · Tests: ${summary.tests} · Juzgados: ${summary.judged} · ` +
      `Alta confianza: ${summary.highConfidence} · Revisar a mano: ${summary.needsReview} · Errores: ${summary.errors}`,
  );
  lines.push("");

  const judged = results.files.flatMap((file) => file.tests).filter((test): test is ResultTest & { status: "judged" } => test.status === "judged");

  lines.push("## Alta confianza");
  lines.push("");
  for (const { action, label } of actionLabels) {
    const items = judged.filter((test) => test.judgment.band === "high" && test.judgment.recommendation.action === action);
    lines.push(`### ${label}`);
    lines.push(...(items.length ? items.map(highConfidenceLine) : [`- Ninguno (0 tests de acción ${label} en alta confianza).`]));
    lines.push("");
  }

  lines.push("## Revisar a mano");
  lines.push("");
  const review = judged.filter((test) => test.judgment.needsReview);
  lines.push(...(review.length ? review.map(reviewLine) : ["- Ninguno (0 tests)."]));
  lines.push("");

  lines.push("## Señales mecánicas");
  lines.push("");
  lines.push(`- Solo (it.only): ${summary.mechanical.only}`);
  lines.push(`- Skip: ${summary.mechanical.skip}`);
  lines.push(`- Sin aserciones: ${summary.mechanical.noAsserts}`);
  lines.push(`- Con snapshots: ${summary.mechanical.snapshots}`);
  lines.push(`- Mock-heavy (2+ mocks de test o de archivo): ${summary.mechanical.mockHeavy}`);
  lines.push("");

  lines.push("## Errores");
  lines.push("");
  const fileErrors = results.files.filter((file) => file.status === "error" && file.error).map((file) => `- \`${sanitize(file.path)}\` — ${sanitize(file.error!.kind)}: ${sanitize(file.error!.message)}`);
  const testErrors = results.files
    .flatMap((file) => file.tests)
    .filter((test): test is ResultTest & { status: "error" } => test.status === "error")
    .map((test) => `- \`${sanitize(test.id)}\` — ${sanitize(test.error.kind)}: ${sanitize(test.error.message)}`);
  const errorLines = [...fileErrors, ...testErrors];
  lines.push(...(errorLines.length ? errorLines : ["- Ninguno (0 errores)."]));
  lines.push("");

  return lines.join("\n");
};

/** Writes `results.json` and `report.md` into `outDir` (created/reused mode 0700). */
export const writeArtifacts = async (outDir: string, results: ResultsFile): Promise<void> => {
  await ensureOutDir(outDir);
  await writeFileAtomic(outDir, RESULTS_FILE, buildResultsJson(results));
  await writeFileAtomic(outDir, REPORT_FILE, buildReport(results));
};

export { RESULTS_FILE, REPORT_FILE };
