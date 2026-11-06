import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { unescaped } from "../symbol-ast.js";

/** Zig container literals. A Zig source file is itself a struct. */
export const ZIG_CONTAINERS = new Set(["struct_declaration", "enum_declaration", "union_declaration", "opaque_declaration"]);

/**
 * tree-sitter-zig 1.1.2 recovers every valid empty container (`struct {}`)
 * with a zero-width `container_field` holding a zero-width identifier
 * (tree-sitter-grammars/tree-sitter-zig#39). That recovery is the only one
 * treated as benign; any other error still fails strict analysis.
 */
export function isZigPhantomField(node: TreeSitterNode): boolean {
  if (node.type !== "container_field" || node.startIndex !== node.endIndex) return false;
  if (!node.parent || !ZIG_CONTAINERS.has(node.parent.type)) return false;
  if (node.namedChildren.some(child => child.type !== "identifier" || child.startIndex !== child.endIndex)) return false;
  const neighbour = (step: "previousSibling" | "nextSibling") => {
    let current = node[step];
    while (current && current.type === "comment") current = current[step];
    return current?.type;
  };
  return neighbour("previousSibling") === "{" && neighbour("nextSibling") === "}";
}

/** True when the parse has no error other than the empty-container phantom. */
export function zigParseIsClean(node: TreeSitterNode): boolean {
  if (!node.hasError) return true;
  if (isZigPhantomField(node)) return true;
  if (node.isError || node.isMissing || node.childCount === 0) return false;
  return node.children.every(zigParseIsClean);
}

/** Members of a container body: children after `{`; every child of the file. */
export function zigMembers(container: TreeSitterNode): TreeSitterNode[] {
  if (container.type === "source_file") return container.namedChildren;
  const open = container.children.findIndex(child => child.type === "{");
  return open < 0 ? [] : container.children.slice(open + 1).filter(child => child.isNamed);
}

/** Plain (non-`@"..."`) declaration name, or null when it is escaped/absent. */
export function zigName(node: TreeSitterNode | null | undefined): string | null {
  return node && node.type === "identifier" && node.text && unescaped(node.text) ? node.text : null;
}

/** `const NAME = value;` — name is the first identifier, value follows `=`. */
export function zigBinding(node: TreeSitterNode): { nameNode: TreeSitterNode | null; value: TreeSitterNode | null } {
  const nameNode = node.namedChildren.find(child => child.type === "identifier") ?? null;
  const eq = node.children.findIndex(child => child.type === "=");
  const value = eq < 0 ? null : node.children.slice(eq + 1).find(child => child.isNamed && child.type !== "comment") ?? null;
  return { nameNode, value };
}

/**
 * Test names keep their source spelling, prefixed so they never collide with
 * callables: `test "name"` or `test decl`. Escapes stay verbatim; the symbol
 * gate refuses to treat escaped spellings as stable identities.
 */
export function zigTestName(node: TreeSitterNode): string | null {
  const label = node.namedChildren.find(child => child.type === "string" || child.type === "identifier");
  return label && label.text ? `test ${label.text}` : null;
}

function isPublic(node: TreeSitterNode): boolean {
  return node.children.some(child => child.type === "pub" || child.type === "export");
}

function importSource(value: TreeSitterNode | null): string | null {
  let node = value;
  while (node && node.type === "field_expression") node = node.childForFieldName("object");
  if (!node || node.type !== "builtin_function") return null;
  if (node.namedChildren[0]?.text !== "@import") return null;
  const arg = node.namedChildren[1]?.namedChildren[0];
  if (!arg || arg.type !== "string") return null;
  const parts = arg.namedChildren;
  return parts.length === 1 && parts[0].type === "string_content" ? parts[0].text : null;
}

const lineRange = (node: TreeSitterNode): [number, number] => [node.startPosition.row + 1, node.endPosition.row + 1];

/**
 * Zig extractor.
 *
 * - Named container literals (`const X = struct/enum/union/opaque {...}`) are
 *   classes named by their dotted container path (`Xdr.Reader`), with the
 *   range of the binding declaration.
 * - Every `fn` directly in a container body is a function whose `owner` is
 *   that dotted path ("" at file scope, null below an escaped container
 *   name). Methods are also listed in the container's `methods`.
 * - `test "..."` / `test decl` blocks are functions named `test "..."` /
 *   `test decl` owned by their container. Anonymous `test {}` has no identity.
 * - Containers inside function bodies, returned by type functions, or used
 *   as anonymous expressions are local and not extracted.
 */
export class ZigExtractor implements LanguageExtractor {
  readonly languageIds = ["zig"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    const walk = (container: TreeSitterNode, path: string[] | null, cls: StructuralAnalysis["classes"][number] | null) => {
      const owner = path === null ? null : path.join(".");
      const atFile = path !== null && path.length === 0;
      for (const member of zigMembers(container)) {
        if (member.type === "function_declaration") {
          const raw = member.childForFieldName("name");
          if (!raw?.text) continue;
          const name = raw.text;
          const params = (member.namedChildren.find(child => child.type === "parameters")?.namedChildren ?? [])
            .filter(child => child.type === "parameter")
            .map(child => child.childForFieldName("name")?.text)
            .filter((value): value is string => !!value);
          functions.push({ name, owner, lineRange: lineRange(member), params,
            returnType: member.childForFieldName("type")?.text });
          if (cls) cls.methods.push(name);
          if (atFile && isPublic(member)) exports.push({ name, lineNumber: member.startPosition.row + 1 });
        } else if (member.type === "test_declaration") {
          const name = zigTestName(member);
          if (name) functions.push({ name, owner, lineRange: lineRange(member), params: [] });
        } else if (member.type === "variable_declaration") {
          const { nameNode, value } = zigBinding(member);
          if (!nameNode?.text) continue;
          const source = importSource(value);
          if (source !== null) imports.push({ source, specifiers: [nameNode.text], lineNumber: member.startPosition.row + 1 });
          if (atFile && isPublic(member)) exports.push({ name: nameNode.text, lineNumber: member.startPosition.row + 1 });
          if (value && ZIG_CONTAINERS.has(value.type)) {
            const name = zigName(nameNode);
            const childPath = path === null || name === null ? null : [...path, name];
            let child: StructuralAnalysis["classes"][number] | null = null;
            if (childPath) {
              child = { name: childPath.join("."), lineRange: lineRange(member), methods: [], properties: [] };
              classes.push(child);
            }
            walk(value, childPath, child);
          }
        } else if (member.type === "container_field" && cls && !isZigPhantomField(member)) {
          const name = member.childForFieldName("name")?.text;
          if (name) cls.properties.push(name);
        }
      }
    };
    walk(rootNode, [], null);
    return { functions, classes, imports, exports };
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const stack: string[] = [];
    const visit = (node: TreeSitterNode) => {
      let pushed = false;
      if (node.type === "function_declaration") {
        const name = node.childForFieldName("name")?.text;
        if (name) { stack.push(name); pushed = true; }
      } else if (node.type === "test_declaration") {
        // Named tests are functions in extractStructure, so they are callers
        // too; an anonymous `test {}` has no identity to attribute calls to.
        const name = zigTestName(node);
        if (name) { stack.push(name); pushed = true; }
      } else if (node.type === "call_expression" && stack.length) {
        const callee = node.childForFieldName("function")?.text;
        if (callee) entries.push({ caller: stack[stack.length - 1], callee, lineNumber: node.startPosition.row + 1 });
      }
      for (const child of node.namedChildren) visit(child);
      if (pushed) stack.pop();
    };
    visit(rootNode);
    return entries;
  }
}
