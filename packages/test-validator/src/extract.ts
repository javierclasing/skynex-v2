import { parse } from "@babel/parser";
import type { ExtractedTest, MockRef, SignalHints, TestHook, TestSignals } from "./types.js";

/**
 * Structural view over Babel AST nodes. We avoid a phantom dependency on
 * `@babel/types` by traversing through this minimal node shape.
 */
interface AstNode {
  readonly type: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly loc?: { readonly start: { readonly line: number } } | null;
  readonly [key: string]: unknown;
}

interface PositionedMock extends MockRef {
  start: number;
}

interface CollectedTest {
  call: AstNode;
  name: string;
  fullName: string;
  line: number;
  code: string;
  hooks: TestHook[];
  referenced: Set<string>;
}

interface FileFacts {
  imports: Map<string, string>;
  declared: Set<string>;
}

const DESCRIBE_NAMES = new Set(["describe", "describe.only", "describe.skip"]);
const TEST_NAMES = new Set(["it", "it.only", "it.skip", "it.todo", "test", "test.only", "test.skip", "test.todo"]);
const HOOK_NAMES = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);
const MOCK_CALL_NAMES = new Set(["jest.mock", "vi.mock", "jest.spyOn", "vi.spyOn"]);
const MAX_HOOKS = 4;
const MAX_HOOK_CODE = 1200;
const MAX_TARGET_CHARS = 200;
const MAX_HELPER_NAME_CHARS = 200;
const SKIPPED_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "errors",
  "comments",
  "tokens",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

const walk = (node: AstNode, visit: (node: AstNode) => void): void => {
  visit(node);
  for (const key of Object.keys(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
};

const sliceSource = (source: string, node: AstNode | undefined): string => {
  if (!node || node.start === null || node.end === null) return "";
  return source.slice(node.start, node.end);
};

const cap = (value: string, limit: number): string => (value.length > limit ? value.slice(0, limit) : value);

const memberName = (node: AstNode): string | undefined => {
  const object = node["object"];
  const property = node["property"];
  if (!isNode(object) || !isNode(property)) return undefined;
  if (object.type !== "Identifier" || property.type !== "Identifier") return undefined;
  const objectName = object["name"];
  const propertyName = property["name"];
  if (typeof objectName !== "string" || typeof propertyName !== "string") return undefined;
  return `${objectName}.${propertyName}`;
};

/**
 * Property name of a member callee without requiring an `Identifier` receiver.
 * `expect(x).toMatchSnapshot()` parses as `MemberExpression{ object: CallExpression }`,
 * so `memberName` yields `undefined`; snapshot matchers must still be visible.
 */
const memberPropertyName = (node: AstNode): string | undefined => {
  const property = node["property"];
  if (!isNode(property) || property.type !== "Identifier") return undefined;
  const name = property["name"];
  return typeof name === "string" ? name : undefined;
};

const calleeMatcherName = (node: AstNode): string | undefined => {
  const callee = node["callee"];
  if (!isNode(callee) || callee.type !== "MemberExpression") return undefined;
  return memberPropertyName(callee);
};

const calleeName = (node: AstNode): string | undefined => {
  const callee = node["callee"];
  if (!isNode(callee)) return undefined;
  if (callee.type === "Identifier") {
    const name = callee["name"];
    return typeof name === "string" ? name : undefined;
  }
  if (callee.type === "MemberExpression") return memberName(callee);
  return undefined;
};

const callFromStatement = (statement: AstNode): AstNode | undefined => {
  if (statement.type !== "ExpressionStatement") return undefined;
  const expression = statement["expression"];
  if (isNode(expression) && expression.type === "CallExpression") return expression;
  return undefined;
};

const firstArgument = (call: AstNode): AstNode | undefined => {
  const args = call["arguments"];
  if (!Array.isArray(args)) return undefined;
  return isNode(args[0]) ? args[0] : undefined;
};

const argumentAt = (call: AstNode, index: number): AstNode | undefined => {
  const args = call["arguments"];
  if (!Array.isArray(args)) return undefined;
  const value = args[index];
  return isNode(value) ? value : undefined;
};

const literalString = (node: AstNode | undefined): string | undefined => {
  if (!node) return undefined;
  if (node.type === "StringLiteral") {
    const value = node["value"];
    return typeof value === "string" ? value : undefined;
  }
  if (node.type === "TemplateLiteral") {
    const expressions = node["expressions"];
    const quasis = node["quasis"];
    if (!Array.isArray(expressions) || expressions.length !== 0) return undefined;
    if (!Array.isArray(quasis) || quasis.length !== 1 || !isNode(quasis[0])) return undefined;
    const quasiValue = quasis[0]["value"];
    if (!isNode(quasiValue)) return undefined;
    const cooked = quasiValue["cooked"];
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
};

const nextStatements = (block: AstNode): AstNode[] => {
  const body = block["body"];
  if (!Array.isArray(body)) return [];
  return body.filter(isNode);
};

const callbackFunction = (call: AstNode): AstNode | undefined => {
  const args = call["arguments"];
  if (!Array.isArray(args)) return undefined;
  for (const argument of args) {
    if (!isNode(argument)) continue;
    if (argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression") return argument;
  }
  return undefined;
};

const mockKind = (name: string): MockRef["kind"] | undefined => {
  if (name.endsWith(".mock")) return "mock";
  if (name.endsWith(".spyOn")) return "spyOn";
  return undefined;
};

const mockTarget = (call: AstNode, kind: MockRef["kind"], source: string): string => {
  if (kind === "spyOn") {
    const object = firstArgument(call);
    const property = argumentAt(call, 1);
    const literal = literalString(property);
    if (literal !== undefined) return cap(`${sliceSource(source, object)}.${literal}`, MAX_TARGET_CHARS);
  }
  const first = firstArgument(call);
  if (!first) return "";
  const literal = literalString(first);
  if (literal !== undefined) return literal;
  return cap(sliceSource(source, first), MAX_TARGET_CHARS);
};

const collectMockCalls = (root: AstNode, source: string): PositionedMock[] => {
  const collected: PositionedMock[] = [];
  walk(root, (node) => {
    if (node.type !== "CallExpression") return;
    const name = calleeName(node);
    if (!name || !MOCK_CALL_NAMES.has(name)) return;
    const kind = mockKind(name);
    if (!kind) return;
    collected.push({ kind, target: mockTarget(node, kind, source), start: node.start ?? 0 });
  });
  collected.sort((left, right) => left.start - right.start);
  return collected;
};

const HINTS: ReadonlyArray<{ key: keyof SignalHints; pattern: RegExp }> = [
  { key: "time", pattern: /\bDate\b|performance\.now|setTimeout|setInterval|useFakeTimers|toISOString/ },
  { key: "random", pattern: /Math\.random|randomUUID|randomBytes|faker\.|chance\./ },
  { key: "network", pattern: /fetch\s*\(|axios|node-fetch|got\s*\(|supertest|https?\.request|\bhttp\.request/ },
];

const detectHints = (text: string): SignalHints => ({
  time: HINTS[0]!.pattern.test(text),
  random: HINTS[1]!.pattern.test(text),
  network: HINTS[2]!.pattern.test(text),
});

const testLabel = (call: AstNode, source: string): string => {
  const first = firstArgument(call);
  const literal = literalString(first);
  if (literal !== undefined) return literal;
  const sliced = cap(sliceSource(source, first), MAX_TARGET_CHARS);
  return sliced || "<anonymous>";
};

const describeLabel = (call: AstNode, source: string): string => {
  const first = firstArgument(call);
  const literal = literalString(first);
  if (literal !== undefined) return literal;
  const sliced = cap(sliceSource(source, first), MAX_TARGET_CHARS);
  return sliced || "<describe>";
};

const collectFileFacts = (program: AstNode): FileFacts => {
  const imports = new Map<string, string>();
  const declared = new Set<string>();
  walk(program, (node) => {
    if (node.type === "ImportDeclaration") {
      const source = node["source"];
      const sourceValue = literalString(isNode(source) ? source : undefined);
      const specifiers = node["specifiers"];
      if (sourceValue !== undefined && Array.isArray(specifiers)) {
        for (const specifier of specifiers) {
          if (!isNode(specifier)) continue;
          const local = specifier["local"];
          if (!isNode(local)) continue;
          const name = local["name"];
          if (typeof name === "string") imports.set(name, sourceValue);
        }
      }
      return;
    }
    if (node.type === "FunctionDeclaration") {
      const id = node["id"];
      if (isNode(id) && typeof id["name"] === "string") declared.add(id["name"]);
      return;
    }
    if (node.type === "VariableDeclarator") {
      const id = node["id"];
      const init = node["init"];
      if (isNode(id) && id.type === "Identifier" && isNode(init) && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
        const name = id["name"];
        if (typeof name === "string") declared.add(name);
      }
    }
  });
  return { imports, declared };
};

const referencedNames = (call: AstNode): Set<string> => {
  const names = new Set<string>();
  walk(call, (node) => {
    if (node.type !== "Identifier") return;
    const name = node["name"];
    if (typeof name === "string") names.add(name);
  });
  return names;
};

const analyzeSignals = (context: {
  call: AstNode;
  code: string;
  hooks: string[];
  helpers: string[];
  importsReferenced: string[];
  mocks: MockRef[];
  fileMocks: MockRef[];
  only: boolean;
  skip: boolean;
  todo: boolean;
  async: boolean;
  parameterized: boolean;
}): TestSignals => {
  let expectCount = 0;
  let assertCount = 0;
  let snapshots = 0;
  walk(context.call, (node) => {
    if (node.type !== "CallExpression") return;
    const name = calleeName(node);
    if (name) {
      const head = name.split(".")[0];
      if (head === "expect") expectCount += 1;
      else if (head === "assert") assertCount += 1;
    }
    const matcher = name ?? calleeMatcherName(node);
    if (matcher !== undefined && (matcher.endsWith("toMatchSnapshot") || matcher.endsWith("toMatchInlineSnapshot"))) {
      snapshots += 1;
    }
  });
  return {
    asserts: { expect: expectCount, assert: assertCount, total: expectCount + assertCount },
    mocks: context.mocks,
    fileMocks: context.fileMocks,
    skip: context.skip,
    only: context.only,
    todo: context.todo,
    snapshots,
    async: context.async,
    parameterized: context.parameterized,
    hooks: context.hooks,
    helpers: context.helpers,
    importsReferenced: context.importsReferenced,
    hints: detectHints(context.code),
  };
};

const visitBlock = (
  statements: AstNode[],
  context: { describePath: string[]; hooks: TestHook[]; source: string; facts: FileFacts },
  collected: CollectedTest[],
): void => {
  const localHooks: TestHook[] = [];
  for (const statement of statements) {
    const call = callFromStatement(statement);
    if (!call) continue;
    const name = calleeName(call);
    if (name && HOOK_NAMES.has(name)) {
      localHooks.push({ name, code: cap(sliceSource(context.source, call), MAX_HOOK_CODE) });
    }
  }
  const hooks = [...context.hooks, ...localHooks].slice(0, MAX_HOOKS);

  for (const statement of statements) {
    const call = callFromStatement(statement);
    if (!call) continue;
    const name = calleeName(call);
    if (!name) continue;

    if (DESCRIBE_NAMES.has(name)) {
      const label = describeLabel(call, context.source);
      const callback = callbackFunction(call);
      if (!callback) continue;
      const body = callback["body"];
      if (!isNode(body) || body.type !== "BlockStatement") continue;
      visitBlock(nextStatements(body), { describePath: [...context.describePath, label], hooks, source: context.source, facts: context.facts }, collected);
      continue;
    }

    if (TEST_NAMES.has(name)) {
      const label = testLabel(call, context.source);
      const fullName = [...context.describePath, label].join(" > ");
      collected.push({
        call,
        name: label,
        fullName,
        line: call.loc?.start.line ?? 1,
        code: sliceSource(context.source, call),
        hooks,
        referenced: referencedNames(call),
      });
    }
  }
};

/**
 * Extracts every `describe`/`it`/`test` call from a source file with enriched signals.
 * Throws the Babel syntax error when the file cannot be parsed.
 */
export const extractTests = (source: string, file: string): ExtractedTest[] => {
  const parsed = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: false,
  });
  const root = parsed.program as unknown as AstNode;
  const rawMocks = collectMockCalls(root, source);
  const facts = collectFileFacts(root);

  const collected: CollectedTest[] = [];
  visitBlock(nextStatements(root), { describePath: [], hooks: [], source, facts }, collected);

  const ranges = collected.map((entry) => ({
    start: entry.call.start ?? 0,
    end: entry.call.end ?? entry.call.start ?? 0,
  }));
  const isInsideTest = (position: number): boolean => ranges.some((range) => position >= range.start && position < range.end);
  const fileMocks: MockRef[] = rawMocks.filter((mock) => !isInsideTest(mock.start)).map(({ kind, target }) => ({ kind, target }));

  // Disambiguate tests that share `fullName` within the same file, in source
  // order: the first keeps the bare id, later twins get `#2`, `#3`, ...
  const idCounts = new Map<string, number>();

  return collected.map((entry) => {
    const baseId = `${file}::${entry.fullName}`;
    const occurrence = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, occurrence);
    const start = entry.call.start ?? 0;
    const end = entry.call.end ?? start;
    const mocks: MockRef[] = rawMocks.filter((mock) => mock.start >= start && mock.start < end).map(({ kind, target }) => ({ kind, target }));
    const callee = calleeName(entry.call) ?? "";
    const placeholders = /%[si]/.test(entry.fullName);
    const callback = callbackFunction(entry.call);
    const isAsync = isNode(callback) && callback["async"] === true;
    const helperNames = [...facts.declared]
      .filter((name) => entry.referenced.has(name))
      .slice(0, 50)
      .map((name) => cap(name, MAX_HELPER_NAME_CHARS));
    const importsReferenced: string[] = [];
    for (const [local, importSource] of facts.imports) {
      if (entry.referenced.has(local)) importsReferenced.push(`${local} from ${importSource}`);
    }
    const signals = analyzeSignals({
      call: entry.call,
      code: entry.code,
      hooks: entry.hooks.map((hook) => hook.name),
      helpers: helperNames,
      importsReferenced,
      mocks,
      fileMocks,
      only: callee.endsWith(".only"),
      skip: callee.endsWith(".skip"),
      todo: callee.endsWith(".todo"),
      async: isAsync,
      parameterized: placeholders,
    });
    return {
      id: occurrence === 1 ? baseId : `${baseId}#${occurrence}`,
      file,
      line: entry.line,
      fullName: entry.fullName,
      name: entry.name,
      code: entry.code,
      hooks: entry.hooks,
      mocks,
      fileMocks,
      helpers: helperNames,
      importsReferenced,
      signals,
      placeholders,
    };
  });
};
