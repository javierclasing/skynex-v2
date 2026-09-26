import type {
  Answers,
  ChoiceAnswer,
  ChoiceJudgment,
  ChoiceQuestionKey,
  FragilityJudgment,
  Judgment,
  NoulAnswer,
  NoulJudgment,
  NoulQuestionKey,
  RecommendationJudgment,
} from "./types.js";

export const CHOICE_HIGH_CONFIDENCE = 0.7;
export const NOUL_FRAGILE = 0.5;
export const NOUL_UNCERTAIN_LOW = 0.3;

export const CHOICE_KEYS: readonly ChoiceQuestionKey[] = ["declared", "value", "recommendation"];
export const NOUL_KEYS: readonly NoulQuestionKey[] = ["fragile_time", "fragile_order", "fragile_randomness", "fragile_network"];
export const CHOICE_OPTIONS: Record<ChoiceQuestionKey, readonly string[]> = {
  declared: ["verifies", "partially", "different", "nothing"],
  value: ["regression", "documentation", "implementation_coupled", "trivial", "duplicate"],
  recommendation: ["keep", "strengthen", "rewrite", "delete"],
};

export type ValidationResult = { ok: true; answers: Answers } | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const validateChoice = (key: ChoiceQuestionKey, raw: unknown): { ok: true; answer: ChoiceAnswer } | { ok: false; message: string } => {
  if (!isRecord(raw)) return { ok: false, message: `${key}: expected an object answer` };
  if (raw["type"] !== "choice") return { ok: false, message: `${key}: expected type "choice"` };
  const probabilitiesRaw = raw["probabilities"];
  if (!isRecord(probabilitiesRaw)) return { ok: false, message: `${key}: missing probabilities` };
  const expected = CHOICE_OPTIONS[key];
  const present = Object.keys(probabilitiesRaw);
  if (present.length !== expected.length || expected.some((option) => !(option in probabilitiesRaw))) {
    return { ok: false, message: `${key}: probabilities must cover exactly ${expected.join(", ")}` };
  }
  const probabilities: Record<string, number> = {};
  for (const option of expected) {
    const value = probabilitiesRaw[option];
    if (!isUnit(value)) return { ok: false, message: `${key}: probability '${option}' must be a number in [0,1]` };
    probabilities[option] = value;
  }
  const confidence = raw["confidence"];
  if (!isUnit(confidence)) return { ok: false, message: `${key}: confidence must be a number in [0,1]` };
  const choice = raw["choice"];
  if (typeof choice !== "string" || !expected.includes(choice)) {
    return { ok: false, message: `${key}: choice must be one of ${expected.join(", ")}` };
  }
  const best = Math.max(...expected.map((option) => probabilities[option]!));
  const allowed = expected.filter((option) => probabilities[option]! >= best - 1e-9);
  if (!allowed.includes(choice)) return { ok: false, message: `${key}: choice '${choice}' is not the argmax` };
  return { ok: true, answer: { type: "choice", probabilities, choice, confidence } };
};

const validateNoul = (key: NoulQuestionKey, raw: unknown): { ok: true; answer: NoulAnswer } | { ok: false; message: string } => {
  if (!isRecord(raw)) return { ok: false, message: `${key}: expected an object answer` };
  if (raw["type"] !== "noul") return { ok: false, message: `${key}: expected type "noul"` };
  const noul = raw["noul"];
  if (!isUnit(noul)) return { ok: false, message: `${key}: noul must be a number in [0,1]` };
  return { ok: true, answer: { type: "noul", noul } };
};

/** Validates the seven-question answer set. Any violation makes the test an error. */
export const validateAnswers = (raw: unknown): ValidationResult => {
  if (!isRecord(raw)) return { ok: false, message: "answers must be an object" };
  const choiceAnswers = {} as Record<ChoiceQuestionKey, ChoiceAnswer>;
  for (const key of CHOICE_KEYS) {
    const result = validateChoice(key, raw[key]);
    if (!result.ok) return result;
    choiceAnswers[key] = result.answer;
  }
  const noulAnswers = {} as Record<NoulQuestionKey, NoulAnswer>;
  for (const key of NOUL_KEYS) {
    const result = validateNoul(key, raw[key]);
    if (!result.ok) return result;
    noulAnswers[key] = result.answer;
  }
  return {
    ok: true,
    answers: {
      declared: choiceAnswers.declared,
      value: choiceAnswers.value,
      fragile_time: noulAnswers.fragile_time,
      fragile_order: noulAnswers.fragile_order,
      fragile_randomness: noulAnswers.fragile_randomness,
      fragile_network: noulAnswers.fragile_network,
      recommendation: choiceAnswers.recommendation,
    },
  };
};

const choiceJudgment = (answer: ChoiceAnswer): ChoiceJudgment => {
  const values = Object.values(answer.probabilities);
  const sorted = [...values].sort((left, right) => right - left);
  const top1 = sorted[0] ?? 0;
  const top2 = sorted[1] ?? 0;
  const margin = top1 === top2 ? 0 : top1 - top2;
  const probability = answer.probabilities[answer.choice] ?? 0;
  return {
    verdict: answer.choice,
    probability,
    margin,
    confidence: answer.confidence,
    band: answer.confidence >= CHOICE_HIGH_CONFIDENCE ? "high" : "review",
  };
};

const recommendationJudgment = (answer: ChoiceAnswer): RecommendationJudgment => {
  const base = choiceJudgment(answer);
  return {
    action: base.verdict,
    probability: base.probability,
    margin: base.margin,
    confidence: base.confidence,
    band: base.band,
  };
};

const noulJudgment = (answer: NoulAnswer): NoulJudgment => {
  const probability = answer.noul;
  const derivedConfidence = Math.max(probability, 1 - probability);
  const flag = probability >= NOUL_FRAGILE ? "fragile" : inNoulBand(probability) ? "uncertain" : "not_fragile";
  return { probability, derivedConfidence, flag };
};

const confidenceReason = (name: string, confidence: number): string =>
  `${name} confidence ${confidence.toFixed(2)} ${confidence >= CHOICE_HIGH_CONFIDENCE ? ">=" : "<"} 0.70`;

const inNoulBand = (value: number): boolean => value > NOUL_UNCERTAIN_LOW && value < CHOICE_HIGH_CONFIDENCE;

/** Derives the deterministic judgment from a validated answer set. */
export const judge = (answers: Answers): Judgment => {
  const declared = choiceJudgment(answers.declared);
  const value = choiceJudgment(answers.value);
  const recommendation = recommendationJudgment(answers.recommendation);
  const fragility: FragilityJudgment = {
    fragile_time: noulJudgment(answers.fragile_time),
    fragile_order: noulJudgment(answers.fragile_order),
    fragile_randomness: noulJudgment(answers.fragile_randomness),
    fragile_network: noulJudgment(answers.fragile_network),
  };

  const reasons: string[] = [
    confidenceReason("declared", declared.confidence),
    confidenceReason("value", value.confidence),
    confidenceReason("recommendation", recommendation.confidence),
  ];

  const fragileEntries: ReadonlyArray<[NoulQuestionKey, NoulJudgment]> = [
    ["fragile_time", fragility.fragile_time],
    ["fragile_order", fragility.fragile_order],
    ["fragile_randomness", fragility.fragile_randomness],
    ["fragile_network", fragility.fragile_network],
  ];
  let fragileInBand = false;
  for (const [key, entry] of fragileEntries) {
    if (inNoulBand(entry.probability)) {
      fragileInBand = true;
      reasons.push(`${key} ${entry.probability.toFixed(2)} in (0.30, 0.70) flagged '${entry.flag}'`);
    }
  }

  const lowChoice = [declared, value, recommendation].some((entry) => entry.confidence < CHOICE_HIGH_CONFIDENCE);
  const needsReview = lowChoice || fragileInBand;
  return {
    declared,
    value,
    fragility,
    recommendation,
    needsReview,
    band: needsReview ? "review" : "high",
    reasons,
    inconsistencies: [],
  };
};

export { confidenceReason, inNoulBand };
