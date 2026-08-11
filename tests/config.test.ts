import { describe, it, expect, beforeEach } from "bun:test";
import {
  mergeConfig,
  getContextWindow,
  getContextWindowAsync,
  lookupModelContextWindow,
  _resetContextWindowCache,
  getMaxOutputTokens,
  resolveAPIKey,
  type AppConfig,
  type ProviderConfig,
} from "../src/config/config.js";

describe("config", () => {
  describe("getContextWindow", () => {
    it("returns configured value if set", () => {
      const p = { context_window: 100000 } as ProviderConfig;
      expect(getContextWindow(p)).toBe(100000);
    });

    it("returns 200k for claude models", () => {
      const p = { model: "claude-sonnet-4-6" } as ProviderConfig;
      expect(getContextWindow(p)).toBe(200000);
    });

    it("returns 128k for non-claude models", () => {
      const p = { model: "gpt-4o" } as ProviderConfig;
      expect(getContextWindow(p)).toBe(128000);
    });
  });

  describe("lookupModelContextWindow (built-in table, layer 3/4)", () => {
    // Each case asserts the substring matcher lands on the right window.
    const cases: Array<[string, number]> = [
      ["claude-sonnet-4-5-1m", 1_000_000], // 1m variant wins over claude
      ["claude-sonnet-4-5-20250929-1m", 1_000_000],
      ["gpt-4.1", 1_000_000],
      ["gpt-4.1-mini", 1_000_000],
      ["gpt-4o", 128_000],
      ["gpt-4o-mini", 128_000],
      ["gpt-4-turbo", 128_000],
      ["o1", 200_000],
      ["o1-preview", 200_000],
      ["o3-mini", 200_000],
      ["o4-mini", 200_000],
      ["gpt-3.5-turbo", 16_385],
      ["claude-opus-4-6", 200_000],
      ["claude-haiku-4-5", 200_000],
      ["some-unknown-model", 128_000], // conservative non-claude default
    ];
    for (const [model, want] of cases) {
      it(`maps ${model} -> ${want}`, () => {
        expect(lookupModelContextWindow(model)).toBe(want);
      });
    }
  });

  describe("getContextWindowAsync (four-layer fallback)", () => {
    beforeEach(() => _resetContextWindowCache());

    it("layer 1: config context_window wins over everything (no fetch)", async () => {
      let called = false;
      const fetcher = async () => {
        called = true;
        return 999_999;
      };
      const p = {
        name: "p",
        protocol: "anthropic",
        model: "claude-sonnet-4-6",
        context_window: 321_000,
      } as ProviderConfig;
      expect(await getContextWindowAsync(p, fetcher)).toBe(321_000);
      expect(called).toBe(false);
    });

    it("layer 2: anthropic provider uses fetched max_input_tokens when > 0", async () => {
      const p = {
        name: "p",
        protocol: "anthropic",
        model: "claude-sonnet-4-6",
      } as ProviderConfig;
      const fetcher = async () => 500_000;
      expect(await getContextWindowAsync(p, fetcher)).toBe(500_000);
    });

    it("layer 2 result is memoized per provider (fetcher called once)", async () => {
      let calls = 0;
      const fetcher = async () => {
        calls++;
        return 400_000;
      };
      const p = {
        name: "p",
        protocol: "anthropic",
        model: "claude-sonnet-4-6",
      } as ProviderConfig;
      expect(await getContextWindowAsync(p, fetcher)).toBe(400_000);
      expect(await getContextWindowAsync(p, fetcher)).toBe(400_000);
      expect(calls).toBe(1);
    });

    it("degrades to the table when the fetcher throws (does not crash)", async () => {
      const fetcher = async () => {
        throw new Error("network down");
      };
      const p = {
        name: "p",
        protocol: "anthropic",
        model: "claude-sonnet-4-6",
      } as ProviderConfig;
      // claude -> 200k from the built-in table
      expect(await getContextWindowAsync(p, fetcher)).toBe(200_000);
    });

    it("degrades to the table when the fetcher returns 0", async () => {
      const fetcher = async () => 0;
      const p = {
        name: "p",
        protocol: "anthropic",
        model: "gpt-4o", // non-anthropic model name, but anthropic protocol
      } as ProviderConfig;
      expect(await getContextWindowAsync(p, fetcher)).toBe(128_000);
    });

    it("skips the fetch entirely for non-anthropic protocols", async () => {
      let called = false;
      const fetcher = async () => {
        called = true;
        return 777_000;
      };
      const p = {
        name: "p",
        protocol: "openai-compat",
        model: "gpt-4.1",
      } as ProviderConfig;
      // gpt-4.1 -> 1m from the table, fetcher never invoked
      expect(await getContextWindowAsync(p, fetcher)).toBe(1_000_000);
      expect(called).toBe(false);
    });
  });

  describe("getMaxOutputTokens", () => {
    it("returns configured value if set", () => {
      const p = { max_output_tokens: 4096 } as ProviderConfig;
      expect(getMaxOutputTokens(p)).toBe(4096);
    });

    it("returns 64k when thinking enabled", () => {
      const p = { thinking: true } as ProviderConfig;
      expect(getMaxOutputTokens(p)).toBe(64000);
    });

    it("returns 8192 by default", () => {
      const p = {} as ProviderConfig;
      expect(getMaxOutputTokens(p)).toBe(8192);
    });
  });

  describe("resolveAPIKey", () => {
    it("returns config api_key first", () => {
      const p = { api_key: "sk-test", protocol: "anthropic" } as ProviderConfig;
      expect(resolveAPIKey(p)).toBe("sk-test");
    });

    it("falls back to env var", () => {
      process.env.ANTHROPIC_API_KEY = "sk-from-env";
      const p = { protocol: "anthropic" } as ProviderConfig;
      expect(resolveAPIKey(p)).toBe("sk-from-env");
      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe("mergeConfig", () => {
    it("overrides providers completely", () => {
      const base: AppConfig = {
        providers: [{ name: "a", protocol: "anthropic", base_url: "", model: "m" }],
        mcp_servers: [],
        hooks: [],
      };
      const override: AppConfig = {
        providers: [{ name: "b", protocol: "openai", base_url: "", model: "m2" }],
        mcp_servers: [],
        hooks: [],
      };
      const result = mergeConfig(base, override);
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe("b");
    });

    it("merges MCP servers by name", () => {
      const base: AppConfig = {
        providers: [],
        mcp_servers: [{ name: "s1", command: "old" }],
        hooks: [],
      };
      const override: AppConfig = {
        providers: [],
        mcp_servers: [
          { name: "s1", command: "new" },
          { name: "s2", command: "extra" },
        ],
        hooks: [],
      };
      const result = mergeConfig(base, override);
      expect(result.mcp_servers).toHaveLength(2);
      expect(result.mcp_servers[0].command).toBe("new");
      expect(result.mcp_servers[1].name).toBe("s2");
    });

    it("appends hooks", () => {
      const base: AppConfig = {
        providers: [],
        mcp_servers: [],
        hooks: [{ event: "a", action: { type: "command" } }],
      };
      const override: AppConfig = {
        providers: [],
        mcp_servers: [],
        hooks: [{ event: "b", action: { type: "prompt" } }],
      };
      const result = mergeConfig(base, override);
      expect(result.hooks).toHaveLength(2);
    });
  });
});
