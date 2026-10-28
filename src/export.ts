/**
 * Saves the transcript of every call the signed-in account can see, one JSON
 * file per call, with an index.json of what was saved, what had no
 * transcript, and what failed.
 *
 * Resumable: a call already saved (or known to have no transcript) is
 * skipped. Throttled: one request at a time, at most one a second, longer
 * when Gong asks to slow down. It stops cleanly, keeping the index, when the
 * session ends or Gong's bot protection asks for a browser check. It logs
 * counts only, never what was said.
 */
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BotCheck, RateLimited, Unauthorized, type CallSearch } from "./api.js";
import { searchPage, transcript, type CallSummary } from "./calls.js";
import { SignInRequired } from "./keeper.js";

export interface ExportApi {
  searchCalls(search: CallSearch, pageSize: number, offset: number): Promise<unknown>;
  transcript(callId: string): Promise<unknown>;
}

export type EntryStatus = "saved" | "no_transcript" | "no_access" | "failed";

export interface IndexEntry {
  status: EntryStatus;
  title?: string;
  startTime?: string;
  durationSec?: number;
  /** The call's file, relative to the export directory. */
  file?: string;
  bytes?: number;
  lines?: number;
  error?: string;
  at: string;
}

export interface ExportIndex {
  version: 1;
  updatedAt: string;
  /** Calls the account could see at the last listing. */
  listed?: number;
  calls: Record<string, IndexEntry>;
}

export interface ExportOptions {
  api: ExportApi;
  dir?: string;
  /** First day to list calls from; default: all time. */
  from?: string;
  pageSize?: number;
  /** The least time between two requests to Gong. */
  delayMs?: number;
  /** Only list and count; fetch no transcripts. */
  countOnly?: boolean;
  /** Retry a call that failed in an earlier run. */
  retryFailed?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ExportResult {
  /** Why the run ended: done, or stopped early. */
  ended: "done" | "counted" | "signed_out" | "bot_check" | "rate_limited";
  listed: number;
  saved: number;
  skipped: number;
  noTranscript: number;
  noAccess: number;
  failed: number;
  bytes: number;
  dir: string;
  message?: string;
}

export const ALL_TIME = "2000-01-01";
const MAX_RETRIES = 5;

export function exportDir(): string {
  return process.env.GONG_EXPORT_DIR || join(homedir(), "gong-transcripts");
}

/** A file only this user can read, written atomically. */
async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function loadIndex(dir: string): Promise<ExportIndex> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as ExportIndex;
    if (parsed?.version === 1 && parsed.calls && typeof parsed.calls === "object") return parsed;
  } catch {
    // No index yet, or an unreadable one: start a new one.
  }
  return { version: 1, updatedAt: new Date(0).toISOString(), calls: {} };
}

/** A file name for the call, from its id only: titles are content and stay inside the files. */
export function callFile(id: string): string {
  if (!/^\d{1,25}$/.test(id)) throw new Error(`Not a Gong id: ${JSON.stringify(id)}`);
  return `${id}.json`;
}

export async function exportTranscripts(options: ExportOptions): Promise<ExportResult> {
  const dir = options.dir ?? exportDir();
  const pageSize = options.pageSize ?? 50;
  const delayMs = options.delayMs ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(`[gong-export] ${line}`));
  const from = options.from ?? ALL_TIME;

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const index = await loadIndex(dir);
  const result: ExportResult = { ended: "done", listed: 0, saved: 0, skipped: 0, noTranscript: 0, noAccess: 0, failed: 0, bytes: 0, dir };
  const saveIndex = async () => {
    index.updatedAt = new Date(now()).toISOString();
    await writePrivate(join(dir, "index.json"), JSON.stringify(index, null, 2));
  };

  let last = 0;
  /** One request to Gong, spaced out, retried with growing waits when Gong asks to slow down. */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + delayMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof RateLimited) || attempt >= MAX_RETRIES) throw err;
        const backoff = Math.max(err.retryAfterMs, delayMs * 2 ** (attempt + 2));
        log(`Gong asked to slow down; waiting ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
      }
    }
  };

  const stop = async (err: unknown): Promise<ExportResult | undefined> => {
    if (err instanceof Unauthorized || err instanceof SignInRequired) result.ended = "signed_out";
    else if (err instanceof BotCheck) result.ended = "bot_check";
    else if (err instanceof RateLimited) result.ended = "rate_limited";
    else return undefined;
    result.message = err instanceof SignInRequired ? err.message : (err as Error).message;
    await saveIndex();
    log(`stopped (${result.ended}); the index is saved, and the next run picks up where this one stopped`);
    return result;
  };

  // 1. Every call the account can see, newest first.
  const calls: CallSummary[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += pageSize) {
    let page;
    try {
      page = searchPage(await call(() => options.api.searchCalls({ from }, pageSize, offset)), offset);
    } catch (err) {
      const stopped = await stop(err);
      if (stopped) return { ...stopped, listed: calls.length };
      throw err;
    }
    for (const c of page.calls) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      calls.push(c);
    }
    if (offset === 0) log(`${page.total ?? "?"} calls to list`);
    if (options.countOnly && page.total !== undefined) {
      result.listed = page.total;
      result.ended = "counted";
      return result;
    }
    if (page.calls.length < pageSize || (page.total !== undefined && offset + pageSize >= page.total)) break;
    if (calls.length % 500 < pageSize) log(`listed ${calls.length}`);
  }
  result.listed = calls.length;
  index.listed = calls.length;
  if (options.countOnly) {
    result.ended = "counted";
    return result;
  }
  log(`listed ${calls.length} calls; fetching transcripts`);

  // 2. Each call's transcript, skipping what an earlier run already has.
  for (const [i, c] of calls.entries()) {
    const had = index.calls[c.id];
    if (had && (had.status === "saved" || had.status === "no_transcript" || had.status === "no_access" || (had.status === "failed" && !options.retryFailed))) {
      if (had.status !== "saved" || (await stat(join(dir, had.file ?? callFile(c.id))).then(() => true, () => false))) {
        result.skipped++;
        continue;
      }
    }
    const meta = { ...(c.title ? { title: c.title } : {}), ...(c.startTime ? { startTime: c.startTime } : {}), ...(c.durationSec !== undefined ? { durationSec: c.durationSec } : {}) };
    if (c.canAccess === false) {
      index.calls[c.id] = { status: "no_access", ...meta, at: new Date(now()).toISOString() };
      result.noAccess++;
    } else {
      try {
        const t = transcript(await call(() => options.api.transcript(c.id)), c.id);
        if (t.lines.length === 0) {
          index.calls[c.id] = { status: "no_transcript", ...meta, at: new Date(now()).toISOString() };
          result.noTranscript++;
        } else {
          const file = callFile(c.id);
          const text = JSON.stringify({ ...c, transcript: t }, null, 2);
          await writePrivate(join(dir, file), text);
          const bytes = Buffer.byteLength(text);
          index.calls[c.id] = { status: "saved", ...meta, file, bytes, lines: t.lines.length, at: new Date(now()).toISOString() };
          result.saved++;
          result.bytes += bytes;
        }
      } catch (err) {
        const stopped = await stop(err);
        if (stopped) return stopped;
        index.calls[c.id] = { status: "failed", ...meta, error: (err instanceof Error ? err.message : String(err)).slice(0, 200), at: new Date(now()).toISOString() };
        result.failed++;
      }
    }
    if (i % 10 === 0 || i === calls.length - 1) await saveIndex();
    if ((i + 1) % 100 === 0) log(`${i + 1}/${calls.length}: ${result.saved} saved, ${result.skipped} already had, ${result.noTranscript} without transcript, ${result.failed} failed`);
  }
  await saveIndex();
  log(`done: ${result.saved} saved, ${result.skipped} already had, ${result.noTranscript} without transcript, ${result.noAccess} without access, ${result.failed} failed`);
  return result;
}
