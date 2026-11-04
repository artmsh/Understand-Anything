import type { LanguageConfig } from "../types.js";

export const zigConfig = {
  id: "zig",
  displayName: "Zig",
  extensions: [".zig"],
  treeSitter: {
    wasmPackage: "@tree-sitter-grammars/tree-sitter-zig",
    wasmFile: "tree-sitter-zig.wasm",
  },
  concepts: [
    "comptime",
    "explicit allocators",
    "error unions and try/catch",
    "optionals",
    "defer/errdefer",
    "tagged unions",
    "slices and sentinel pointers",
    "files as structs",
    "generic types via type-returning functions",
    "test blocks",
  ],
  filePatterns: {
    entryPoints: ["src/main.zig", "src/root.zig", "build.zig"],
    barrels: ["src/root.zig"],
    tests: ["test/*.zig", "tests/*.zig"],
    config: ["build.zig", "build.zig.zon"],
  },
} satisfies LanguageConfig;
