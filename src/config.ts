import { z } from "zod";

const tokenAuthSchema = z
  .object({
    mode: z.literal("token"),
    userId: z.string().min(1),
    accessToken: z.string().min(1)
  })
  .strict();

const passwordAuthSchema = z
  .object({
    mode: z.literal("password"),
    username: z.string().min(1),
    password: z.string().min(1)
  })
  .strict();

const pollingTransportSchema = z
  .object({
    mode: z.literal("polling"),
    pollIntervalMs: z.number().int().min(1000).default(3000)
  })
  .strict();

const websocketTransportSchema = z
  .object({
    mode: z.literal("websocket"),
    reconnectDelayMs: z.number().int().min(1000).default(5000)
  })
  .strict();

const transportSchema = z.preprocess(
  (value) => value ?? { mode: "polling" },
  z.discriminatedUnion("mode", [pollingTransportSchema, websocketTransportSchema])
);

const accountSchema = z
  .object({
    enabled: z.boolean(),
    serverUrl: z.string().min(1),
    auth: z.union([tokenAuthSchema, passwordAuthSchema]),
    transport: transportSchema,
    mentionNames: z.array(z.string().min(1)).default([]),
    /**
     * If true (default), every bot reply lives inside a thread:
     * thread mentions reuse the existing thread, top-level mentions
     * create a new thread anchored on the trigger message. Set to
     * false to fall back to "thread when triggered in thread, else
     * reply top-level".
     */
    forceThread: z.boolean().default(true),
    /**
     * Optional explicit OpenClaw agent id this account should dispatch
     * inbound traffic to. When unset, the channel runtime's default
     * routing (typically the `main` agent) is used. When set, the
     * resolved route is rewritten so the agent's own session store and
     * session key are used — letting different bot identities map onto
     * different agent loops, workspaces, and personas.
     */
    agent: z.string().min(1).optional(),
    /**
     * When true (default), incoming voice notes / audio attachments are
     * downloaded and transcribed via the OpenAI-compatible Whisper
     * endpoint (see OPENCLAW_TRANSCRIBE_* env vars). The transcription
     * is merged into the message text BEFORE the mention filter runs,
     * so a voice note where the user says "Hey @andi …" gets routed
     * normally even though the original `msg` field is empty. Falls
     * back to no-transcription when the API key is missing.
     */
    transcribeAudio: z.boolean().default(true)
  })
  .strict();

const pluginConfigSchema = z
  .object({
    accounts: z.record(z.string().min(1), accountSchema)
  })
  .strict();

export type PluginConfig = z.infer<typeof pluginConfigSchema>;
export type PluginAccountConfig = PluginConfig["accounts"][string];

/**
 * Replace `${ENV_VAR}` placeholders with the matching `process.env` value
 * anywhere inside the config tree. Strings without a placeholder pass
 * through unchanged. Missing env vars become empty strings, which then
 * trip zod's `min(1)` so the failure stays loud.
 */
function substituteEnvVars(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name) => env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteEnvVars(item, env));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteEnvVars(v, env);
    }
    return out;
  }
  return value;
}

export function parsePluginConfig(input: unknown): PluginConfig {
  return pluginConfigSchema.parse(substituteEnvVars(input));
}
