const std = @import("std");
const io_mod = @import("../shared/io.zig");
const types = @import("../shared/types.zig");
const worker_runtime = @import("../agent/worker_runtime.zig");
const stream = @import("../agent/runtime/assistant_stream.zig");
const callbacks = @import("app_callbacks.zig");
const sessions = @import("app_session_runtime.zig");
const finalization = @import("../agent/runtime/finalization.zig");
const lifecycle = @import("../agent/runtime/lifecycle.zig");
const runtime_deps = @import("../agent/runtime/deps.zig");
const alloc = std.heap.c_allocator;

fn send(file: std.Io.File, value: anytype) !void {
    const bytes = try std.json.Stringify.valueAlloc(alloc, value, .{});
    defer alloc.free(bytes);
    try file.writeStreamingAll(io_mod.getIo(), bytes);
    try file.writeStreamingAll(io_mod.getIo(), "\n");
}

const Event = struct {
    type: []const u8,
    delta: []const u8 = "",
    actionId: []const u8 = "",
    name: []const u8 = "",
    text: []const u8 = "",
    result: []const u8 = "",
    state: []const u8 = "",
    options: []const []const u8 = &.{},
};

pub fn process(comptime App: type, app: *App, job: worker_runtime.QueuedPrompt, helper: []const u8, lifecycle_context: lifecycle.LifecycleContext) !void {
    var deps = callbacks.Bindings(App).agentRuntimeDeps(app);
    var guard = finalization.TurnFinalizationGuard.init(&deps, job.turn_id, lifecycle_context);
    defer guard.deinit();
    errdefer guard.finish(.failed, null, null) catch {};
    const Question = struct {
        fn stopping(ctx: *anyopaque) bool {
            const instance: *App = @ptrCast(@alignCast(ctx));
            instance.worker.worker_mutex.lockUncancelable(io_mod.getIo());
            defer instance.worker.worker_mutex.unlock(io_mod.getIo());
            return instance.worker.worker_stop_requested;
        }

        fn ask(ctx: *anyopaque, question: []const u8, labels: []const []const u8) !?[][]u8 {
            const instance: *App = @ptrCast(@alignCast(ctx));
            const options = try alloc.alloc(types.QuestionOption, labels.len);
            defer alloc.free(options);
            for (labels, 0..) |label, index| options[index] = .{ .label = label };
            return instance.worker.requestQuestionBatchAnswerBlocking(alloc, &.{.{ .question = question, .options = options }});
        }
    };
    try processCore(&deps, callbacks.Bindings(App).semanticPresentationSink(app), job, helper, sessions.Runtime(App).activeSessionId(app), &app.worker.worker_cancel_requested, &guard, .{ .ctx = app, .ask = Question.ask, .stopping = Question.stopping });
}

const QuestionHandler = struct {
    ctx: *anyopaque,
    ask: *const fn (*anyopaque, []const u8, []const []const u8) anyerror!?[][]u8,
    stopping: *const fn (*anyopaque) bool,
};

pub fn processCore(deps: *const runtime_deps.AgentRuntimeDeps, semantic: ?stream.SemanticPresentationSink, job: worker_runtime.QueuedPrompt, helper: []const u8, session_id: ?[]const u8, cancelled: *std.atomic.Value(bool), guard: *finalization.TurnFinalizationGuard, question: ?QuestionHandler) !void {
    const io = io_mod.getIo();
    const node = io_mod.getenv("BROWSE_NODE") orelse return error.BrowseNodeMissing;
    var child = try std.process.spawn(io, .{
        .argv = &.{ node, "--disable-warning=ExperimentalWarning", helper },
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .ignore,
    });
    defer child.kill(io);
    const input = child.stdin.?;
    try send(input, .{
        .type = "start",
        .protocol = 1,
        .session = session_id,
        .prompt = job.prompt,
        .images = job.images,
        .model = job.model,
        .provider = job.provider.label(),
        .apiKey = job.api_key,
        .accountId = job.account_id,
        .team = job.gateway_team,
        .settings = job.agent_settings,
        .mode = @tagName(job.permission_mode),
    });
    var presentation = stream.StreamChunkContext{
        .hooks = deps,
        .semantic_presentation = semantic,
        .turn_id = job.turn_id,
    };
    defer presentation.deinit();
    const buffer = try alloc.alloc(u8, 2 * 1024 * 1024);
    defer alloc.free(buffer);
    var reader = child.stdout.?.reader(io, buffer);
    var cancel_sent = false;
    while (try reader.interface.takeDelimiter('\n')) |line| {
        const parsed = try std.json.parseFromSlice(Event, alloc, line, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const event = parsed.value;
        if (question) |handler| {
            if (handler.stopping(handler.ctx)) {
                try finishPrompt(deps, guard, job, &presentation, .paused);
                return;
            }
        }
        if (!cancel_sent) {
            if (deps.take_steering_boundary) |take| {
                var arena = std.heap.ArenaAllocator.init(alloc);
                defer arena.deinit();
                switch (try take(deps.ctx, arena.allocator(), job.turn_id, if (cancelled.load(.seq_cst)) .cancelled else .model)) {
                    .continue_turn => |messages| for (messages) |message| {
                        try send(input, .{ .type = "steer", .text = message });
                    },
                    .interrupt => {
                        try send(input, .{ .type = "cancel" });
                        cancel_sent = true;
                    },
                    else => {},
                }
            }
        }
        if (!cancel_sent and cancelled.load(.seq_cst)) {
            try send(input, .{ .type = "cancel" });
            cancel_sent = true;
        }
        if (std.mem.eql(u8, event.type, "text_delta")) {
            stream.onStreamContentChunk(&presentation, event.delta);
        } else if (std.mem.eql(u8, event.type, "tool_start")) {
            try stream.flushAssistantStream(&presentation);
            try deps.push_tool_lifecycle(deps.ctx, .{ .authoritative_started = .{
                .id = .{ .turn_id = job.turn_id, .call_id = event.actionId },
                .reconciles_provisional_call_id = null,
                .tool_name = event.name,
                .activity_kind = .command,
            } });
        } else if (std.mem.eql(u8, event.type, "tool_done") or std.mem.eql(u8, event.type, "tool_error")) {
            try deps.push_tool_lifecycle(deps.ctx, .{ .terminal = .{
                .id = .{ .turn_id = job.turn_id, .call_id = event.actionId },
                .outcome = .{
                    .kind = if (std.mem.eql(u8, event.type, "tool_error")) .failed else .completed,
                    .summary = event.name,
                },
                .result = event.result,
            } });
        } else if (std.mem.eql(u8, event.type, "question")) {
            try stream.flushAssistantStream(&presentation);
            if (question) |handler| {
                if (try handler.ask(handler.ctx, event.text, event.options)) |answers| {
                    defer {
                        for (answers) |answer| alloc.free(answer);
                        alloc.free(answers);
                    }
                    if (answers.len > 0) try send(input, .{ .type = "answer", .text = answers[0] });
                } else {
                    if (handler.stopping(handler.ctx)) {
                        try finishPrompt(deps, guard, job, &presentation, .paused);
                        return;
                    }
                    try send(input, .{ .type = "cancel" });
                    cancel_sent = true;
                }
            } else {
                const notice = try types.dupeSemanticNotice(alloc, .{ .topic = "browse", .tone = .information, .body = event.text });
                try deps.push_event(deps.ctx, .{ .semantic_notice = notice });
                try send(input, .{ .type = "detach" });
            }
        } else if (std.mem.eql(u8, event.type, "notice")) {
            const notice = try types.dupeSemanticNotice(alloc, .{ .topic = "browse", .tone = .information, .body = event.text });
            try deps.push_event(deps.ctx, .{ .semantic_notice = notice });
        } else if (std.mem.eql(u8, event.type, "settled")) {
            var continued = false;
            if (deps.take_steering_boundary) |take| {
                var arena = std.heap.ArenaAllocator.init(alloc);
                defer arena.deinit();
                switch (try take(deps.ctx, arena.allocator(), job.turn_id, .finalizing)) {
                    .continue_turn => |messages| {
                        for (messages) |message| try send(input, .{ .type = "steer", .text = message });
                        continued = messages.len > 0;
                    },
                    else => {},
                }
            }
            if (!continued) try send(input, .{ .type = "finish" });
        } else if (std.mem.eql(u8, event.type, "finished")) {
            try stream.flushAssistantStream(&presentation);
            const outcome: types.TurnPresentationOutcome = if (std.mem.eql(u8, event.state, "cancelled")) .interrupted else if (std.mem.eql(u8, event.state, "failed")) .failed else if (std.mem.eql(u8, event.state, "waiting") or std.mem.eql(u8, event.state, "paused")) .paused else .completed;
            try finishPrompt(deps, guard, job, &presentation, outcome);
            return;
        }
    }
    return error.BrowseWorkerDisconnected;
}

fn finishPrompt(deps: *const runtime_deps.AgentRuntimeDeps, guard: *finalization.TurnFinalizationGuard, job: worker_runtime.QueuedPrompt, presentation: *stream.StreamChunkContext, outcome: types.TurnPresentationOutcome) !void {
    try stream.flushAssistantStream(presentation);
    const turn: types.HistoryTurn = .{ .assistant = .{
        .user = .{ .text = job.prompt, .images = job.images },
        .assistant = @constCast(presentation.raw_text.items),
    } };
    const finished = try types.dupeFinishedPrompt(alloc, .{ .turn = turn, .terminal_outcome = outcome });
    deps.propagate_history_turn(deps.ctx, turn) catch |err| {
        types.freeFinishedPrompt(alloc, finished);
        return err;
    };
    try guard.finish(outcome, null, finished);
}
