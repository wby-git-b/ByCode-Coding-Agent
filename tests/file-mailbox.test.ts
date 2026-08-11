import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMailbox } from "../src/teams/file-mailbox.js";

describe("FileMailbox", () => {
  it("delivers only unread messages and advances the cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mewcode-mbox-"));
    const mbox = new FileMailbox(dir, "alice");

    await mbox.send("lead", "first");
    expect((await mbox.receive()).map((m) => m.text)).toEqual(["first"]);
    // Nothing new yet.
    expect(await mbox.receive()).toEqual([]);

    await mbox.send("lead", "second");
    expect((await mbox.receive()).map((m) => m.text)).toEqual(["second"]);
  });

  it("persists the read cursor across instances (process restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mewcode-mbox-"));
    const writer = new FileMailbox(dir, "bob");
    await writer.send("lead", "a");
    await writer.send("lead", "b");

    const reader1 = new FileMailbox(dir, "bob");
    expect((await reader1.receive()).map((m) => m.text)).toEqual(["a", "b"]);

    await writer.send("lead", "c");

    // A brand-new instance (simulating a restarted process) must resume after
    // "b", not re-read from the beginning.
    const reader2 = new FileMailbox(dir, "bob");
    expect(reader2.unreadCount()).toBe(1);
    expect((await reader2.receive()).map((m) => m.text)).toEqual(["c"]);
  });

  it("markAllRead consumes without returning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mewcode-mbox-"));
    const mbox = new FileMailbox(dir, "carol");
    await mbox.send("lead", "x");
    await mbox.send("lead", "y");
    mbox.markAllRead();
    expect(mbox.unreadCount()).toBe(0);
    expect(await mbox.receive()).toEqual([]);
  });
});
