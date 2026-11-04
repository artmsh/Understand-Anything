//! Trimmed from a single-file NFSv4.1 server: nested containers, methods,
//! enums, error sets, aliases, computed types and string-named tests.
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;

const Xdr = struct {
    const Error = error{ Truncated, NoSpace, BadLength };

    const Reader = struct {
        buf: []const u8,
        pos: usize = 0,

        fn remaining(r: *const Reader) usize {
            return r.buf.len - r.pos;
        }

        fn word(r: *Reader) Error!u32 {
            if (r.remaining() < 4) return error.Truncated;
            r.pos += 4;
            return std.mem.readInt(u32, r.buf[r.pos - 4 ..][0..4], .big);
        }
    };

    const Writer = struct {
        buf: []u8,
        pos: usize = 0,

        fn word(w: *Writer, v: u32) Error!void {
            if (w.buf.len - w.pos < 4) return error.NoSpace;
            std.mem.writeInt(u32, w.buf[w.pos..][0..4], v, .big);
            w.pos += 4;
        }
    };
};

const Rpc = struct {
    const version = 2;
    const MsgType = enum(u32) { call = 0, reply = 1 };

    const Cred = struct {
        flavor: u32,
        machine: []const u8 = "",
    };

    fn parseCall(r: *Xdr.Reader) !Cred {
        _ = try r.word();
        return .{ .flavor = try r.word() };
    }
};

const Nfs4 = struct {
    const Server = struct {
        boot: u64,
        clients: [8]?Client = @splat(null),

        const Client = struct {
            clientid: u64,
            owner_len: u8,

            fn ownedBy(c: *const Client, owner: []const u8) bool {
                return c.owner_len == owner.len;
            }
        };

        fn compound(s: *Server, args: []const u8) usize {
            _ = s;
            return args.len;
        }

        fn sequenceOp(s: *Server) void {
            s.boot += 1;
        }
    };
};

const Export = struct {
    const Raw = switch (builtin.os.tag) {
        .linux => extern struct { ino: u64 },
        else => extern struct { ino: u32 },
    };

    fn lstat(path: []const u8) usize {
        return path.len;
    }
};

pub fn main() !void {
    var server: Nfs4.Server = .{ .boot = 1 };
    _ = server.compound("");
}

test "a SEQUENCE that is not first gets NFS4ERR_SEQUENCE_POS and stops the compound" {
    var server: Nfs4.Server = .{ .boot = 1 };
    server.sequenceOp();
    try std.testing.expectEqual(@as(u64, 2), server.boot);
}
