import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CheckpointState } from "./checkpoints.js";
import { parsePluginConfig, type PluginAccountConfig } from "./config.js";

type PollingTransportConfig = Extract<PluginAccountConfig["transport"], { mode: "polling" }>;

export type DebugAccountConfig = Omit<PluginAccountConfig, "transport"> & {
  accountId: string;
  transport: PollingTransportConfig;
};

type DebugEnv = Record<string, string | undefined>;

export async function loadDebugEnv(options: {
  cwd?: string;
  env?: DebugEnv;
}): Promise<DebugEnv> {
  const cwd = options.cwd ?? process.cwd();
  const explicitEnv = options.env ?? process.env;
  const fileEnv = await readDotEnvFile(join(cwd, ".env"));

  return {
    ...fileEnv,
    ...explicitEnv
  };
}

export function resolveDebugAccountConfigFromEnv(env: DebugEnv): DebugAccountConfig {
  const accountId = env.ROCKETCHAT_ACCOUNT_ID?.trim() || "debug";
  const serverUrl = requiredEnv(env, "ROCKETCHAT_SERVER_URL");
  const authMode = requiredEnv(env, "ROCKETCHAT_AUTH_MODE");
  const mentionNames = splitCsv(env.ROCKETCHAT_MENTION_NAMES);
  const pollIntervalMs = parsePositiveInteger(env.ROCKETCHAT_POLL_INTERVAL_MS, 3000);

  const auth =
    authMode === "token"
      ? {
          mode: "token" as const,
          userId: requiredEnv(env, "ROCKETCHAT_USER_ID"),
          accessToken: requiredEnv(env, "ROCKETCHAT_ACCESS_TOKEN")
        }
      : authMode === "password"
        ? {
            mode: "password" as const,
            username: requiredEnv(env, "ROCKETCHAT_USERNAME"),
            password: requiredEnv(env, "ROCKETCHAT_PASSWORD")
          }
        : invalidAuthMode(authMode);

  const config = parsePluginConfig({
    accounts: {
      [accountId]: {
        enabled: true,
        serverUrl,
        auth,
        transport: {
          mode: "polling",
          pollIntervalMs
        },
        mentionNames
      }
    }
  });
  const account = config.accounts[accountId];
  if (account.transport.mode !== "polling") {
    throw new Error("Debug account transport must be polling");
  }

  return {
    accountId,
    enabled: account.enabled,
    serverUrl: account.serverUrl,
    auth: account.auth,
    transport: account.transport,
    mentionNames: account.mentionNames,
    forceThread: account.forceThread
  };
}

export function createMemoryCheckpointStore(initialUpdatedSince: string | null) {
  let state: CheckpointState = {
    updatedSince: initialUpdatedSince,
    recentMessageIds: []
  };

  return {
    async read(_accountId: string): Promise<CheckpointState> {
      return {
        updatedSince: state.updatedSince,
        recentMessageIds: [...state.recentMessageIds]
      };
    },
    async write(_accountId: string, nextState: CheckpointState): Promise<void> {
      state = {
        updatedSince: nextState.updatedSince,
        recentMessageIds: [...nextState.recentMessageIds]
      };
    },
    async hasSeen(_accountId: string, messageId: string): Promise<boolean> {
      return state.recentMessageIds.includes(messageId);
    },
    async markSeen(_accountId: string, messageId: string): Promise<void> {
      if (!state.recentMessageIds.includes(messageId)) {
        state = {
          ...state,
          recentMessageIds: [...state.recentMessageIds, messageId]
        };
      }
    }
  };
}

function requiredEnv(env: DebugEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable "${key}"`);
  }

  return value;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer value "${value}"`);
  }

  return parsed;
}

function invalidAuthMode(authMode: string): never {
  throw new Error(
    `Unsupported ROCKETCHAT_AUTH_MODE "${authMode}". Expected "token" or "password".`
  );
}

async function readDotEnvFile(filePath: string): Promise<DebugEnv> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseDotEnv(raw);
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    throw error;
  }
}

function parseDotEnv(raw: string): DebugEnv {
  const env: DebugEnv = {};

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    const value = normalized.slice(separatorIndex + 1).trim();
    env[key] = stripWrappingQuotes(value);
  }

  return env;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
