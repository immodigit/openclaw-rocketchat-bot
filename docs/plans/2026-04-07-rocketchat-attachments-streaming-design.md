# Rocket.Chat Attachments and Streaming Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan after this design is approved.

**Goal:** Add inbound Rocket.Chat attachment support for images, common document formats, and mainstream video formats, and turn the current placeholder reply flow into real incremental message updates.

**Architecture:** Keep the existing Rocket.Chat auth, mention gating, transport split, and outbound REST send path. Extend inbound normalization to preserve attachment metadata and, when needed, materialize protected Rocket.Chat files into authenticated local paths before dispatch. Reuse OpenClaw's existing media-aware context fields for `channelRuntime`, and refactor the reply lifecycle so one placeholder message is updated from `tool`, `block`, and `final` events instead of only the final answer.

**Tech Stack:** TypeScript, Node.js built-ins, Rocket.Chat REST + DDP payloads, existing OpenClaw `channelRuntime`, existing OpenClaw media-understanding context conventions, Vitest.

---

## Scope

### In scope

- Normalize Rocket.Chat inbound attachments from both polling and websocket transports.
- Support these inbound attachment classes:
  - images
  - common document formats
  - mainstream video formats
- Preserve plain-text handling for messages without attachments.
- Feed attachment references into OpenClaw without inventing a new plugin-specific protocol.
- Prefer original attachment inputs over heavy preprocessing.
- Upgrade reply delivery from:
  - `post "思考中..." -> single final update`
  to:
  - `post "思考中..." -> incremental updates -> final update`
- Add tests for attachment mapping, runtime dispatch, and streaming update behavior.
- Update README capability notes and known limitations.

### Out of scope

- OCR, PDF page rendering, transcript extraction, frame extraction, or video/audio transcoding.
- Bot-originated outbound media sending to Rocket.Chat.
- Thread support, reactions, edit sync, or delete sync.
- Attachment caching beyond the minimal lifetime needed for one inbound dispatch.

## Current Baseline

The current repository is a v1 text-only Rocket.Chat channel plugin.

- `README.md` explicitly lists attachments as unsupported.
- `rocketchatPlugin.capabilities.media` is `false`.
- `InboundEvent` only carries text metadata.
- Both `src/inbound/polling.ts` and `src/inbound/websocket.ts` map only `msg` text into `InboundEvent`.
- `src/inbound-dispatch.ts` only writes `event.text` into `Body`, `BodyForAgent`, and `CommandBody`.
- `src/channel.ts` always posts one placeholder and immediately replaces it with the final answer.
- `dispatchReplyWithBufferedBlockDispatcher(...)` is currently consumed as final-only output inside this plugin.

This means Rocket.Chat messages with files can reach OpenClaw only as plain text today, and visible reply streaming is effectively disabled.

## Recommended Approach

### Recommended: Minimal attachment bridge + incremental placeholder updates

This phase should treat the Rocket.Chat plugin as an attachment transport adapter, not a media processing engine.

The plugin will:

1. Parse inbound Rocket.Chat attachments into a normalized plugin-local shape.
2. Classify them into image, document, video, or unknown.
3. Prefer original references:
   - use direct URLs when they are already usable
   - use authenticated temporary local files when Rocket.Chat attachment URLs require auth
4. Feed these references into OpenClaw through existing media-aware context fields on the `channelRuntime` path.
5. Keep compatibility on the legacy `handleInboundMessage(...)` path by forwarding attachment metadata there too.
6. Refactor placeholder handling so the same Rocket.Chat message is updated as visible intermediate output arrives.

This is the lowest-risk path because it matches the user's expectation of "use native multimodal models, avoid heavy preprocessing" while staying close to the current plugin structure.

### Rejected: Plugin-owned media extraction pipeline

Having this repository download every file, parse every document, transcode every video, and produce derived text/images would significantly expand scope and duplicate capabilities that already exist upstream in OpenClaw.

### Rejected: Final-only placeholder behavior

The current `思考中...` implementation does not satisfy the desired UX because it only becomes visible right before the final message replacement. Keeping this behavior would preserve the core bug the user wants fixed.

## Attachment Data Model

Add a normalized inbound attachment type local to this plugin, for example:

- `kind`: `"image" | "document" | "video" | "unknown"`
- `mimeType?: string`
- `fileName?: string`
- `url?: string`
- `tempPath?: string`
- `sizeBytes?: number`
- `source`: `"rocketchat-attachment" | "rocketchat-file"`
- `raw: unknown`

`InboundEvent` should gain:

- `attachments: InboundAttachment[]`

The plugin should not base64-embed all non-image content by default in this phase. For native multimodal inputs, preserving source references is the preferred behavior. Temporary local files are only needed when Rocket.Chat serves attachments behind authenticated URLs.

## Rocket.Chat Attachment Mapping

### Polling and websocket inputs

Both transports should read attachments from Rocket.Chat message payloads rather than infer them from text placeholders.

The mapper should inspect likely Rocket.Chat fields such as:

- `attachments`
- `file`
- `files`
- attachment-local title / description / link fields

The exact Rocket.Chat payload surface may vary between REST and DDP, so normalization must tolerate partial fields and preserve `raw`.

### Classification rules

Use MIME type first, then file extension fallback:

- image:
  - `image/*`
  - common extensions like `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tiff`
- video:
  - `video/*`
  - common extensions like `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.m4v`
- document:
  - `application/pdf`
  - common Office formats:
    - `.doc`, `.docx`
    - `.ppt`, `.pptx`
    - `.xls`, `.xlsx`
  - common text formats:
    - `.txt`, `.md`, `.csv`, `.json`
- unknown:
  - anything else

Unknown attachments should not crash dispatch. They can be forwarded as metadata and, if unsupported upstream, surfaced as skipped attachments in the final reply note.

## Runtime Integration

### Preferred path: `channelRuntime`

The `channelRuntime` path should be the primary integration target because OpenClaw already understands media-oriented context fields.

For this path, the plugin should populate fields such as:

- `MediaUrl`
- `MediaUrls`
- `MediaType`
- `MediaTypes`
- optionally `MediaPath`
- optionally `MediaPaths`

These fields are already consumed upstream by media-understanding and related attachment-aware logic.

Text fields remain unchanged:

- `Body`
- `BodyForAgent`
- `RawBody`
- `CommandBody`

The key principle is:

- text stays text
- attachments travel as media references

### Compatibility path: `handleInboundMessage(...)`

The legacy runtime callback path currently forwards:

- `text`
- `raw`
- `mentions`
- `reply(...)`

This path should be extended to also forward:

- `attachments`

The plugin-local type can be richer than the current callback signature because this repository controls the local runtime adapter type definition. If an upstream consumer ignores attachments, behavior still remains backward-compatible.

## Authenticated Attachment Materialization

Rocket.Chat attachment URLs may require the bot's auth token. Passing such URLs upstream as unauthenticated links is fragile.

The plugin should therefore use this decision order:

1. If the attachment reference is already a directly usable URL, keep it as `MediaUrl` / `MediaUrls`.
2. If the attachment requires Rocket.Chat auth, download it with the existing authenticated client and store it in a temporary local file.
3. Pass the local file path as `MediaPath` / `MediaPaths`.
4. Clean up temporary files after dispatch finishes.

This keeps the process minimal:

- no OCR
- no conversion
- no derived media
- only auth-preserving materialization when required

## Reply Streaming Design

### Current problem

The plugin currently ignores non-final reply events and only updates the placeholder once the final payload arrives.

### New lifecycle

Replace the current single-purpose helper with a small reply session abstraction:

1. Create placeholder message `思考中...`
2. Track its `messageId`
3. On first visible `tool` or `block` payload:
   - format visible content
   - update placeholder
4. On subsequent visible `tool` / `block` payloads:
   - update the same message again
5. On `final` payload:
   - update the same message one last time with the final formatted reply
6. If the run fails after the placeholder exists:
   - update the same message with a compact failure note instead of leaving it stuck in `思考中...`

Visible intermediate updates should come only from user-visible `tool` / `block` content. This phase does not require exposing hidden chain-of-thought.

## Error Handling

### Attachment failures

- Attachment errors must not block text-only delivery.
- Failures are per attachment, not per message.
- Failure classes to distinguish in logs:
  - mapping failure
  - unsupported MIME
  - authenticated download failure
  - size-limit rejection
  - upstream runtime rejection

### User-visible degradation

- text present, attachment failed:
  - continue with text and optionally prepend a short skipped-attachment note
- no text, all attachments failed:
  - return a compact user-visible failure reply
- some attachments succeed:
  - proceed with successful ones only

### Streaming failures

- placeholder created, intermediate update fails:
  - retry a small bounded number of times
- final update fails:
  - keep the last successful content and log the failure
- run aborts mid-stream:
  - replace placeholder with an explicit failure summary

## Testing Strategy

### Unit coverage

- attachment normalization helper
- MIME / extension classification
- polling attachment mapping
- websocket attachment mapping
- reply session lifecycle ordering

### Integration-style coverage

- `channelRuntime` dispatch writes text and media fields together
- legacy `handleInboundMessage(...)` payload includes attachments
- `tool`, `block`, and `final` all drive one placeholder message id

### Regression coverage

- plain-text messages still behave exactly as before
- mention gating still works
- self-authored message ignore rules still work
- polling and websocket both continue to pass existing tests

## Acceptance Criteria

- Rocket.Chat inbound messages with image attachments reach OpenClaw with usable media references.
- Rocket.Chat inbound messages with common document attachments reach OpenClaw with usable media references or clear, non-blocking degradation.
- Rocket.Chat inbound messages with mainstream video attachments reach OpenClaw with usable media references or clear, non-blocking degradation.
- Auth-protected Rocket.Chat attachments are materialized in a way that OpenClaw can still access during dispatch.
- Plain-text messages continue to work unchanged.
- A reply now visibly progresses:
  - placeholder appears first
  - at least one intermediate update can appear before the final output
  - final output replaces the same message
- No failure path leaves the conversation permanently stuck on `思考中...`
- README documents the new inbound-attachment support and any remaining limitations.
