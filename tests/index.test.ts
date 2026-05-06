import { describe, expect, it } from "vitest";

import plugin from "../src/index.js";

describe("plugin entry", () => {
  it("exports a channel plugin entry object", () => {
    expect(plugin).toBeTruthy();
    expect(typeof plugin).toBe("object");
    expect(plugin.id).toBe("rocketchat");
    expect(plugin.name).toBe("Rocket.Chat");
    expect(typeof plugin.description).toBe("string");
    expect(plugin.plugin).toBeTruthy();
    expect(typeof plugin.registerFull).toBe("function");
  });

  it("uses the same top-level plugin id as the manifest and channel id", () => {
    expect(plugin.id).toBe("rocketchat");
  });

  it("registers gateway methods via registerFull", () => {
    const registeredMethods: Array<{ name: string; handler: unknown }> = [];
    const api = {
      registerGatewayMethod(name: string, handler: unknown) {
        registeredMethods.push({ name, handler });
      }
    };

    if (!plugin.registerFull) throw new Error("registerFull is required");
    plugin.registerFull(api);

    expect(registeredMethods.length).toBeGreaterThanOrEqual(1);
    expect(registeredMethods[0]!.name).toBe("rocketchat.gateway.startAccount");
    expect(typeof registeredMethods[0]!.handler).toBe("function");
  });
});
