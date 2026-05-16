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
    forceThread: z.boolean().default(true)
  })
  .strict();

const pluginConfigSchema = z
  .object({
    accounts: z.record(z.string().min(1), accountSchema)
  })
  .strict();

export type PluginConfig = z.infer<typeof pluginConfigSchema>;
export type PluginAccountConfig = PluginConfig["accounts"][string];

export function parsePluginConfig(input: unknown): PluginConfig {
  return pluginConfigSchema.parse(input);
}
