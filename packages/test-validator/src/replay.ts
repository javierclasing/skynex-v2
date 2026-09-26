import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ReplayResponse {
  model: string | undefined;
  answers: unknown;
}

export interface ReplaySet {
  model: string;
  responses: Map<string, ReplayResponse>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Loads a replay answer set, fail-closed when the model does not match. */
export const loadReplay = async (path: string, requestedModel: string): Promise<ReplaySet> => {
  const raw = await readFile(resolve(path), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--replay file is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error("--replay file must be a JSON object");
  const model = parsed["model"];
  if (typeof model !== "string" || model.length === 0) throw new Error("--replay file is missing a model field");
  if (model !== requestedModel) {
    // Never echo the requested model: it is unvalidated argv and may be a secret.
    throw new Error(`--replay model '${model}' does not match the requested model`);
  }
  const responsesRaw = parsed["responses"];
  if (!isRecord(responsesRaw)) throw new Error("--replay file is missing a responses object");
  const responses = new Map<string, ReplayResponse>();
  for (const [id, value] of Object.entries(responsesRaw)) {
    if (!isRecord(value)) continue;
    const responseModel = value["model"];
    responses.set(id, {
      model: typeof responseModel === "string" ? responseModel : undefined,
      answers: value["answers"],
    });
  }
  return { model, responses };
};

/** Loads the optional `--intents` map (test id / full name / relpath -> intent). */
export const loadIntents = async (path: string): Promise<Map<string, string>> => {
  const raw = await readFile(resolve(path), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--intents file is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error("--intents file must be a JSON object mapping ids to intent strings");
  const intents = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`--intents entry '${key}' must be a string`);
    intents.set(key, value);
  }
  return intents;
};
