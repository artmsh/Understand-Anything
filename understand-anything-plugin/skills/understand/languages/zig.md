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

Graph nodes name Zig symbols by their dotted container path: class `Xdr.Reader`, method `Xdr.Reader.word`, with `contains` edges following the nesting. Test functions keep their source spelling: `test "description"`. The structural extraction lists classes by full path and functions by bare name plus `owner`, their container path; the file-analyzer joins the two (see its "Zig identity" rules).

## Summary Style

> "Defines the XDR encoder/decoder: `Xdr.Reader` and `Xdr.Writer` read and write big-endian words, opaque bytes, and padding over a byte slice."
