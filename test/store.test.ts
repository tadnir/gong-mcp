import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { fileStore } from "../src/store.js";
import { signedInSession } from "./helpers.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("fileStore", () => {
  test("saves a session only this user can read, in a directory only this user can enter", async () => {
    dir = await mkdtemp(join(tmpdir(), "gong-mcp-test-"));
    const path = join(dir, "nested", "session.json");
    const store = fileStore(path);
    expect(await store.load()).toBeUndefined();
    const session = signedInSession();
    await store.save(session);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
    expect(await store.load()).toEqual(session);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  });

  test("ignores a file that is not a session", async () => {
    dir = await mkdtemp(join(tmpdir(), "gong-mcp-test-"));
    const path = join(dir, "session.json");
    const store = fileStore(path);
    await store.save({ ...signedInSession(), origin: undefined as unknown as string });
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    expect(await store.load()).toBeUndefined();
  });
});
