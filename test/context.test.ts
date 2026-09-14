/**
 * context.test.ts — Parent conversation context extraction for inherit_context spawns.
 *
 * buildParentContext shapes what a subagent sees from its parent; silent bugs
 * here would feed wrong context into spawns. Tests use realistic SessionEntry
 * shapes and a minimal ExtensionContext stub — no mocking beyond the one
 * getBranch() call the function actually reads.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildParentContext, extractText } from "../src/context.js";

function makeCtx(entries: unknown[]): ExtensionContext {
  return { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
}

function userMsg(content: string | unknown[]) {
  return { type: "message", message: { role: "user", content } };
}

function assistantMsg(blocks: unknown[]) {
  return { type: "message", message: { role: "assistant", content: blocks } };
}

describe("extractText", () => {
  it("joins multiple text blocks with newlines", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("filters out non-text blocks (tool_use, etc.)", () => {
    expect(
      extractText([
        { type: "text", text: "keep" },
        { type: "tool_use", name: "x", input: {} },
        { type: "text", text: "also keep" },
      ]),
    ).toBe("keep\nalso keep");
  });

  it("treats a text block with missing text field as empty", () => {
    expect(extractText([{ type: "text" }, { type: "text", text: "x" }])).toBe("\nx");
  });

  it("returns empty string for an empty content array", () => {
    expect(extractText([])).toBe("");
  });
});

describe("buildParentContext", () => {
  it("returns empty string for an empty branch", () => {
    expect(buildParentContext(makeCtx([]))).toBe("");
  });

  it("returns empty string when no entries produce extractable content", () => {
    // toolResult is skipped, empty-summary compaction is skipped
    const out = buildParentContext(
      makeCtx([
        { type: "message", message: { role: "tool_result", content: "..." } },
        { type: "compaction", summary: "" },
      ]),
    );
    expect(out).toBe("");
  });

  it("wraps a user+assistant exchange with the parent-context header and task footer", () => {
    const out = buildParentContext(
      makeCtx([userMsg("hello"), assistantMsg([{ type: "text", text: "hi back" }])]),
    );
    expect(out).toContain("# Parent Conversation Context");
    expect(out).toContain("[User]: hello");
    expect(out).toContain("[Assistant]: hi back");
    expect(out).toMatch(/# Your Task \(below\)\n$/);
    // Entries are joined with a blank line, preserving conversation order
    expect(out).toContain("[User]: hello\n\n[Assistant]: hi back");
  });

  it("accepts user messages whose content is content-blocks (not just a string)", () => {
    const out = buildParentContext(makeCtx([userMsg([{ type: "text", text: "from blocks" }])]));
    expect(out).toContain("[User]: from blocks");
  });

  it("includes compaction summary and prunes pre-compaction history", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("orig question"),
        { type: "compaction", summary: "we discussed X" },
        assistantMsg([{ type: "text", text: "follow-up" }]),
      ]),
    );
    expect(out).not.toContain("orig question");
    expect(out).toContain("[Summary]: we discussed X");
    expect(out).toContain("[Assistant]: follow-up");
  });

  it("preserves kept pre-compaction entries when firstKeptEntryId is specified", () => {
    const out = buildParentContext(
      makeCtx([
        { id: "msg-1", type: "message", message: { role: "user", content: "dropped early msg" } },
        { id: "msg-2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "kept assistant msg" }] } },
        { type: "compaction", summary: "we discussed previous items", firstKeptEntryId: "msg-2" },
        { id: "msg-3", type: "message", message: { role: "user", content: "post-compaction msg" } },
      ]),
    );
    expect(out).not.toContain("dropped early msg");
    expect(out).toContain("[Summary]: we discussed previous items");
    expect(out).toContain("[Assistant]: kept assistant msg");
    expect(out).toContain("[User]: post-compaction msg");
  });

  it("handles multiple compactions by keeping only the latest compaction boundary", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("very old turn"),
        { type: "compaction", summary: "first compaction summary" },
        userMsg("middle turn"),
        { type: "compaction", summary: "second compaction summary" },
        assistantMsg([{ type: "text", text: "latest turn" }]),
      ]),
    );
    expect(out).not.toContain("very old turn");
    expect(out).not.toContain("first compaction summary");
    expect(out).not.toContain("middle turn");
    expect(out).toContain("[Summary]: second compaction summary");
    expect(out).toContain("[Assistant]: latest turn");
  });

  it("skips compaction entries with whitespace-only summaries", () => {
    const out = buildParentContext(
      makeCtx([
        { type: "compaction", summary: "   \n  " },
        assistantMsg([{ type: "text", text: "active message" }]),
      ]),
    );
    expect(out).not.toContain("[Summary]");
    expect(out).toContain("[Assistant]: active message");
  });

  it("prefers sessionManager.buildContextEntries() when available", () => {
    const customEntries = [
      { type: "compaction", summary: "runtime pruned summary" },
      { type: "message", message: { role: "user", content: "runtime pruned user" } },
    ];
    const ctx = {
      sessionManager: {
        buildContextEntries: () => customEntries,
        getBranch: () => [userMsg("should not appear from getBranch")],
      },
    } as unknown as ExtensionContext;
    const out = buildParentContext(ctx);
    expect(out).not.toContain("should not appear from getBranch");
    expect(out).toContain("[Summary]: runtime pruned summary");
    expect(out).toContain("[User]: runtime pruned user");
  });
  it("skips tool_result messages — they're too verbose for inherited context", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("real user"),
        { type: "message", message: { role: "tool_result", content: "noisy tool output" } },
        assistantMsg([{ type: "text", text: "real assistant" }]),
      ]),
    );
    expect(out).not.toContain("noisy tool output");
    expect(out).toContain("[User]: real user");
    expect(out).toContain("[Assistant]: real assistant");
  });

  it("trims and skips whitespace-only messages", () => {
    const out = buildParentContext(
      makeCtx([userMsg("   \n  "), assistantMsg([{ type: "text", text: "non-empty" }])]),
    );
    expect(out).not.toMatch(/\[User\]:/);
    expect(out).toContain("[Assistant]: non-empty");
  });

  it("ignores assistant messages whose only content is non-text blocks", () => {
    // Assistant emitted only a tool_use — nothing extractable, so it shouldn't appear
    const out = buildParentContext(
      makeCtx([
        userMsg("question"),
        assistantMsg([{ type: "tool_use", name: "x", input: {} }]),
      ]),
    );
    expect(out).toContain("[User]: question");
    expect(out).not.toContain("[Assistant]:");
  });

  it("handles assistant messages with plain string content without throwing", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("hello"),
        { type: "message", message: { role: "assistant", content: "direct string response" } },
      ]),
    );
    expect(out).toContain("[User]: hello");
    expect(out).toContain("[Assistant]: direct string response");
  });

  it("handles assistant and user messages with null, undefined, or non-array content gracefully", () => {
    const out = buildParentContext(
      makeCtx([
        { type: "message", message: { role: "user", content: null } },
        { type: "message", message: { role: "assistant", content: undefined } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "valid text" }] } },
      ]),
    );
    expect(out).toContain("[Assistant]: valid text");
  });

  it("includes branch_summary entries alongside compaction summaries", () => {
    const out = buildParentContext(
      makeCtx([
        { type: "branch_summary", summary: "summary of branched exploration" },
        userMsg("what happened next"),
      ]),
    );
    expect(out).toContain("[Summary]: summary of branched exploration");
    expect(out).toContain("[User]: what happened next");
  });

  it("does not re-include older compaction summaries in reverse order when firstKeptEntryId spans an earlier compaction", () => {
    const out = buildParentContext(
      makeCtx([
        { id: "msg-0", type: "message", message: { role: "user", content: "epoch 0" } },
        { id: "comp-1", type: "compaction", summary: "summary of epoch 0", firstKeptEntryId: "msg-0" },
        { id: "msg-1", type: "message", message: { role: "user", content: "epoch 1" } },
        { id: "comp-2", type: "compaction", summary: "summary of epoch 1", firstKeptEntryId: "comp-1" },
        assistantMsg([{ type: "text", text: "latest reply" }]),
      ]),
    );
    expect(out).toContain("[Summary]: summary of epoch 1");
    expect(out).not.toContain("[Summary]: summary of epoch 0");
    expect(out).toContain("[User]: epoch 1");
    expect(out).toContain("[Assistant]: latest reply");
  });
});
