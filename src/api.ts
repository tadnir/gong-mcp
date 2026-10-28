/**
 * The Gong web app's own JSON endpoints, the ones its pages call (not Gong's
 * public API, which needs an API key from an admin). Found in the web app's
 * scripts (app.gong.io/r/js/dist/*.js) and checked against a signed-in
 * session.
 *
 * Every call carries the session's cookies, on the Gong host the account
 * lives on (us-NNNNN.app.gong.io). Calls that are POSTs in the web app carry
 * its request token too, as the app does. Signed out, Gong answers 401, or
 * redirects to its sign-in page.
 *
 * Read-only: every path this client can call is in READ_PATHS, and each one
 * only reads. Nothing here can change a call, share it, comment or score.
 */
import type { CookieJar } from "./cookies.js";

export type Fetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export const SITE_ORIGIN = process.env.GONG_SITE_ORIGIN || "https://app.gong.io";

/** Gong's hosts: app.gong.io and the per-region ones it sends an account to. */
export function isGongHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "gong.io" || host.endsWith(".gong.io")) return true;
  // Tests and a GONG_SITE_ORIGIN override.
  return host === new URL(SITE_ORIGIN).hostname;
}

/** Every path this client calls. Each is a read in the web app; a path outside this list is refused. */
export const READ_PATHS: ReadonlySet<string> = new Set([
  "/ajax/common/rtkn",
  "/conversations",
  "/conversations/ajax/results",
  "/conversations/ajax/participants-suggestions",
  "/json/call/get-calls-basic-details",
  "/ajax/call/get-call-data",
  "/call/detailed-transcript",
  "/engagewebapi/ajax/prospecting/accounts-by-owner-or-search-key",
  "/engagewebapi/ajax/ae-home/get-deals-list",
]);

/** Calls the web app makes as POSTs although they only read, so they carry its request token. */
const POST_READS: ReadonlySet<string> = new Set(["/conversations/ajax/results", "/json/call/get-calls-basic-details"]);

/** Throws unless the call is one of this client's reads. */
export function assertRead(method: string, pathname: string): void {
  if (!READ_PATHS.has(pathname)) throw new GongApiError(`Refusing ${pathname}: not one of this server's read-only calls.`);
  if (method !== "GET" && !(method === "POST" && POST_READS.has(pathname))) throw new GongApiError(`Refusing ${method} ${pathname}: only reads are allowed.`);
}

const HEADERS: Record<string, string> = {
  accept: "application/json; charset=utf-8",
  "accept-language": "en-US,en;q=0.9",
};

/** How long a request token is reused before asking for a fresh one. */
const TOKEN_TTL_MS = 5 * 60_000;

export class GongApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GongApiError";
  }
}

/** Gong refused the cookies: the session is over. */
export class Unauthorized extends GongApiError {
  constructor() {
    super("Gong ended the session.", 401);
    this.name = "Unauthorized";
  }
}

/** Gong's bot protection (Cloudflare) answered instead of Gong. Nothing is solved or worked around: the caller stops. */
export class BotCheck extends GongApiError {
  constructor() {
    super("Gong's bot protection (Cloudflare) asked for a browser check. Stopping; nothing was solved or worked around. Sign in again on the sign-in page later, or use Gong in the browser.", 403);
    this.name = "BotCheck";
  }
}

/** Gong refused one page while the session is still alive: this account has no access to it. */
export class NoAccess extends GongApiError {
  constructor(path: string, status: number) {
    super(`Gong refused ${path} (HTTP ${status}) while the session is still signed in: this account has no access to that part of Gong.`, status);
    this.name = "NoAccess";
  }
}

/** Gong asked to slow down. */
export class RateLimited extends GongApiError {
  constructor(readonly retryAfterMs: number) {
    super(`Gong asked to slow down (HTTP 429); retry after ${Math.round(retryAfterMs / 1000)}s.`, 429);
    this.name = "RateLimited";
  }
}

/** Whether a response is Cloudflare's challenge rather than Gong's own answer. */
export function isBotCheck(res: Response): boolean {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  // Gong's own refusals come as JSON or a redirect; an HTML 403/503 from Cloudflare is its challenge page.
  return (res.status === 403 || res.status === 503) && /cloudflare/i.test(res.headers.get("server") ?? "") && /text\/html/.test(res.headers.get("content-type") ?? "");
}

/** Retry-After as milliseconds, with a floor and a default. */
export function retryAfterMs(res: Response, fallbackMs = 30_000): number {
  const value = res.headers.get("retry-after");
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? fallbackMs : Math.max(1_000, at - Date.now());
}

/** A calendar day, YYYY-MM-DD. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Gong's ids are long decimal numbers. */
export const GONG_ID = /^\d{1,25}$/;

/** What the signed-in page tells the web app about who is signed in and where. */
export interface PageContext {
  workspaceId?: string;
  workspaceName?: string;
  companyId?: string;
  companyName?: string;
  user?: Record<string, unknown>;
}

export interface CallSearch {
  /** First day, YYYY-MM-DD. */
  from: string;
  /** Last day, YYYY-MM-DD. */
  to?: string;
  title?: string;
  accountName?: string;
  /** An external participant's email. */
  contactEmail?: string;
  accountCrmId?: string;
  dealCrmId?: string;
  /** Gong user ids of company participants (from find_people). */
  userIds?: string[];
}

/** The search the conversations page sends, as its filter builder writes it. */
export function callSearchJson(search: CallSearch): { search: { type: "And"; filters: Record<string, unknown>[] } } {
  const filters: Record<string, unknown>[] = [
    search.to ? { type: "AbsoluteCallDateRange", from: search.from, to: search.to } : { type: "SinceCallDateRange", from: search.from },
  ];
  if (search.title) filters.push({ type: "CallTitle", phrase: search.title });
  if (search.accountName) filters.push({ type: "AccountName", phrase: search.accountName });
  if (search.contactEmail) filters.push({ type: "ContactEmail", phrase: search.contactEmail });
  if (search.accountCrmId) filters.push({ type: "AccountCrmId", phrase: search.accountCrmId });
  if (search.dealCrmId) filters.push({ type: "OpportunityCrmId", phrase: search.dealCrmId });
  if (search.userIds?.length) filters.push({ type: "Participants", userIds: search.userIds, host: true, attendee: true, invitee: true });
  return { search: { type: "And", filters } };
}

export type Scalar = string | number | boolean | null;

/**
 * The plain fields of the object a page's inline script assigns to `name`
 * (var pageContext = {companyId: "…", …}, or var CurrentUser = function ()
 * { return {…} }()). It reads the script as text, without running it: only
 * top-level string, number, boolean and null fields are kept; nested objects,
 * arrays and expressions are skipped. Undefined when the page has no such
 * object.
 */
export function pageObject(html: string, name: string): Record<string, Scalar> | undefined {
  const at = new RegExp(`(?:window\\.|var |let |const )${name}\\s*=\\s*`).exec(html);
  if (!at) return undefined;
  let i = at.index + at[0].length;
  if (html[i] !== "{") {
    // A function that returns the object: take the object after its first return.
    const head = html.slice(i, i + 200);
    if (!/^\(?\s*function\b/.test(head)) return undefined;
    const ret = /\breturn\s*\{/.exec(html.slice(i, i + 2000));
    if (!ret) return undefined;
    i += ret.index + ret[0].length - 1;
  }
  const out: Record<string, Scalar> = {};
  i++; // past the opening brace
  const space = () => {
    while (i < html.length && /[\s,]/.test(html[i]!)) i++;
  };
  const readString = (): string | undefined => {
    const quote = html[i]!;
    let j = i + 1;
    let raw = "";
    while (j < html.length && html[j] !== quote) {
      if (html[j] === "\\") {
        raw += html.slice(j, j + 2);
        j += 2;
      } else raw += html[j++];
    }
    i = j + 1;
    try {
      return JSON.parse(`"${raw.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"`) as string;
    } catch {
      return undefined;
    }
  };
  /** Skips one value that is not a plain scalar, up to the next top-level comma or closing brace. */
  const skipValue = () => {
    let depth = 0;
    while (i < html.length) {
      const c = html[i]!;
      if (c === '"' || c === "'" || c === "`") {
        readString();
        continue;
      }
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") {
        if (depth === 0) return;
        depth--;
      } else if (c === "," && depth === 0) return;
      i++;
    }
  };
  for (let guard = 0; guard < 500; guard++) {
    space();
    if (i >= html.length || html[i] === "}") return out;
    let key: string | undefined;
    if (html[i] === '"' || html[i] === "'") key = readString();
    else {
      const m = /^[A-Za-z_$][\w$]*/.exec(html.slice(i, i + 100));
      if (!m) return out;
      key = m[0];
      i += key.length;
    }
    while (/\s/.test(html[i] ?? "")) i++;
    if (html[i] !== ":" || key === undefined) return out;
    i++;
    while (/\s/.test(html[i] ?? "")) i++;
    const c = html[i];
    if (c === '"' || c === "'") {
      const value = readString();
      if (value !== undefined && /^\s*[,}]/.test(html.slice(i, i + 50))) out[key] = value;
      else skipValue();
    } else {
      const m = /^(-?\d+(?:\.\d+)?|true|false|null)\s*(?=[,}\n])/.exec(html.slice(i, i + 40));
      if (m) {
        const v = m[1]!;
        out[key] = v === "true" ? true : v === "false" ? false : v === "null" ? null : Number(v);
        i += m[0].length;
      } else skipValue();
    }
  }
  return out;
}

export class GongApi {
  readonly #jar: () => Promise<CookieJar>;
  readonly #changed: () => Promise<void>;
  readonly #origin: () => string;
  readonly #fetch: Fetch;
  #token: { headerName: string; token: string; at: number; origin: string } | undefined;
  #context: { origin: string; value: PageContext } | undefined;

  /**
   * jar returns the live session's cookies (throwing when there is none);
   * changed is called after Gong set new ones, so they can be saved; origin
   * is the Gong host the session belongs to.
   */
  constructor(jar: () => Promise<CookieJar>, changed: () => Promise<void>, origin: () => string, f: Fetch = fetch) {
    this.#jar = jar;
    this.#changed = changed;
    this.#origin = origin;
    this.#fetch = f;
  }

  /** The web app's request token; answers while the session lives. */
  async ping(): Promise<void> {
    await this.#requestToken(true);
  }

  /** Forgets what was learned about the signed-in user, e.g. after a new sign-in. */
  reset(): void {
    this.#token = undefined;
    this.#context = undefined;
  }

  /** Who is signed in, the company and the workspace, from the conversations page's own context. */
  async pageContext(): Promise<PageContext> {
    const origin = this.#origin();
    if (this.#context?.origin === origin) return this.#context.value;
    const res = await this.#request("/conversations", { method: "GET", headers: { accept: "text/html" } });
    const html = await res.text();
    const context = pageObject(html, "pageContext") ?? {};
    const user = pageObject(html, "CurrentUser");
    const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
    const value: PageContext = {
      ...(str(context.workspaceId) ? { workspaceId: str(context.workspaceId) } : {}),
      ...(str(context.workspaceName) ? { workspaceName: str(context.workspaceName) } : {}),
      ...(str(context.companyId) ? { companyId: str(context.companyId) } : {}),
      ...(str(context.companyName) ? { companyName: str(context.companyName) } : {}),
      ...(user ? { user } : {}),
    };
    if (!value.workspaceId && !value.user) throw new GongApiError("Gong's conversations page did not say who is signed in; the web app may have changed.");
    this.#context = { origin, value };
    return value;
  }

  /** One page of calls matching the search, newest first, as the conversations page lists them. */
  async searchCalls(search: CallSearch, pageSize: number, offset: number): Promise<unknown> {
    const workspace = await this.#workspace();
    return this.#json(`/conversations/ajax/results${workspace}`, {
      method: "POST",
      body: { callsSearchJson: JSON.stringify(callSearchJson(search)), pageSize, callsOffset: offset },
    });
  }

  /** Title, time, duration and owner of each call, as the share dialogs read them. */
  async callsBasicDetails(callIds: string[]): Promise<unknown> {
    const workspace = await this.#workspace();
    return this.#json(`/json/call/get-calls-basic-details${workspace}`, { method: "POST", body: callIds.map(id) });
  }

  /** The call page's data: participants, CRM context, topics, trackers and the rest. */
  async callData(callId: string): Promise<unknown> {
    return this.#json(`/ajax/call/get-call-data?call-id=${id(callId)}`);
  }

  /** The call's transcript, as the call page's transcript tab reads it. */
  async transcript(callId: string): Promise<unknown> {
    return this.#json(`/call/detailed-transcript?call-id=${id(callId)}`);
  }

  /** People whose name or email starts with the text: company users (with ids for search_calls), teams and customers. */
  async participants(text: string): Promise<unknown> {
    const workspace = await this.#workspace();
    return this.#json(`/conversations/ajax/participants-suggestions${workspace}${workspace ? "&" : "?"}partial-text=${encodeURIComponent(text.slice(0, 30))}`);
  }

  /** CRM accounts the signed-in user owns, or that match the keyword. */
  async accounts(keyword?: string): Promise<unknown> {
    const workspace = await this.#workspace();
    const query = keyword ? `${workspace ? "&" : "?"}search-keyword=${encodeURIComponent(keyword)}` : "";
    return this.#json(`/engagewebapi/ajax/prospecting/accounts-by-owner-or-search-key${workspace}${query}`);
  }

  /** The signed-in user's deals, or one account's. */
  async deals(accountId?: string): Promise<unknown> {
    const workspace = await this.#workspace();
    const query = accountId ? `${workspace ? "&" : "?"}account-id=${encodeURIComponent(accountId)}` : "";
    return this.#json(`/engagewebapi/ajax/ae-home/get-deals-list${workspace}${query}`);
  }

  async #workspace(): Promise<string> {
    const { workspaceId } = await this.pageContext();
    return workspaceId ? `?workspace-id=${encodeURIComponent(workspaceId)}` : "";
  }

  async #requestToken(fresh = false): Promise<{ headerName: string; token: string }> {
    const origin = this.#origin();
    if (!fresh && this.#token && this.#token.origin === origin && Date.now() - this.#token.at < TOKEN_TTL_MS) return this.#token;
    const answer = (await this.#json("/ajax/common/rtkn")) as { headerName?: unknown; token?: unknown } | null;
    if (typeof answer?.token !== "string" || !answer.token) throw new Unauthorized();
    const headerName = typeof answer.headerName === "string" && answer.headerName ? answer.headerName : "X-CSRF-TOKEN";
    this.#token = { headerName, token: answer.token, at: Date.now(), origin };
    return this.#token;
  }

  async #json(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    if (method === "POST") {
      const { headerName, token } = await this.#requestToken();
      headers[headerName] = token;
      headers["content-type"] = "application/json";
    }
    const res = await this.#request(path, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    const text = await res.text();
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      // Gong serves its sign-in page instead of an answer once the session is over.
      if (/welcome\/sign-in|<title>\s*Gong\s*\|\s*Sign in/i.test(text)) throw new Unauthorized();
      throw new GongApiError(`Gong answered ${pathOf(path)} with something other than JSON.`);
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.#origin());
    assertRead(init.method ?? "GET", url.pathname);
    const jar = await this.#jar();
    const res = await this.#fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...HEADERS, referer: `${url.origin}/conversations`, ...(init.headers as Record<string, string> | undefined), cookie: jar.header() },
    });
    if (jar.update(res)) await this.#changed();
    if (isBotCheck(res)) throw new BotCheck();
    if (res.status === 429) throw new RateLimited(retryAfterMs(res));
    if (res.status === 401 || res.status === 403) throw new Unauthorized();
    if (res.status >= 300 && res.status < 400) {
      // Redirected away (to sign in, or to another region's host): the session no longer serves this host.
      throw new Unauthorized();
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new GongApiError(`Gong answered HTTP ${res.status} for ${url.pathname}${detail && !detail.startsWith("<") ? `: ${detail}` : ""}.`, res.status);
    }
    return res;
  }
}

function id(value: string): string {
  if (!GONG_ID.test(value)) throw new GongApiError(`Not a Gong id: ${JSON.stringify(value)}`);
  return value;
}

function pathOf(path: string): string {
  return path.split("?")[0]!;
}
