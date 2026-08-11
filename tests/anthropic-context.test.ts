import { describe, it, expect, afterEach } from "bun:test";
import { fetchModelContextWindow } from "../src/llm/anthropic.js";
import type { ProviderConfig } from "../src/config/config.js";

const anthropicProvider = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({
    name: "p",
    protocol: "anthropic",
    base_url: "https://api.example.com",
    model: "claude-sonnet-4-6",
    api_key: "sk-test",
    ...over,
  }) as ProviderConfig;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchModelContextWindow (layer 2 auto-fetch)", () => {
  it("returns max_input_tokens on a successful response", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        json: async () => ({ max_input_tokens: 750_000 }),
      } as Response;
    }) as typeof fetch;

    const got = await fetchModelContextWindow(anthropicProvider());
    expect(got).toBe(750_000);
    expect(calledUrl).toBe(
      "https://api.example.com/v1/models/claude-sonnet-4-6"
    );
  });

  it("returns 0 (graceful) when fetch throws — never propagates", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    // Must resolve, not reject.
    await expect(
      fetchModelContextWindow(anthropicProvider())
    ).resolves.toBe(0);
  });

  it("returns 0 on a non-OK HTTP status", async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 404, json: async () => ({}) }) as Response) as typeof fetch;

    expect(await fetchModelContextWindow(anthropicProvider())).toBe(0);
  });

  it("returns 0 when max_input_tokens is missing or null", async () => {
    globalThis.fetch = (async () =>
      ({ ok: true, json: async () => ({ max_input_tokens: null }) }) as Response) as typeof fetch;

    expect(await fetchModelContextWindow(anthropicProvider())).toBe(0);
  });

  it("returns 0 immediately for non-anthropic protocols without fetching", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({ max_input_tokens: 1 }) } as Response;
    }) as typeof fetch;

    const got = await fetchModelContextWindow(
      anthropicProvider({ protocol: "openai-compat" })
    );
    expect(got).toBe(0);
    expect(called).toBe(false);
  });
});
