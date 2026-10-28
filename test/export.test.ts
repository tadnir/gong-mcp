import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BotCheck, RateLimited, Unauthorized, type CallSearch } from "../src/api.js";
import { parseExportArgs } from "../src/cli.js";
import { callFile, exportTranscripts, loadIndex, type ExportApi } from "../src/export.js";
import { searchItem, transcriptAnswer } from "./fixtures.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const id = (n: number) => String(3000000000000000000n + BigInt(n));

/** A made-up account with `count` calls; per-call behaviour can be overridden. */
function fakeApi(count: number, transcriptFor: (id: string, attempt: number) => unknown = () => transcriptAnswer()) {
  const ids = Array.from({ length: count }, (_, i) => id(i + 1));
  const attempts = new Map<string, number>();
  const api: ExportApi & { searches: { search: CallSearch; pageSize: number; offset: number }[]; transcripts: string[] } = {
    searches: [],
    transcripts: [],
    async searchCalls(search, pageSize, offset) {
      api.searches.push({ search, pageSize, offset });
      return { numOfTotalItemsThatPassedFilter: count, items: ids.slice(offset, offset + pageSize).map((x, i) => searchItem(x, offset + i + 1)) };
    },
    async transcript(callId) {
      api.transcripts.push(callId);
      const attempt = (attempts.get(callId) ?? 0) + 1;
      attempts.set(callId, attempt);
      const answer = transcriptFor(callId, attempt);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return api;
}

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const quiet = () => undefined;

async function newDir() {
  dir = await mkdtemp(join(tmpdir(), "gong-export-test-"));
  return join(dir, "out");
}

describe("exportTranscripts", () => {
  test("saves one private file per call and an index, listing page by page, one request a second", async () => {
    const out = await newDir();
    const api = fakeApi(5);
    const c = clock();
    const logs: string[] = [];
    const r = await exportTranscripts({ api, dir: out, pageSize: 2, sleep: c.sleep, now: c.now, log: (l) => logs.push(l) });
    expect(r).toMatchObject({ ended: "done", listed: 5, saved: 5, skipped: 0, failed: 0 });
    expect(r.bytes).toBeGreaterThan(0);
    expect(api.searches.map((s) => s.offset)).toEqual([0, 2, 4]);
    expect(api.searches[0]!.search).toEqual({ from: "2000-01-01" });
    // 3 listing pages and 5 transcripts, each at least a second after the one before.
    expect(c.sleeps.filter((ms) => ms === 1_000)).toHaveLength(7);

    expect((await stat(out)).mode & 0o777).toBe(0o700);
    const files = (await readdir(out)).sort();
    expect(files).toEqual([...[1, 2, 3, 4, 5].map((n) => callFile(id(n))), "index.json"].sort());
    for (const f of files) expect((await stat(join(out, f))).mode & 0o777).toBe(0o600);

    const saved = JSON.parse(await readFile(join(out, callFile(id(1))), "utf8"));
    expect(saved).toMatchObject({ id: id(1), title: "Example Co / Intro 1", durationSec: 1800, participants: expect.any(Array), transcript: { callId: id(1), lines: expect.any(Array) } });
    expect(saved.transcript.lines).toHaveLength(2);
    expect(JSON.stringify(saved)).not.toContain("monologueWords");

    const index = await loadIndex(out);
    expect(index.listed).toBe(5);
    expect(index.calls[id(3)]).toMatchObject({ status: "saved", file: callFile(id(3)), lines: 2, title: "Example Co / Intro 3" });
    // The log carries counts only, never what was said.
    expect(logs.join("\n")).not.toMatch(/made-up line|another one/);
  });

  test("a second run skips what is already saved, and fetches only new calls", async () => {
    const out = await newDir();
    const c = clock();
    await exportTranscripts({ api: fakeApi(3), dir: out, sleep: c.sleep, now: c.now, log: quiet });
    const api = fakeApi(4);
    const r = await exportTranscripts({ api, dir: out, sleep: c.sleep, now: c.now, log: quiet });
    expect(r).toMatchObject({ ended: "done", listed: 4, saved: 1, skipped: 3 });
    expect(api.transcripts).toEqual([id(4)]);
  });

  test("no transcript, no access and failures are recorded and the run goes on", async () => {
    const out = await newDir();
    const c = clock();
    const api = fakeApi(4, (callId) => (callId === id(2) ? transcriptAnswer([]) : callId === id(3) ? new Error("Gong answered HTTP 500 for /call/detailed-transcript.") : transcriptAnswer()));
    const listing = api.searchCalls.bind(api);
    api.searchCalls = async (...a) => {
      const page = (await listing(...a)) as { items: Record<string, unknown>[] };
      page.items.find((i) => i.id === id(4))!.userCanAccess = false;
      return page;
    };
    const r = await exportTranscripts({ api, dir: out, sleep: c.sleep, now: c.now, log: quiet });
    expect(r).toMatchObject({ ended: "done", saved: 1, noTranscript: 1, failed: 1, noAccess: 1 });
    expect(api.transcripts).not.toContain(id(4));
    const index = await loadIndex(out);
    expect(index.calls[id(2)]!.status).toBe("no_transcript");
    expect(index.calls[id(3)]).toMatchObject({ status: "failed", error: expect.stringContaining("HTTP 500") });
    expect(index.calls[id(4)]!.status).toBe("no_access");

    // Failed calls are retried only when asked.
    const again = await exportTranscripts({ api, dir: out, sleep: c.sleep, now: c.now, log: quiet });
    expect(again).toMatchObject({ saved: 0, skipped: 4 });
    const retried = await exportTranscripts({ api, dir: out, retryFailed: true, sleep: c.sleep, now: c.now, log: quiet });
    expect(retried).toMatchObject({ failed: 1, skipped: 3 });
  });

  test("Gong asking to slow down waits and retries with growing pauses", async () => {
    const out = await newDir();
    const c = clock();
    const api = fakeApi(1, (_id, attempt) => (attempt < 3 ? new RateLimited(5_000) : transcriptAnswer()));
    const r = await exportTranscripts({ api, dir: out, sleep: c.sleep, now: c.now, log: quiet });
    expect(r).toMatchObject({ ended: "done", saved: 1 });
    expect(api.transcripts).toHaveLength(3);
    expect(c.sleeps).toContain(5_000);
    expect(c.sleeps).toContain(8_000);
  });

  test("a session that ends stops the run cleanly, and the next run picks up", async () => {
    const out = await newDir();
    const c = clock();
    let signedIn = true;
    const api = fakeApi(4, (callId) => {
      if (callId === id(3)) signedIn = false;
      return signedIn ? transcriptAnswer() : new Unauthorized();
    });
    const r = await exportTranscripts({ api, dir: out, sleep: c.sleep, now: c.now, log: quiet });
    expect(r).toMatchObject({ ended: "signed_out", saved: 2 });
    expect(Object.keys((await loadIndex(out)).calls)).toHaveLength(2);

    signedIn = true;
    const next = fakeApi(4);
    const resumed = await exportTranscripts({ api: next, dir: out, sleep: c.sleep, now: c.now, log: quiet });
    expect(resumed).toMatchObject({ ended: "done", saved: 2, skipped: 2 });
    expect(next.transcripts).toEqual([id(3), id(4)]);
  });

  test("Gong's bot protection stops the run; nothing tries to get past it", async () => {
    const out = await newDir();
    const c = clock();
    const api = fakeApi(3, () => new BotCheck());
    const r = await exportTranscripts({ api, dir: out, sleep: c.sleep, now: c.now, log: quiet });
    expect(r).toMatchObject({ ended: "bot_check", saved: 0 });
    expect(api.transcripts).toHaveLength(1);
  });

  test("count only lists one page and fetches no transcripts", async () => {
    const out = await newDir();
    const c = clock();
    const api = fakeApi(1234);
    const r = await exportTranscripts({ api, dir: out, countOnly: true, sleep: c.sleep, now: c.now, log: quiet });
    expect(r).toMatchObject({ ended: "counted", listed: 1234 });
    expect(api.searches).toHaveLength(1);
    expect(api.transcripts).toHaveLength(0);
  });
});

describe("export-transcripts arguments", () => {
  test("parses its options and refuses bad ones", () => {
    expect(parseExportArgs(["--count-only", "--from", "2025-01-01", "--dir", "/tmp/x", "--delay-ms", "2000"])).toMatchObject({ countOnly: true, from: "2025-01-01", dir: "/tmp/x", delayMs: 2000 });
    expect(parseExportArgs([])).toMatchObject({ countOnly: false, retryFailed: false, from: "2000-01-01", delayMs: 1000 });
    expect(() => parseExportArgs(["--from", "last year"])).toThrow();
    expect(() => parseExportArgs(["--delay-ms", "10"])).toThrow();
    expect(() => parseExportArgs(["--everything"])).toThrow();
  });
});
