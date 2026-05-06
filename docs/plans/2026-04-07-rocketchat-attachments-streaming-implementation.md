# Rocket.Chat Attachments and Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add inbound Rocket.Chat attachment support for images, common document formats, and mainstream video formats, and upgrade placeholder replies to real incremental updates.

**Architecture:** Extend inbound event normalization with a plugin-local attachment model, materialize protected Rocket.Chat files only when necessary, and feed the resulting media references into existing OpenClaw runtime context fields. Refactor the reply lifecycle so one placeholder message is updated from `tool`, `block`, and `final` events instead of only the final answer.

**Tech Stack:** TypeScript, Node.js built-ins, Rocket.Chat REST + DDP payloads, existing OpenClaw `channelRuntime`, Vitest.

---

### Task 1: Save the approved design and plan docs

**Files:**
- Create: `docs/plans/2026-04-07-rocketchat-attachments-streaming-design.md`
- Create: `docs/plans/2026-04-07-rocketchat-attachments-streaming-implementation.md`

**Step 1: Verify the design matches the approved scope**

Confirm the docs cover:

- images, documents, and videos
- minimal attachment bridging
- authenticated attachment materialization
- true incremental placeholder updates

**Step 2: Commit**

```bash
git add docs/plans/2026-04-07-rocketchat-attachments-streaming-design.md docs/plans/2026-04-07-rocketchat-attachments-streaming-implementation.md
git commit -m "docs: 规划附件接入与流式回复"
```

### Task 2: Add the failing attachment normalization tests

**Files:**
- Create: `tests/inbound-attachments.test.ts`
- Create: `src/inbound/attachments.ts`

**Step 1: Write the failing tests**

Cover:

- image attachment is classified as `image`
- PDF / Office / text file attachments are classified as `document`
- MP4 / MOV / WebM attachments are classified as `video`
- missing MIME falls back to extension
- unsupported payload becomes `unknown` without throwing

Example test shape:

```ts
it("classifies mp4 attachments as video", () => {
  const attachments = normalizeInboundAttachments([
    { title: "demo.mp4", title_link: "https://chat.example.com/file/demo.mp4" }
  ]);

  expect(attachments).toEqual([
    expect.objectContaining({
      kind: "video",
      fileName: "demo.mp4"
    })
  ]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run tests/inbound-attachments.test.ts
```

Expected: FAIL because attachment normalization does not exist yet.

**Step 3: Write minimal implementation**

Create `src/inbound/attachments.ts` with:

- `InboundAttachment` type
- `normalizeInboundAttachments(...)`
- MIME / extension classification helpers

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run tests/inbound-attachments.test.ts
```

Expected: PASS

### Task 3: Extend Rocket.Chat client payload types for attachments

**Files:**
- Modify: `src/client.ts`
- Modify: `tests/client.test.ts`

**Step 1: Write the failing test**

Add a test fixture showing that `RocketChatMessageRecord` can carry:

- attachment arrays
- file metadata
- attachment URLs / titles / MIME hints

The test should compile against the new shape and prove `requestJson(...)`-derived message objects do not get rejected by typing.

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run tests/client.test.ts
```

Expected: FAIL or typecheck failure because the current message record is text-only.

**Step 3: Write minimal implementation**

Extend `RocketChatMessageRecord` with the attachment-related fields needed by the normalizer, for example:

- `attachments?`
- `file?`
- `files?`

Keep the fields optional and tolerant of partial payloads.

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run tests/client.test.ts
```

Expected: PASS

### Task 4: Map attachments in polling and websocket transports

**Files:**
- Modify: `src/inbound/types.ts`
- Modify: `src/inbound/polling.ts`
- Modify: `src/inbound/websocket.ts`
- Modify: `tests/polling.test.ts`
- Modify: `tests/websocket.test.ts`

**Step 1: Write the failing tests**

Add coverage that:

- polling events include `attachments`
- websocket events include `attachments`
- plain-text events still yield `attachments: []`

Example expectation:

```ts
expect(event.attachments).toEqual([
  expect.objectContaining({
    kind: "image",
    url: expect.stringContaining("/file-upload/")
  })
]);
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- --run tests/polling.test.ts
npm test -- --run tests/websocket.test.ts
```

Expected: FAIL because `InboundEvent` has no attachment field yet.

**Step 3: Write minimal implementation**

- add `attachments: InboundAttachment[]` to `InboundEvent`
- call `normalizeInboundAttachments(...)` in both transport mappers
- default to an empty array when no attachments exist

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- --run tests/polling.test.ts
npm test -- --run tests/websocket.test.ts
```

Expected: PASS

### Task 5: Add authenticated attachment materialization for runtime dispatch

**Files:**
- Modify: `src/client.ts`
- Modify: `src/inbound-dispatch.ts`
- Create: `tests/inbound-dispatch.attachments.test.ts`

**Step 1: Write the failing tests**

Cover:

- public attachment URL is forwarded as `MediaUrl` / `MediaUrls`
- auth-protected Rocket.Chat file is downloaded and forwarded as `MediaPath` / `MediaPaths`
- mixed attachments populate `MediaTypes`
- no attachment failure blocks plain text dispatch

Example expectation:

```ts
expect(finalizeInboundContext).toHaveBeenCalledWith(
  expect.objectContaining({
    MediaUrls: ["https://chat.example.com/public/report.pdf"],
    MediaTypes: ["application/pdf"]
  })
);
```

and for protected files:

```ts
expect(finalizeInboundContext).toHaveBeenCalledWith(
  expect.objectContaining({
    MediaPaths: [expect.stringContaining("/tmp/")]
  })
);
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run tests/inbound-dispatch.attachments.test.ts
```

Expected: FAIL because dispatch currently only writes text fields.

**Step 3: Write minimal implementation**

- add a small authenticated file materialization helper
- expose a client helper for attachment download when the original URL requires auth
- populate:
  - `MediaUrl` / `MediaUrls`
  - `MediaType` / `MediaTypes`
  - `MediaPath` / `MediaPaths` when needed
- clean up temp files after dispatch

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run tests/inbound-dispatch.attachments.test.ts
```

Expected: PASS

### Task 6: Extend the legacy runtime callback payload with attachments

**Files:**
- Modify: `src/plugin.ts`
- Modify: `tests/plugin-gateway.test.ts`

**Step 1: Write the failing test**

Add a test where an inbound event carries attachments and the plugin forwards them into `handleInboundMessage(...)`.

Example expectation:

```ts
expect(handleInboundMessage).toHaveBeenCalledWith(
  expect.objectContaining({
    attachments: [
      expect.objectContaining({ kind: "document" })
    ]
  })
);
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run tests/plugin-gateway.test.ts
```

Expected: FAIL because the callback payload currently has no `attachments`.

**Step 3: Write minimal implementation**

- extend the local `RuntimeReplyHandler` payload type in `src/plugin.ts`
- pass `event.attachments` through the legacy path

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run tests/plugin-gateway.test.ts
```

Expected: PASS

### Task 7: Write the failing streaming placeholder tests

**Files:**
- Modify: `tests/channel.test.ts`
- Modify: `tests/inbound-dispatch.test.ts`
- Modify: `src/channel.ts`
- Modify: `src/format.ts`

**Step 1: Write the failing tests**

Cover:

- placeholder is posted once
- first `tool` payload updates the placeholder
- subsequent `block` payload updates the same message id
- `final` payload performs the last update
- failure after placeholder creation replaces `思考中...` with an error note

Example expectation:

```ts
expect(client.postMessage).toHaveBeenCalledTimes(1);
expect(client.updateMessage).toHaveBeenNthCalledWith(
  1,
  "room-1",
  "placeholder-1",
  "正在调用工具..."
);
expect(client.updateMessage).toHaveBeenNthCalledWith(
  2,
  "room-1",
  "placeholder-1",
  "最终答案"
);
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- --run tests/channel.test.ts
npm test -- --run tests/inbound-dispatch.test.ts
```

Expected: FAIL because the plugin only updates once on final output.

**Step 3: Write minimal implementation**

- refactor `sendReplyLifecycle(...)` into a small reply-session helper
- add formatting helpers for visible partial output and final fallback output
- keep one placeholder `messageId` for the whole reply lifecycle

**Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- --run tests/channel.test.ts
npm test -- --run tests/inbound-dispatch.test.ts
```

Expected: PASS

### Task 8: Wire `tool` / `block` / `final` events into the reply session

**Files:**
- Modify: `src/inbound-dispatch.ts`
- Modify: `src/plugin.ts`
- Modify: `tests/inbound-dispatch.test.ts`

**Step 1: Write the failing test**

Add a test where `dispatchReplyWithBufferedBlockDispatcher(...)` emits:

- one `tool`
- one `block`
- one `final`

and assert that the plugin forwards all visible stages into the same placeholder session.

**Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run tests/inbound-dispatch.test.ts
```

Expected: FAIL because the current implementation drops all non-final events.

**Step 3: Write minimal implementation**

- stop filtering out non-final events in `dispatcherOptions.deliver(...)`
- normalize each payload with a `kind`
- route `tool`, `block`, and `final` into the reply session

**Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run tests/inbound-dispatch.test.ts
```

Expected: PASS

### Task 9: Update user-facing documentation

**Files:**
- Modify: `README.md`

**Step 1: Write doc updates**

Update:

- implemented capabilities
- current limitations
- attachment support notes
- streaming reply behavior
- any remaining known degradation for unsupported attachment cases

**Step 2: Verify README accuracy**

Check that the README matches:

- actual attachment classes supported
- actual reply behavior
- any capability flags intentionally left unchanged

### Task 10: Run targeted verification

**Files:**
- Modify: none

**Step 1: Run targeted tests**

Run:

```bash
npm test -- --run tests/inbound-attachments.test.ts
npm test -- --run tests/polling.test.ts
npm test -- --run tests/websocket.test.ts
npm test -- --run tests/inbound-dispatch.attachments.test.ts
npm test -- --run tests/inbound-dispatch.test.ts
npm test -- --run tests/channel.test.ts
npm test -- --run tests/plugin-gateway.test.ts
```

Expected: PASS

**Step 2: Commit**

```bash
git add src/client.ts src/inbound/types.ts src/inbound/attachments.ts src/inbound/polling.ts src/inbound/websocket.ts src/inbound-dispatch.ts src/plugin.ts src/channel.ts src/format.ts tests/inbound-attachments.test.ts tests/polling.test.ts tests/websocket.test.ts tests/inbound-dispatch.attachments.test.ts tests/inbound-dispatch.test.ts tests/channel.test.ts tests/plugin-gateway.test.ts README.md
git commit -m "feat: 支持附件入模与流式回复"
```

### Task 11: Run full verification

**Files:**
- Modify: none

**Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS

**Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS

**Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS
