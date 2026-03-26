import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("plugin manifest", () => {
  it("declares the plugin id, channel, and config schema", async () => {
    const raw = await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8");
    const manifest = JSON.parse(raw) as {
      id?: string;
      kind?: string;
      channels?: string[];
      configSchema?: Record<string, unknown>;
    };

    expect(manifest.id).toBe("rocketchat");
    expect(manifest.kind).toBe("channel");
    expect(manifest.channels).toEqual(["rocketchat"]);
    expect(manifest.configSchema).toBeTruthy();
  });

  it("keeps the npm publish metadata aligned with the install spec", async () => {
    const manifestRaw = await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8");
    const packageRaw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const manifest = JSON.parse(manifestRaw) as { id?: string };
    const packageJson = JSON.parse(packageRaw) as {
      name?: string;
      private?: boolean;
      publishConfig?: {
        access?: string;
      };
      openclaw?: {
        install?: {
          npmSpec?: string;
        };
      };
    };

    expect(manifest.id).toBe("rocketchat");
    expect(packageJson.name).toBe("@laevateinzzl/openclaw-rocketchat-bot");
    expect(packageJson.private).toBe(false);
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.openclaw?.install?.npmSpec).toBe(packageJson.name);
  });
});
