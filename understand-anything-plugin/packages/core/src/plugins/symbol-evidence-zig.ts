import type { StructuralAnalysis } from "../types.js";
import type { TreeSitterNode as Node } from "./extractors/types.js";
import type { SymbolEvidence, SymbolEvidenceEntry } from "./symbol-evidence.js";
import { UNKNOWN_SCOPE, namedScope, type SymbolScope } from "./symbol-scopes.js";
import { ZIG_CONTAINERS, isZigPhantomField, zigBinding, zigMembers, zigName, zigTestName } from "./extractors/zig-extractor.js";

/** Values that can be neither a callable nor a type with members. */
const INERT_VALUES = new Set(["integer", "float", "string", "multiline_string", "character", "boolean",
  "null", "undefined", "unreachable", "error_set_declaration"]);
/** Field types that can never be called: `pos: usize`, enum tags, union tags. */
const INERT_FIELD_TYPES = new Set(["builtin_type"]);

/**
 * Zig declaration coverage. Zig has no runtime method installation: the
 * declarations of a container are its literal members. Ownership is purely
 * lexical (the dotted container path), so the walk follows container bodies
 * only. Surfaces that can add or alias declarations without spelling them —
 * `usingnamespace`, a container-level binding to a computed or aliased value,
 * a function returning `type`, a callable-typed field — are recorded as
 * coverage gaps scoped to the identities they could affect. Reads such as
 * `@field`, `@hasDecl`, strings and parameters are not declarations.
 */
export function collectZigSymbolEvidence(root: Node, structure: StructuralAnalysis): SymbolEvidence {
  const gaps: SymbolEvidenceEntry[] = [];
  const classes: SymbolEvidence["classes"] = [];
  const range = (node: Node): [number, number] => [node.startPosition.row + 1, node.endPosition.row + 1];
  const gap = (node: Node, kind: SymbolEvidenceEntry["kind"], scope: SymbolScope, name: string | null, reason: string) =>
    gaps.push({ kind, scope, name, lineRange: range(node), reason });
  const sameRange = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  const extractedFunction = (name: string, owner: string | null, node: Node) =>
    structure.functions.some(fn => fn.name === name && fn.owner === owner && sameRange(fn.lineRange, range(node)));

  const walk = (container: Node, path: string[] | null) => {
    const owner = path === null ? null : path.join(".");
    const scope: SymbolScope = path === null ? UNKNOWN_SCOPE : namedScope(owner);
    for (const member of zigMembers(container)) {
      switch (member.type) {
        case "function_declaration": {
          const raw = member.childForFieldName("name");
          const name = zigName(raw);
          if (name === null) {
            gap(member, "callable", scope, null, "Unresolved declaration name");
            break;
          }
          if (path === null) gap(member, "callable", UNKNOWN_SCOPE, name, "Unresolved source receiver ownership");
          else if (!extractedFunction(name, owner, member)) {
            gap(member, "callable", scope, name, "Callable declaration is not covered by structural extraction");
          }
          // `fn T(comptime ...) type` builds a container whose members are not
          // literal declarations of any named container in this file.
          if (member.childForFieldName("type")?.text === "type") {
            gap(member, null, path === null ? UNKNOWN_SCOPE : namedScope([...path, name].join(".")), null,
              "Members of a type-returning function are not statically enumerable");
          }
          break;
        }
        case "test_declaration": {
          const name = zigTestName(member);
          if (name !== null && (path === null || !extractedFunction(name, owner, member))) {
            gap(member, "callable", scope, name, "Test declaration is not covered by structural extraction");
          }
          break;
        }
        case "variable_declaration": {
          const { nameNode, value } = zigBinding(member);
          const name = zigName(nameNode);
          if (value && ZIG_CONTAINERS.has(value.type)) {
            if (name === null || path === null) {
              gap(member, "class", path === null ? UNKNOWN_SCOPE : scope, name, name === null
                ? "Unresolved declaration name" : "Unresolved declaring type");
              walk(value, null);
              break;
            }
            // A nested container is owned by its parent (`Xdr` owns `Reader`);
            // the structure names it by the full path `Xdr.Reader`.
            const qualified = [...path, name].join(".");
            classes.push({ name: qualified, scope, lineRange: range(member) });
            if (!structure.classes.some(cls => cls.name === qualified && sameRange(cls.lineRange, range(member)))) {
              gap(member, "class", scope, name, "Class declaration is not covered by structural extraction");
            }
            walk(value, [...path, name]);
            break;
          }
          if (value && INERT_VALUES.has(value.type)) break;
          // An alias (`const run = other.run;`), import, or computed type
          // (`const T = Generic(u8);`) may name a callable or a type here...
          gap(member, null, scope, name, name === null ? "Unresolved declaration name"
            : "Container-level binding may alias a callable or type");
          // ...whose own members are not literal declarations.
          if (name !== null) gap(member, null, path === null ? UNKNOWN_SCOPE : namedScope([...path, name].join(".")), null,
            "Members of an aliased or computed type are not statically enumerable");
          break;
        }
        case "container_field": {
          if (isZigPhantomField(member)) break;
          const type = member.childForFieldName("type");
          if (!type || INERT_FIELD_TYPES.has(type.type)) break;
          gap(member, "callable", scope, zigName(member.childForFieldName("name")),
            "Property callability is not structurally verified");
          break;
        }
        case "using_namespace_declaration":
          gap(member, null, scope, null, "usingnamespace imports declarations that are not spelled in this container");
          break;
        case "comptime_declaration":
        case "comment":
          break;
        default:
          // The backing/tag type of `packed struct(u8)` / `union(enum(u8))`
          // precedes `{` and is not returned by zigMembers. Anything else in
          // a member position is an unrecognised declaration surface.
          gap(member, null, scope, null, `Declaration surface is not covered: ${member.type}`);
      }
    }
  };
  walk(root, []);
  return { version: 2, effects: [], functions: [], classes, coverage: { profile: "structural-declarations-v1", gaps } };
}
