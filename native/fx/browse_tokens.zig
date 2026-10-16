const std = @import("std");
const io_mod = @import("../shared/io.zig");
const validator = @import("api_key_validator.zig");
const model_catalog = @import("../gateway/model_catalog.zig");
const gateway = @import("../../builtins/gateway.zig");

// Caller owns the returned bytes. Secrets travel only over the child's stdin.
fn call(alloc: std.mem.Allocator, value: anytype) ![]u8 {
    const io = io_mod.getIo();
    const helper = io_mod.getenv("BROWSE_TOKEN_HELPER") orelse return error.HelperMissing;
    const node = io_mod.getenv("BROWSE_NODE") orelse return error.NodeMissing;
    const input = try std.json.Stringify.valueAlloc(alloc, value, .{});
    defer {
        @memset(input, 0);
        alloc.free(input);
    }
    var child = try std.process.spawn(io, .{
        .argv = &.{ node, "--disable-warning=ExperimentalWarning", helper },
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .ignore,
    });
    defer if (child.id != null) child.kill(io);
    try child.stdin.?.writeStreamingAll(io, input);
    child.stdin.?.close(io);
    child.stdin = null;
    var buffer: [4096]u8 = undefined;
    var reader = child.stdout.?.reader(io, &buffer);
    const output = try reader.interface.allocRemaining(alloc, .limited(4 * 1024 * 1024));
    errdefer alloc.free(output);
    _ = try child.wait(io);
    return output;
}

pub fn save(alloc: std.mem.Allocator, key: []const u8, provider: u8, base_url: []const u8) validator.Result {
    const providers = [_][]const u8{ "vercel", "openai", "anthropic", "google", "xai", "openrouter", "custom" };
    if (provider >= providers.len) return .refused;
    const result = call(alloc, .{ .op = "save", .provider = providers[provider], .apiKey = key, .endpoint = base_url }) catch return .unavailable;
    defer alloc.free(result);
    return if (std.mem.eql(u8, result, "accepted")) .accepted else if (std.mem.eql(u8, result, "refused")) .refused else .unavailable;
}

pub fn endpoint(alloc: std.mem.Allocator, value: []const u8) ![]u8 {
    const result = try call(alloc, .{ .op = "endpoint", .endpoint = value });
    if (std.mem.eql(u8, result, "unavailable")) {
        alloc.free(result);
        return error.InvalidEndpoint;
    }
    return result;
}

pub fn catalog(alloc: std.mem.Allocator, input: model_catalog.FetchInput) std.mem.Allocator.Error!model_catalog.ProviderResult {
    const result = call(alloc, .{ .op = "catalog" }) catch return .{ .failure = .{ .category = .runtime } };
    defer alloc.free(result);
    const parsed = gateway.parseModelCatalogForView(alloc, result, input.view) catch return .{ .failure = .{ .category = .malformed_response } };
    return .{ .catalog = parsed };
}
