# Release-pinned local layers: 0.21.0-local.1

Baseline: upstream `26c23bb7db7b181ff3f4233cdc4e5bc9fefb6f04` (release 0.21.0).
Source: `/home/stan/pi-downstream/sources/pi-subagents-0.86`, audited HEAD `9a182a9`.
This candidate does not activate live settings or implement autonomous continuation.
No post-release master features were imported.

## Final disposition audit

| Source | Candidate | Disposition |
| --- | --- | --- |
| `ccd1df8` | generic `child-context.ts` marker | HCOM supervisor bridge retired. Keep concurrency-safe ALS child isolation and `Symbol.for("pi-subagents:child-session-context")` registry for duplicate-copy/non-HCOM consumers; do not retain bridge provider/capability symbols. |
| `1231ef8` | `7a3de51` | Retain opt-in hard limits and frontmatter/invocation/nested/schedule/workflow plumbing. |
| `81cb28c` | `1c69f26` | Retain tool-less limit mode tests. |
| `b0252da` | `e23a839` | Adapt r0009 lifecycle: hard-limit veto, zero grace, structured completion, loop guards, resume governance. Preserve upstream exposure-aware scope and nested gate. |
| `97315fb` | `1363204` | Retain r0013 coordination and selected r0012 recovery behavior. |
| `6f24867` | `ccc5061` | Retain compacted parent context inheritance via context builder, not transcript mutation. |
| `29cbf11` | `d986fcc` | Retain bounded memory injection. |
| `a90f3eb` | `1527d3e` | Retain structured recovery and saved tool scope across resume. |
| `9a182a9` | not replayed | Obsolete mention-clone transcript mutation: upstream already seeds `getBranch()` into `SessionManager.inMemory`. |

Accepted exclusions remain unchanged: r0010 autonomous continuation, GEN-042, and `get_subagent_result` caching. Workflow ceiling/resume plumbing and fixtures remain retained even if workflows are disabled in deployed settings.

## Upstream 0.21 adaptations

- Keep trust/exposure awareness, MCP/codemode loaders, upstream nested delegation, and foreground handoff.
- Preserve `nestedCallGate` alongside the local session tool controller. `beforeToolCall` alone is insufficient for `ctx.executeTool`; nested gate checks the controller's current `inScope()` (including hard-limit scope and StructuredOutput exception).
- Mock contexts now implement SDK 1.1 `isProjectTrusted` and `getToolDefinition`; controller fixtures receive the nested gate. No tests were deleted.
- Mention clone retains upstream `getBranch()` path. Regression supplies a selected branch with compaction plus an alternate leaf visible only in `getEntries`; only the selected branch is passed to the in-memory manager.
- Generic child marker publishes the ALS instance, never a global boolean. Independent generic consumer test confirms child visibility and sibling/parent isolation. No external consumer compatibility is inferred beyond that contract.

## Evidence / reproduction

In this directory:

```
npm ci
npm run check
npm run build
npx vitest run test/child-context.test.ts test/mention-clone.test.ts test/agent-runner.test.ts
```

- SDK 1.1 typecheck and Biome lint pass (182 files).
- Final full suite: 117 files, 2359 tests passed, 7 skipped (existing skips retained); build also passes. Background evidence task `bg_bvcq_mv5uygrb_13` exited 0.
- Final targeted suite: 3 files, 206 tests passed, including selected-branch/compacted mention clone, generic shared marker, and nested hard-veto/resume.
- Nested control: temporarily replace `nestedCallGate.allows = (name) => inScope().has(name)` with unconditional true; `agent-runner.test.ts -t 'vetoes nested executeTool'` fails because blocked result becomes undefined. Restoring the gate passes. Control log: `/tmp/pi-subagents-nested-veto-control.log`. No control mutation remains.
- Earlier full run log: `/tmp/pi-subagents-candidate-check2.log`.

## Acceptance boundary

Unit suites include real SDK/faux-provider integration, but are not a real-model/provider acceptance run. Real-environment acceptance remains incomplete pending an isolated installed candidate session on the normal model/provider path. Live settings have not been modified; do not interpret passing mocks or faux-provider runs as live activation approval. The final full-suite/build terminal output was inspected and passed; this does not waive the real-provider acceptance gate.
