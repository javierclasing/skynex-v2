import type { StateFlags, TestHook } from "./types.js";

const MAX_SIBLINGS = 30;
const INTENT_CAP = 2000;
const SIBLING_NAME_CAP = 200;
const NAME_CAP = 500;
const INTENT_FLOOR = 120;

export interface StateInput {
  file: string;
  fullName: string;
  intent: string;
  intentSource: string;
  code: string;
  hooks: TestHook[];
  helpers: string[];
  importsReferenced: string[];
  siblings: string[];
}

export interface StateOutcome {
  state: string;
  stateChars: number;
  truncated: boolean;
  stateFlags: StateFlags;
  tooLarge: boolean;
}

interface Config {
  codeKeep: number;
  intentCap: number | null;
  siblingCap: number | null;
  siblingLimit: number;
  nameCap: number | null;
  dropHelpers: boolean;
  dropHooks: boolean;
}

const cap = (value: string, limit: number): string => (value.length > limit ? value.slice(0, limit) : value);

const truncateCode = (code: string, keep: number): string => {
  if (keep >= code.length) return code;
  if (keep <= 0) return "";
  const firstLength = Math.floor((keep * 2) / 3);
  const lastLength = keep - firstLength;
  const removed = code.length - keep;
  const first = code.slice(0, firstLength);
  const last = code.slice(code.length - lastLength);
  return `${first}\n... [truncated ${removed} chars] ...\n${last}`;
};

const serialize = (input: StateInput, config: Config): string => {
  const lines: string[] = [];
  lines.push(`file: ${input.file}`);
  lines.push(`test: ${config.nameCap === null ? input.fullName : cap(input.fullName, config.nameCap)}`);
  lines.push(`intent[${input.intentSource}]: ${config.intentCap === null ? input.intent : cap(input.intent, config.intentCap)}`);
  if (input.helpers.length > 0 && !config.dropHelpers) lines.push(`helpers: ${input.helpers.join(", ")}`);
  if (input.importsReferenced.length > 0) lines.push(`imports: ${input.importsReferenced.join(", ")}`);
  if (input.hooks.length > 0 && !config.dropHooks) {
    lines.push("hooks:");
    for (const hook of input.hooks) lines.push(hook.code);
  }
  const siblings = input.siblings
    .slice(0, config.siblingLimit)
    .map((name) => (config.siblingCap === null ? name : cap(name, config.siblingCap)));
  if (siblings.length > 0) {
    lines.push("sibling_tests:");
    for (const sibling of siblings) lines.push(`- ${sibling}`);
  }
  lines.push("code:");
  lines.push(truncateCode(input.code, config.codeKeep));
  return lines.join("\n");
};

const flagsFor = (input: StateInput, config: Config): StateFlags => {
  const codeTruncated = config.codeKeep < input.code.length;
  const codeFloored = config.codeKeep === 0;
  const intentTruncated = config.intentCap !== null && input.intent.length > config.intentCap;
  const intentFloored = config.intentCap !== null && config.intentCap <= INTENT_FLOOR && input.intent.length > INTENT_FLOOR;
  const nameTruncated = config.nameCap !== null && input.fullName.length > config.nameCap;
  const siblingsTruncated =
    (config.siblingCap !== null && input.siblings.some((name) => name.length > config.siblingCap!)) ||
    config.siblingLimit < Math.min(input.siblings.length, MAX_SIBLINGS);
  const helpersDropped = config.dropHelpers && input.helpers.length > 0;
  const hooksDropped = config.dropHooks && input.hooks.length > 0;
  return {
    codeTruncated,
    intentTruncated,
    siblingsTruncated,
    nameTruncated,
    helpersDropped,
    hooksDropped,
    codeFloored,
    intentFloored,
  };
};

const outcome = (input: StateInput, config: Config, tooLarge: boolean): StateOutcome => {
  const state = serialize(input, config);
  const stateFlags = flagsFor(input, config);
  const truncated = Object.values(stateFlags).some(Boolean);
  return { state, stateChars: state.length, truncated, stateFlags, tooLarge };
};

/**
 * Builds the deterministic state sent to the judge, with the documented
 * truncation cascade. `stateChars <= maxStateChars` for any non-error outcome.
 */
export const buildState = (input: StateInput, maxStateChars: number): StateOutcome => {
  const config: Config = {
    codeKeep: input.code.length,
    intentCap: null,
    siblingCap: null,
    siblingLimit: Math.min(input.siblings.length, MAX_SIBLINGS),
    nameCap: null,
    dropHelpers: false,
    dropHooks: false,
  };
  const fits = (): boolean => serialize(input, config).length <= maxStateChars;

  if (fits()) return outcome(input, config, false);

  if (input.intent.length > INTENT_CAP) {
    config.intentCap = INTENT_CAP;
    if (fits()) return outcome(input, config, false);
  }

  config.siblingCap = SIBLING_NAME_CAP;
  if (fits()) return outcome(input, config, false);
  while (config.siblingLimit > 0) {
    config.siblingLimit -= 1;
    if (fits()) return outcome(input, config, false);
  }

  if (input.fullName.length > NAME_CAP) {
    config.nameCap = NAME_CAP;
    if (fits()) return outcome(input, config, false);
  }

  if (input.helpers.length > 0) {
    config.dropHelpers = true;
    if (fits()) return outcome(input, config, false);
  }

  if (input.hooks.length > 0) {
    config.dropHooks = true;
    if (fits()) return outcome(input, config, false);
  }

  if (input.intent.length > INTENT_FLOOR) {
    config.intentCap = INTENT_FLOOR;
    if (fits()) return outcome(input, config, false);
  }

  // Final code retention: binary-search the largest retained prefix that fits.
  if (serialize(input, { ...config, codeKeep: 0 }).length <= maxStateChars) {
    let low = 0;
    let high = input.code.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (serialize(input, { ...config, codeKeep: middle }).length <= maxStateChars) low = middle;
      else high = middle - 1;
    }
    config.codeKeep = low;
    return outcome(input, config, false);
  }

  config.codeKeep = 0;
  return outcome(input, config, true);
};

export { MAX_SIBLINGS };
