import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { TreeSitterPlugin, builtinLanguageConfigs } from '../../../understand-anything-plugin/packages/core/dist/index.js';
import { compareFileSymbols } from '../../../understand-anything-plugin/skills/understand/validate-incremental-symbols.mjs';

// Zig rows of the symbol-loss verification matrix (docs/incremental/symbol-loss-validation.md).
// The fixture is a trimmed single-file NFSv4.1 server: nested containers,
// same-name methods in sibling containers, computed types and string tests.
const fixture = readFileSync(new URL(
  '../../../understand-anything-plugin/packages/core/src/plugins/extractors/__tests__/fixtures/nfs-server.zig', import.meta.url), 'utf8');
const path = 'src/main.zig';
const WORD = '        fn word(r: *Reader) Error!u32 {\n            if (r.remaining() < 4) return error.Truncated;\n            r.pos += 4;\n            return std.mem.readInt(u32, r.buf[r.pos - 4 ..][0..4], .big);\n        }\n';
const WRITER = fixture.slice(fixture.indexOf('    const Writer = struct {'), fixture.indexOf('};\n\nconst Rpc') );
const TEST = fixture.slice(fixture.indexOf('test "a SEQUENCE'));

let parser;
beforeAll(async () => {
  parser = new TreeSitterPlugin(builtinLanguageConfigs.filter(config => config.treeSitter));
  await parser.init();
});

const without = (text, part) => {
  expect(text.includes(part)).toBe(true);
  return text.replace(part, '');
};
// Insertion points: after Reader's fields, after Writer's fields, before main.
const ANCHORS = {
  Reader: '        pos: usize = 0,\n\n        fn remaining',
  Writer: '        pos: usize = 0,\n\n        fn word(w',
  file: 'pub fn main',
};
/** Reader.word deleted, optionally with `extra` inserted at an anchor. */
const readerWithout = (extra = '', into = 'Reader') => {
  const source = without(fixture, WORD);
  const anchor = ANCHORS[into];
  expect(source.includes(anchor)).toBe(true);
  return source.replace(anchor, into === 'file' ? `${extra}\n${anchor}` : anchor.replace('\n\n', `\n${extra}\n\n`));
};

const fn = (name, extra = {}) => ({ id: `function:${path}:${name}`, type: 'function', name, filePath: path, ...extra });
const cls = (name, extra = {}) => ({ id: `class:${path}:${name}`, type: 'class', name, filePath: path, ...extra });

function classify(current, { before = fixture, nodes = [fn('Xdr.Reader.word')], edges = [], newNodes = [], newEdges = [] } = {}) {
  const base = parser.analyzeFileStrict(path, before);
  const head = parser.analyzeFileStrict(path, current);
  return {
    base, head,
    result: compareFileSymbols({ filePath: path, nodes, edges }, { filePath: path, nodes: newNodes, edges: newEdges }, base, head),
  };
}
const status = (current, options) => classify(current, options).result.missing.map(entry => entry.status);

describe('Zig declaration coverage', () => {
  it('parses the fixture strictly with a declared coverage adapter', () => {
    const { base } = classify(fixture);
    expect(base.status).toBe('succeeded');
    expect(base.language).toBe('zig');
    expect(base.symbolEvidence.coverage.gaps.map(gap => gap.reason))
      .not.toContain('This language has no verified declaration-coverage adapter');
  });

  it('confirms a deleted method and keeps a same-name method of a sibling container', () => {
    expect(status(readerWithout())).toEqual(['deleted']);
    // Graph lost Writer.word while the source still declares it.
    expect(status(readerWithout(), { nodes: [fn('Xdr.Reader.word'), fn('Xdr.Writer.word')] }))
      .toEqual(['deleted', 'still-present']);
  });

  it('preserves an unchanged method, moved lines and an ID spelling change', () => {
    const moved = `\n\n\n${fixture}`;
    expect(classify(moved, { nodes: [fn('Xdr.Reader.word')], newNodes: [fn('word', { id: `func:${path}:Xdr::Reader::word` })] })
      .result).toMatchObject({ missing: [], replacements: [{ oldId: `function:${path}:Xdr.Reader.word`, newId: `func:${path}:Xdr::Reader::word` }] });
    expect(status(fixture)).toEqual(['still-present']);
  });

  it('maps unqualified graph names through class containment, including nested classes', () => {
    const nodes = [cls('Xdr'), cls('Reader'), fn('word')];
    const edges = [
      { type: 'contains', source: `class:${path}:Xdr`, target: `class:${path}:Reader` },
      { type: 'contains', source: `class:${path}:Reader`, target: `function:${path}:word` },
    ];
    expect(status(readerWithout(), { nodes, edges, newNodes: nodes.slice(0, 2), newEdges: edges.slice(0, 1) })).toEqual(['deleted']);
    // Without containment `word` is ambiguous between Reader and Writer.
    expect(status(readerWithout(), { nodes: [fn('word')] })).toEqual(['unknown']);
  });

  it('confirms deletion of a whole nested container and its methods', () => {
    const nodes = [cls('Xdr.Writer'), fn('Xdr.Writer.word')];
    expect(status(without(fixture, WRITER), { nodes })).toEqual(['deleted', 'deleted']);
    expect(status(fixture, { nodes })).toEqual(['still-present', 'still-present']);
  });

  it('keeps free functions distinct from methods of the same name', () => {
    const before = fixture.replace('pub fn main', 'fn word() void {}\npub fn main');
    const line = before.split('\n').indexOf('fn word() void {}') + 1;
    expect(status(readerWithout(), { before, nodes: [fn('word', { lineRange: [line, line] })] })).toEqual(['deleted']);
    expect(status(before, { before, nodes: [fn('word', { lineRange: [line, line] })] })).toEqual(['still-present']);
    expect(status(readerWithout('fn word() void {}', 'file'), { nodes: [fn('Xdr.Reader.word')] })).toEqual(['deleted']);
  });

  it.each([
    ['usingnamespace', '        pub usingnamespace Mixin;', 'unknown'],
    ['alias binding', '        pub const word = Other.word;', 'unknown'],
    ['alias to another name', '        pub const other = Other.word;', 'deleted'],
    ['callable field', '        word: *const fn (*Reader) u32,', 'unknown'],
    ['callable field of another name', '        other: *const fn (*Reader) u32,', 'deleted'],
    ['inert field', '        word: u32 = 0,', 'deleted'],
    ['escaped declaration name', '        fn @"word"(r: *Reader) u32 { return r.pos; }', 'unknown'],
    ['integer constant', '        const word = 4;', 'deleted'],
    ['@field read', '        fn other(r: *Reader) usize { return @field(r, "word"); }', 'deleted'],
    ['string and parameter', '        fn other(word: []const u8) usize { return "word".len + word.len; }', 'deleted'],
    ['comptime block', '        comptime { _ = 1; }', 'deleted'],
    ['empty nested container', '        const Empty = struct {};', 'deleted'],
  ])('scopes %s in the same container', (_, extra, expected) => {
    const outcome = classify(readerWithout(extra));
    expect(outcome.head.status).toBe('succeeded');
    expect(outcome.result.missing.map(entry => entry.status)).toEqual([expected]);
    if (expected === 'unknown') expect(outcome.result.missing[0].evidence)
      .toContainEqual(expect.objectContaining({ scope: { kind: 'class', name: 'Xdr.Reader' } }));
  });

  it.each([
    ['usingnamespace', '        pub usingnamespace Mixin;'],
    ['alias binding', '        pub const word = Other.word;'],
    ['callable field', '        word: *const fn (*Writer) u32 = undefined,'],
    ['escaped declaration name', '        fn @"word"(w: *Writer) u32 { return w.pos; }'],
  ])('does not let %s in a sibling container preserve Reader.word', (_, extra) => {
    expect(status(readerWithout(extra, 'Writer'))).toEqual(['deleted']);
  });

  it('treats computed and type-returning replacements as uncertain', () => {
    const struct = fixture.slice(fixture.indexOf('    const Reader = struct {'), fixture.indexOf('    const Writer'));
    // Reader becomes a computed type: its members are not enumerable.
    const computed = fixture.replace(struct, '    const Reader = Generic(u8);\n\n');
    expect(status(computed, { nodes: [cls('Xdr.Reader'), fn('Xdr.Reader.word')] })).toEqual(['unknown', 'unknown']);
    // Reader becomes a generic: `fn Reader(comptime T: type) type`.
    const generic = fixture.replace(struct, `    fn Reader(comptime T: type) type {\n        return struct { v: T, fn word(r: @This()) u32 { _ = r; return 0; } };\n    }\n\n`);
    expect(status(generic, { nodes: [fn('Xdr.Reader.word')] })).toEqual(['unknown']);
    // A switch-selected type (`const Raw = switch (...) { ... }`) is not a declaration of Raw's members.
    const raw = fixture.replace('    const Raw = switch', '    const Raw2 = struct { fn ino() void {} };\n    const Raw = switch');
    expect(status(fixture, { before: raw, nodes: [fn('Export.Raw2.ino')] })).toEqual(['deleted']);
  });

  it('identifies string-named tests by their source spelling', () => {
    const name = 'test "a SEQUENCE that is not first gets NFS4ERR_SEQUENCE_POS and stops the compound"';
    expect(status(without(fixture, TEST), { nodes: [fn(name)] })).toEqual(['deleted']);
    expect(status(fixture, { nodes: [fn(name)] })).toEqual(['still-present']);
    expect(classify(fixture, { nodes: [fn(name)], newNodes: [fn(name)] }).result.missing).toEqual([]);
    // Renaming a test deletes the old identity.
    expect(status(fixture.replace('stops the compound', 'stops'), { nodes: [fn(name)] })).toEqual(['deleted']);
    // Escaped spellings never establish a stable identity.
    const escaped = 'test "tab\\there"';
    expect(status(without(fixture, TEST), { before: `${fixture}\n${escaped} {}\n`, nodes: [fn(escaped)] })).toEqual(['unknown']);
    // An analyzer-invented name has no source identity.
    expect(status(without(fixture, TEST), { nodes: [fn('test_sequence_pos')] })).toEqual(['unknown']);
  });

  it('does not confirm deletions from invalid or unowned evidence', () => {
    expect(status(`${readerWithout()}\nconst Broken = struct { a: u8 = , };\n`)).toEqual(['unknown']);
    // Members of an escaped container have unresolved ownership.
    expect(status(readerWithout().replace('const Xdr = struct', 'const @"Xdr" = struct'))).toEqual(['unknown']);
    const state = classify(readerWithout());
    for (const symbolEvidence of [undefined, { version: 1 }]) {
      expect(compareFileSymbols({ filePath: path, nodes: [fn('Xdr.Reader.word')], edges: [] }, { filePath: path, nodes: [], edges: [] },
        state.base, { ...state.head, symbolEvidence }).missing[0].status).toBe('unknown');
    }
  });

  it('rejects a reused graph ID that now names a different identity', () => {
    expect(classify(readerWithout(), { newNodes: [fn('Xdr.Reader.word', { name: 'Xdr.Writer.word' })] }).result.missing[0])
      .toMatchObject({ status: 'unknown', reason: 'The old graph ID is reused by a different or unresolved source identity' });
  });
});
