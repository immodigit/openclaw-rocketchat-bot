import { describe, expect, it } from "vitest";

import { attachmentMediaDir, checkpointPathForAccount, rocketchatPlugin } from "../src/plugin.js";

describe("checkpointPathForAccount", () => {
  it("uses OPENCLAW_HOME when provided", () => {
    expect(
      checkpointPathForAccount("main", {
        env: {
          OPENCLAW_HOME: "/tmp/openclaw-home"
        },
        homedir: () => "/Users/tester"
      })
    ).toBe("/tmp/openclaw-home/.openclaw/rocketchat/main.json");
  });

  it("prefers OPENCLAW_STATE_DIR over OPENCLAW_HOME", () => {
    expect(
      checkpointPathForAccount("main", {
        env: {
          OPENCLAW_HOME: "/tmp/openclaw-home",
          OPENCLAW_STATE_DIR: "/var/lib/openclaw-state"
        },
        homedir: () => "/Users/tester"
      })
    ).toBe("/var/lib/openclaw-state/rocketchat/main.json");
  });

  it("falls back to the user home directory instead of process cwd", () => {
    expect(
      checkpointPathForAccount("main", {
        env: {},
        homedir: () => "/Users/tester"
      })
    ).toBe("/Users/tester/.openclaw/rocketchat/main.json");
  });
});

describe("attachmentMediaDir", () => {
  it("uses OPENCLAW_HOME when provided", () => {
    expect(
      attachmentMediaDir({
        env: {
          OPENCLAW_HOME: "/tmp/openclaw-home"
        },
        homedir: () => "/Users/tester"
      })
    ).toBe("/tmp/openclaw-home/.openclaw/media");
  });

  it("prefers OPENCLAW_STATE_DIR over OPENCLAW_HOME", () => {
    expect(
      attachmentMediaDir({
        env: {
          OPENCLAW_HOME: "/tmp/openclaw-home",
          OPENCLAW_STATE_DIR: "/var/lib/openclaw-state"
        },
        homedir: () => "/Users/tester"
      })
    ).toBe("/var/lib/openclaw-state/media");
  });

  it("falls back to the user home directory instead of process cwd", () => {
    expect(
      attachmentMediaDir({
        env: {},
        homedir: () => "/Users/tester"
      })
    ).toBe("/Users/tester/.openclaw/media");
  });
});

describe("rocketchatPlugin.config", () => {
  it("returns an empty account list when the root config has no Rocket.Chat section", () => {
    const rootConfig = {
      meta: {
        envFilePath: "/home/tester/.openclaw/.env"
      },
      channels: {}
    } as unknown as Parameters<typeof rocketchatPlugin.config.listAccountIds>[0];

    expect(
      rocketchatPlugin.config.listAccountIds(rootConfig)
    ).toEqual([]);
  });

  it("reads account ids from channels.rocketchat when the full OpenClaw config is provided", () => {
    const rootConfig = {
      meta: {
        envFilePath: "/home/tester/.openclaw/.env"
      },
      channels: {
        rocketchat: {
          accounts: {
            main: {
              enabled: true,
              serverUrl: "https://chat.example.com",
              auth: {
                mode: "token",
                userId: "user-1",
                accessToken: "token-1"
              }
            }
          }
        }
      }
    } as unknown as Parameters<typeof rocketchatPlugin.config.listAccountIds>[0];

    expect(
      rocketchatPlugin.config.listAccountIds(rootConfig)
    ).toEqual(["main"]);
  });

  it("returns null when resolving an account from a root config without Rocket.Chat settings", () => {
    const rootConfig = {
      meta: {
        envFilePath: "/home/tester/.openclaw/.env"
      },
      channels: {}
    } as unknown as Parameters<typeof rocketchatPlugin.config.resolveAccount>[0];

    expect(
      rocketchatPlugin.config.resolveAccount(rootConfig, "main")
    ).toBeNull();
  });
});
