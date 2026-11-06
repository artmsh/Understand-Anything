import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ZigExtractor, zigParseIsClean } from "../zig-extractor.js";
import { TreeSitterPlugin } from "../../tree-sitter-plugin.js";
import { zigConfig } from "../../../languages/configs/zig.js";

const require = createRequire(import.meta.url);
const fixture = readFileSync(fileURLToPath(new URL(
  "./fixtures/nfs-server.zig", import.meta.url)), "utf8");

let Parser: any;
let zigLang: any;
let plugin: TreeSitterPlugin;

beforeAll(async () => {
  const mod = await import("web-tree-sitter");
  Parser = mod.Parser;
  await Parser.init();
  zigLang = await mod.Language.load(require.resolve("@tree-sitter-grammars/tree-sitter-zig/tree-sitter-zig.wasm"));
  plugin = new TreeSitterPlugin([zigConfig]);
  await plugin.init();
});

function parse(code: string) {
  const parser = new Parser();
  parser.setLanguage(zigLang);
  const tree = parser.parse(code);
  return { tree, parser, root: tree.rootNode };
}

function structure(code: string) {
  const { tree, parser, root } = parse(code);
  const result = new ZigExtractor().extractStructure(root);
  tree.delete();
  parser.delete();
  return result;
}

describe("ZigExtractor", () => {
  it("names nested containers by dotted path and owns their methods", () => {
    const result = structure(fixture);
    expect(result.classes.map(cls => cls.name)).toEqual([
      "Xdr", "Xdr.Reader", "Xdr.Writer", "Rpc", "Rpc.MsgType", "Rpc.Cred",
      "Nfs4", "Nfs4.Server", "Nfs4.Server.Client", "Export",
    ]);
    const reader = result.classes.find(cls => cls.name === "Xdr.Reader")!;
    expect(reader.lineRange).toEqual([10, 23]);
    expect(reader.methods).toEqual(["remaining", "word"]);
    expect(reader.properties).toEqual(["buf", "pos"]);
    expect(result.functions.filter(fn => fn.name === "word").map(fn => fn.owner)).toEqual(["Xdr.Reader", "Xdr.Writer"]);
    expect(result.functions.find(fn => fn.name === "ownedBy")).toMatchObject({
      owner: "Nfs4.Server.Client", lineRange: [61, 63], params: ["c", "owner"], returnType: "bool",
    });
    expect(result.functions.find(fn => fn.name === "main")).toMatchObject({ owner: "", returnType: "!void" });
  });

  it("extracts named tests, @import bindings and pub exports", () => {
    const result = structure(fixture);
    expect(result.functions.filter(fn => fn.name.startsWith("test "))).toEqual([expect.objectContaining({
      name: 'test "a SEQUENCE that is not first gets NFS4ERR_SEQUENCE_POS and stops the compound"', owner: "",
    })]);
    expect(result.imports).toEqual([
      { source: "std", specifiers: ["std"], lineNumber: 3 },
      { source: "builtin", specifiers: ["builtin"], lineNumber: 4 },
    ]);
    expect(result.exports.map(e => e.name)).toEqual(["main"]);
  });

  it("does not extract local, anonymous or computed containers", () => {
    const result = structure(`fn Generic(comptime T: type) type { return struct { v: T, fn get(s: @This()) T { return s.v; } }; }
fn local() void { const Inner = struct { fn deep() void {} }; _ = Inner; }
const lam = struct { fn f() void {} }.f;
test decl { }
test { }
const S = struct { test "inner" {} };
`);
    expect(result.classes.map(cls => cls.name)).toEqual(["S"]);
    expect(result.functions.map(fn => [fn.owner, fn.name])).toEqual([
      ["", "Generic"], ["", "local"], ["", "test decl"], ["S", 'test "inner"'],
    ]);
    expect(result.classes[0].methods).toEqual([]);
  });

  it("leaves members of an escaped container name unowned", () => {
    const result = structure('const @"Esc" = struct { fn f() void {} };\nconst A = struct { fn @"weird fn"() void {} };\n');
    expect(result.classes.map(cls => cls.name)).toEqual(["A"]);
    expect(result.functions.map(fn => [fn.owner, fn.name])).toEqual([[null, "f"], ["A", '@"weird fn"']]);
  });

  it("extracts calls inside functions", () => {
    const { tree, parser, root } = parse("fn f(a: A) void { foo(); a.b(); A.c.d(1); }\n");
    expect(new ZigExtractor().extractCallGraph(root)).toEqual([
      { caller: "f", callee: "foo", lineNumber: 1 },
      { caller: "f", callee: "a.b", lineNumber: 1 },
      { caller: "f", callee: "A.c.d", lineNumber: 1 },
    ]);
    tree.delete();
    parser.delete();
  });

  it("attributes calls in named test bodies to the test", () => {
    const { tree, parser, root } = parse('test "t" { setup(); const g = struct { fn go() void { run(); } }; _ = g; }\ntest { anon(); }\n');
    expect(new ZigExtractor().extractCallGraph(root)).toEqual([
      { caller: 'test "t"', callee: "setup", lineNumber: 1 },
      { caller: "go", callee: "run", lineNumber: 1 },
    ]);
    tree.delete();
    parser.delete();
  });

  it("tolerates only the grammar's empty-container phantom field", () => {
    for (const code of ["const A = struct {};", "const B = enum {\n  // none\n};", "const C = union(enum) {};",
      "const D = packed struct(u8) {};", "const O = opaque {};"]) {
      const { tree, parser, root } = parse(code);
      expect(root.hasError).toBe(true);
      expect(zigParseIsClean(root)).toBe(true);
      expect(new ZigExtractor().extractStructure(root).classes[0].properties).toEqual([]);
      tree.delete();
      parser.delete();
    }
    for (const code of ["const x = 1", "const D = struct { a: u8 = , };", "fn f( void {}"]) {
      const { tree, parser, root } = parse(code);
      expect(zigParseIsClean(root)).toBe(false);
      tree.delete();
      parser.delete();
    }
  });

  it("strict analysis succeeds on empty containers and fails on real syntax errors", () => {
    expect(plugin.analyzeFileStrict("a.zig", "const A = struct {};\nfn f() void {}\n").status).toBe("succeeded");
    expect(plugin.analyzeFileStrict("a.zig", "const A = struct { a: u8 = , };\n").status).toBe("failed");
    const strict = plugin.analyzeFileStrict("src/main.zig", fixture);
    expect(strict.status).toBe("succeeded");
    expect(strict.language).toBe("zig");
    expect(strict.symbolEvidence?.classes.find(cls => cls.name === "Xdr.Reader")?.scope).toEqual({ kind: "class", name: "Xdr" });
    expect(strict.symbolEvidence?.classes.find(cls => cls.name === "Xdr")?.scope).toEqual({ kind: "file" });
    expect(strict.symbolEvidence?.coverage.gaps.some(gap => gap.reason.includes("no verified declaration-coverage adapter"))).toBe(false);
  });
});
