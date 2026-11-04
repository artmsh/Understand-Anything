# Zig Language Prompt Snippet

## Key Concepts

- **Files are structs**: every `.zig` file is an implicit struct; its top-level `const`/`fn` are that struct's declarations
- **Named containers**: `const Name = struct/enum/union/opaque { ... }` — a container literal bound to a name; containers nest (`Xdr.Reader`)
- **Methods are container functions**: a `fn` inside a container body; `self: *T` is just a first parameter
- **comptime**: compile-time evaluation; `fn List(comptime T: type) type` returns a type (generics)
- **Error unions and optionals**: `!T`, `error{...}`, `try`/`catch`, `?T` with `orelse`
- **Explicit allocators**: memory-owning APIs take an `std.mem.Allocator`
- **defer/errdefer**: scoped cleanup on every exit or only on error exit
- **Tagged unions**: `union(enum)` with exhaustive `switch`
- **Test blocks**: `test "description" { ... }` lives beside the code it tests; `zig build test` runs them

## Import Patterns

- `const std = @import("std");` — the standard library
- `const xdr = @import("xdr.zig");` — another file, relative to the importing file
- `const mod = @import("mod");` — a named module wired up in `build.zig`
- `pub const Reader = @import("rpc.zig").Reader;` — re-export a declaration

## File Patterns

- `build.zig` — build graph (executables, modules, test steps); `build.zig.zon` — package manifest and dependencies
- `src/main.zig` — executable entry point (`pub fn main`)
- `src/root.zig` — library root module

## Naming

Name class and function nodes by their dotted container path, as the structural extraction does: `Xdr.Reader` for a nested container and `Xdr.Reader.word` for its method. Name test functions exactly as extracted: `test "description"`.

## Summary Style

> "Defines the XDR encoder/decoder: `Xdr.Reader` and `Xdr.Writer` read and write big-endian words, opaque bytes, and padding over a byte slice."
