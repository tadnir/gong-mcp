/**
 * `gong-mcp export-transcripts`: saves every call's transcript the signed-in
 * account can see. See src/export.ts and README.md.
 *
 *   --count-only     list and count the calls, and fetch nothing else
 *   --from DAY       only calls from this day on (YYYY-MM-DD); default all time
 *   --dir PATH       where to save; default ~/gong-transcripts (GONG_EXPORT_DIR)
 *   --retry-failed   try again the calls an earlier run could not fetch
 *   --delay-ms N     the least time between requests; default 1000
 */
import { DAY } from "./api.js";
import { ALL_TIME, exportDir, exportTranscripts } from "./export.js";
import { SessionManager } from "./session.js";

export function parseExportArgs(argv: string[]): { countOnly: boolean; retryFailed: boolean; from: string; dir: string; delayMs: number } {
  const args = { countOnly: false, retryFailed: false, from: ALL_TIME, dir: exportDir(), delayMs: 1_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--count-only") args.countOnly = true;
    else if (a === "--retry-failed") args.retryFailed = true;
    else if (a === "--from") {
      args.from = value();
      if (!DAY.test(args.from)) throw new Error("--from takes a day, YYYY-MM-DD");
    } else if (a === "--dir") args.dir = value();
    else if (a === "--delay-ms") {
      args.delayMs = Number(value());
      if (!Number.isInteger(args.delayMs) || args.delayMs < 250) throw new Error("--delay-ms takes a whole number of milliseconds, 250 or more");
    } else throw new Error(`Unknown option ${a}`);
  }
  return args;
}

export async function runExport(argv: string[]): Promise<number> {
  const args = parseExportArgs(argv);
  const session = new SessionManager();
  await session.keeper.reload();
  if (session.keeper.status().state !== "signed_in") {
    console.error(`[gong-export] not signed in to Gong: open ${await session.signInUrl()} and sign in; the export starts once you have.`);
    while (session.keeper.status().state !== "signed_in") await new Promise((r) => setTimeout(r, 2_000));
  }
  try {
    const result = await exportTranscripts({ api: session.api, ...args });
    console.log(JSON.stringify(result, null, 2));
    return result.ended === "done" || result.ended === "counted" ? 0 : 2;
  } finally {
    session.stop();
  }
}
