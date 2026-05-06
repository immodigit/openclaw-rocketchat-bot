# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc -p tsconfig.build.json → dist/
npm test               # vitest run (Node environment, tests/**/*.test.ts)
npm run typecheck      # tsc --noEmit -p tsconfig.json
npm run debug:client   # Build + test REST login/connectivity (reads .env)
npm run debug:poll     # Build + single poll cycle (reads .env)
```

- `tsconfig.json` covers `src/` + `tests/` + `vitest.config.ts`; `tsconfig.build.json` extends it and only emits `src/` → `dist/`.
- Vitest globals are enabled (`types: ["vitest/globals"]`), so `describe`/`it`/`expect` work without imports in test files.
- `vitest.config.ts` sets `include: ["tests/**/*.test.ts"]` — test files must match this pattern.

## Architecture

This is an **OpenClaw channel plugin** (npm package `@laevateinzzl/openclaw-rocketchat-bot`) that bridges Rocket.Chat to the OpenClaw agent gateway. The plugin is loaded by OpenClaw at runtime — there is no standalone server, no Express, no database.

### Entry and registration

- `src/index.ts` — default export with `id: "rocketchat"` and a `register(api)` function.
- `src/plugin.ts` — the actual plugin object (`rocketchatPlugin`) with `.config`, `.gateway`, and `.outbound` blocks. Exports `registerRockeChatPlugin(api)`.
- `openclaw.plugin.json` — static manifest consumed by OpenClaw's plugin system (channel metadata, config JSON schema, UI hints).

### Data flow

```
Rocket.Chat server
  │
  ├─ REST polling (RestPollingTransport)
  │    └─ listSubscriptions → syncMessages → InboundEvent → onEvent
  │
  └─ WebSocket/DDP (RocketChatWebSocketTransport)
       └─ DDP connect → login → subscribe to rooms → stream-room-messages → InboundEvent → onEvent
              │
              ▼
  plugin.ts gateway.startAccount → shouldHandleInboundEvent() → dispatch path:
    ├─ channelRuntime path: sendReplyLifecycle() → dispatchInboundEventWithChannelRuntime()
    │     └─ resolveAgentRoute → formatAgentEnvelope → recordInboundSession → dispatchReplyWithBufferedBlockDispatcher
    │     └─ deliver callbacks (tool/block/final) update the same Rocket.Chat message incrementally
    └─ legacy path: runtime.channel.reply.handleInboundMessage()
```

### Reply lifecycle (`src/channel.ts`)

1. Post a `"思考中..."` placeholder message via `chat.postMessage`.
2. On each `tool`/`block`/`final` deliver callback, update that same message via `chat.update`.
3. If the run throws, the placeholder is replaced with an error message.
4. If no final update was produced, an empty fallback is sent as final.

### Transport abstraction (`src/inbound/types.ts`)

Both `RestPollingTransport` and `RocketChatWebSocketTransport` implement `InboundTransport` (`kind()`, `start()`, `stop()`). The choice is per-account, driven by `transport.mode` in config. The websocket transport uses DDP sub/unsub; when the subscription list changes, it does a one-shot REST refresh via `listSubscriptions(null)`.

### Mention gating (`src/channel.ts` — `shouldHandleInboundEvent`)

- Direct messages: always handled.
- Group/channel: handled only if the bot is explicitly @mentioned. Checks Rocket.Chat's `mentions` metadata first, then falls back to `@alias` text matching against `mentionNames` from config.

### Attachments (`src/inbound/attachments.ts`)

Rocket.Chat payloads can carry attachments in three shapes: `attachments[]`, `file`, `files[]`. `getMessageAttachmentInputs()` normalizes all three, merging `file` records with matching `attachment` records when possible. Each attachment is classified as `image` | `document` | `video` | `unknown` based on MIME type with extension fallback.

In `dispatchInboundEventWithChannelRuntime()`, attachments marked `source: "rocketchat-file"` are downloaded to temp files (via `RocketChatClient.downloadAttachmentToTempFile()`) and exposed as `MediaPath`/`MediaPaths`. Public attachments are passed through as `MediaUrl`/`MediaUrls`. Download failures don't block the message — the attachment is skipped with a structured warning.

### Config (`src/config.ts`)

Zod-validated account config with two discriminated unions:
- Auth: `token` (userId + accessToken) or `password` (username + password)
- Transport: `polling` (with `pollIntervalMs`) or `websocket` (with `reconnectDelayMs`)

### Checkpoints (`src/checkpoints.ts`)

`FileCheckpointStore` persists per-account state to `$OPENCLAW_STATE_DIR/rocketchat/<accountId>.json`. Tracks `updatedSince` timestamp for incremental sync and a sliding window of `recentMessageIds` for deduplication. The state dir resolution: `OPENCLAW_STATE_DIR` → `$OPENCLAW_HOME/.openclaw` → `~/.openclaw`.

### RocketChatClient (`src/client.ts`)

Thin wrapper around Rocket.Chat REST API:
- `POST /api/v1/login` or `GET /api/v1/me` for auth
- `GET /api/v1/subscriptions.get` for room listing
- `GET /api/v1/chat.syncMessages` for message sync
- `POST /api/v1/chat.postMessage` / `POST /api/v1/chat.update` for sending/editing
- Attachment download with auth headers to `mediaDir/inbound/`

Custom error classes: `RocketChatClientError`, `RocketChatRateLimitError` (with `retryAfterMs`).

### Outbound (`plugin.ts` outbound block)

`deliveryMode: "direct"` — `sendText()` creates a fresh client, initializes, posts a single message, and returns `{ ok, messageId }`. No streaming, no media outbound.

### Debug scripts

Both `debug:client` and `debug:poll` load `.env` from project root, then overlay explicit env vars. `debug:client` tests REST auth + subscription listing. `debug:poll` runs a single polling cycle and prints standardized inbound events plus the checkpoint.

### Dependencies

- Runtime: `zod` only (config validation)
- Dev: `typescript`, `vitest`, `@types/node`
- No React, no Express, no database drivers
