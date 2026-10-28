/**
 * The signed-in side of the server: one Gong session kept alive in this
 * process, and a small sign-in page that starts it.
 *
 * Settings (environment):
 *   GONG_CONFIG_DIR  where the session is saved (default ~/.config/gong-mcp)
 *   GONG_LOGIN_HOST  address the sign-in page listens on (default 127.0.0.1)
 *   GONG_LOGIN_PORT  its port (default 8769; a free port if that one is taken)
 *   GONG_LOGIN_URL   the link handed out, when the page is reached through a
 *                    reverse proxy (default http://localhost:<port>/); when
 *                    set, the page starts with the server
 *   GONG_HEADLESS    true hides the sign-in browser's window (default false)
 *
 * The email, password and second factor are typed on Gong's and the identity
 * provider's own pages only. The model is only ever given this page's link.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { GongApi, SITE_ORIGIN, Unauthorized, type Fetch } from "./api.js";
import { SessionKeeper, SessionRefused, SignInRequired, type KeeperStatus } from "./keeper.js";
import { GongLoginError, KEYS, openChromium, type LoginBrowser, type OpenBrowser } from "./login.js";
import { DEFAULT_SESSION_LENGTH, PAGE_HEADERS, SCREEN_SCRIPT, SESSION_LENGTHS, browserPage, messagePage, startPage, statusPage, workingPage } from "./pages.js";
import { fileStore, type SessionStore } from "./store.js";

const log = (line: string): void => console.error(`[gong-mcp] ${line}`);

/** A sign-in left alone this long is dropped and its browser closed. */
const PENDING_TTL_MS = 10 * 60_000;
/** How long a form waits for the browser before showing a progress page. */
const STEP_WAIT_MS = 8_000;
/** How often the sign-in asks Gong whether it is done. */
const WATCH_MS = 2_000;

export interface SessionStatus extends KeeperStatus {
  signInUrl?: string;
}

export interface SessionManagerOptions {
  store?: SessionStore;
  fetch?: Fetch;
  openBrowser?: OpenBrowser;
  host?: string;
  port?: number;
  url?: string;
  tickMs?: number;
  /** How long a form waits for the browser before showing progress. */
  stepWaitMs?: number;
  /** How often the sign-in checks whether it is done. */
  watchMs?: number;
}

/** A sign-in in progress, in a browser on Gong's site. */
interface Pending {
  browser?: LoginBrowser;
  lengthMs: number;
  at: number;
  /** starting the browser, or the sign-in pages in it. */
  step: "opening" | "browser";
  error?: string;
  watch?: ReturnType<typeof setInterval>;
}

export class SessionManager {
  readonly keeper: SessionKeeper;
  readonly api: GongApi;
  readonly #openBrowser: OpenBrowser;
  readonly #stepWaitMs: number;
  readonly #watchMs: number;
  readonly #csrf = randomBytes(16).toString("hex");
  readonly #host: string;
  readonly #port: number;
  readonly #fixedUrl: string | undefined;
  #server: Promise<string> | undefined;
  #http: Server | undefined;
  #pending: Pending | undefined;
  /** Why the last sign-in failed, shown once on the sign-in page. */
  #notice: string | undefined;

  constructor(options: SessionManagerOptions = {}) {
    this.#openBrowser = options.openBrowser ?? openChromium;
    this.#stepWaitMs = options.stepWaitMs ?? STEP_WAIT_MS;
    this.#watchMs = options.watchMs ?? WATCH_MS;
    this.#host = options.host ?? (process.env.GONG_LOGIN_HOST || "127.0.0.1");
    this.#port = options.port ?? Number(process.env.GONG_LOGIN_PORT || 8769);
    this.#fixedUrl = options.url ?? (process.env.GONG_LOGIN_URL || undefined);
    this.keeper = new SessionKeeper({ store: options.store ?? fileStore(), ...(options.tickMs ? { tickMs: options.tickMs } : {}) });
    this.api = new GongApi(
      () => this.#jar(),
      () => this.keeper.cookiesChanged(),
      () => this.keeper.origin() ?? SITE_ORIGIN,
      (input, init) => this.#apiFetch(input, init, options.fetch ?? fetch),
    );
    this.keeper.check = async () => {
      try {
        await this.api.ping();
      } catch (err) {
        if (err instanceof Unauthorized || err instanceof SignInRequired) throw new SessionRefused();
        throw err;
      }
    };
  }

  async start(): Promise<void> {
    await this.keeper.start();
    if (this.#fixedUrl) await this.signInUrl();
  }

  stop(): void {
    this.keeper.stop();
    this.#http?.close();
    void this.#dropPending();
  }

  /** Starts the sign-in page if it is not up yet and returns its link. */
  signInUrl(): Promise<string> {
    this.#server ??= this.#listen().catch((err: unknown) => {
      this.#server = undefined;
      throw err;
    });
    return this.#server;
  }

  async status(): Promise<SessionStatus> {
    const status = this.keeper.status();
    if (status.state === "signed_in") return status;
    return { ...status, signInUrl: await this.signInUrl() };
  }

  /** Gong answered with its sign-in page: the session is over. Returns what to tell the caller. */
  async refused(): Promise<SignInRequired> {
    await this.keeper.lost("Gong ended the session.");
    this.api.reset();
    return this.#signInRequired();
  }

  async #jar() {
    try {
      return await this.keeper.jar();
    } catch (err) {
      if (err instanceof SignInRequired) throw await this.#signInRequired();
      throw err;
    }
  }

  async #signInRequired(): Promise<SignInRequired> {
    const url = await this.signInUrl();
    return new SignInRequired(
      `Not signed in to Gong (the session ended, or nobody has signed in yet). ` +
        `Ask the user to open ${url} and sign in to Gong there, the way they always do, then try again. ` +
        `Never ask the user for their password, codes or cookies in the chat.`,
    );
  }

  /** A refused session is forgotten, and the caller is told to sign in. */
  async #apiFetch(input: URL | RequestInfo, init: RequestInit | undefined, f: Fetch): Promise<Response> {
    // As the browser that signed in: Gong may tie the session to it.
    const userAgent = this.keeper.userAgent();
    const res = await f(input, userAgent ? { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "user-agent": userAgent } } : init);
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      log(`Gong refused ${new URL(String(input instanceof Request ? input.url : input)).pathname} with HTTP ${res.status}`);
      await this.keeper.lost("Gong ended the session.");
      this.api.reset();
      throw await this.#signInRequired();
    }
    return res;
  }

  async #listen(): Promise<string> {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        log(`sign-in page failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) page(res, 500, messagePage("Something went wrong", "Reload the page and try again."));
        else res.end();
      });
    });
    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, this.#host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    let port: number;
    try {
      port = await bind(this.#port);
    } catch (err) {
      // Another client's copy of this server holds the port: any free one will do locally.
      if ((err as { code?: string }).code !== "EADDRINUSE" || this.#fixedUrl) throw err;
      port = await bind(0);
    }
    server.unref();
    this.#http = server;
    const url = this.#fixedUrl ?? `http://localhost:${port}/`;
    log(`sign-in page on ${this.#host}:${port}, linked as ${url}`);
    return url;
  }

  /** Only the hosts the link names: a page another site rebinds to 127.0.0.1 gets nothing. */
  #hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const name = host.replace(/:\d+$/, "");
    if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return true;
    if (!this.#fixedUrl) return false;
    return host === new URL(this.#fixedUrl).host.toLowerCase();
  }

  #livePending(): Pending | undefined {
    if (this.#pending && Date.now() - this.#pending.at > PENDING_TTL_MS) void this.#dropPending();
    return this.#pending;
  }

  async #dropPending(): Promise<void> {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending?.watch) clearInterval(pending.watch);
    await pending?.browser?.close().catch(() => undefined);
  }

  /** The browser is signed in on origin: keep its cookies, close it. */
  async #finish(pending: Pending, browser: LoginBrowser, origin: string): Promise<void> {
    if (this.#pending !== pending) return;
    const cookies = await browser.cookies(origin);
    if (cookies.length === 0) throw new GongLoginError("Gong signed in but set no session cookie.");
    this.#pending = undefined;
    if (pending.watch) clearInterval(pending.watch);
    const userAgent = browser.userAgent();
    await browser.close().catch(() => undefined);
    this.api.reset();
    await this.keeper.signedIn(cookies, origin, pending.lengthMs, userAgent);
    log(`signed in on ${new URL(origin).host}`);
  }

  /** Checks every few seconds whether Gong now counts the browser as signed in. */
  #watch(pending: Pending, browser: LoginBrowser): void {
    let busy = false;
    pending.watch = setInterval(() => {
      if (busy || this.#pending !== pending) return;
      busy = true;
      browser
        .signedIn()
        .then((origin) => (origin ? this.#finish(pending, browser, origin) : undefined))
        .catch((err: unknown) => {
          pending.error = err instanceof Error ? err.message : String(err);
        })
        .finally(() => (busy = false));
    }, this.#watchMs);
    pending.watch.unref?.();
  }

  /** Opens the browser in the background; the form waits a little for it, then the page shows progress. */
  async #open(pending: Pending): Promise<void> {
    const task = (async () => {
      const browser = await this.#openBrowser();
      if (this.#pending !== pending) {
        await browser.close().catch(() => undefined);
        return;
      }
      pending.browser = browser;
      pending.step = "browser";
      pending.at = Date.now();
      this.#watch(pending, browser);
    })().catch(async (err: unknown) => {
      if (this.#pending !== pending) return;
      this.#notice = err instanceof GongLoginError ? err.message : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
      await this.#dropPending();
    });
    await Promise.race([task, new Promise((resolve) => setTimeout(resolve, this.#stepWaitMs).unref())]);
  }

  #pendingPage(pending: Pending): string {
    if (pending.step === "browser" && pending.browser) return browserPage(this.#csrf, pending.browser.location(), KEYS, pending.error);
    return workingPage(this.#csrf, "Opening Gong's sign-in page…");
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#hostAllowed(req)) {
      page(res, 421, messagePage("Wrong address", "Open the sign-in link exactly as it was given."));
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, gong: this.keeper.status().state }));
      return;
    }
    if (req.method === "GET" && path === "/") {
      const status = this.keeper.status();
      const pending = this.#livePending();
      const notice = this.#notice;
      this.#notice = undefined;
      if (pending) page(res, 200, this.#pendingPage(pending));
      else page(res, 200, status.state === "signed_in" && !notice ? statusPage(status, this.#csrf) : startPage(status, this.#csrf, notice));
      return;
    }
    if (req.method === "GET" && path === "/screen.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(SCREEN_SCRIPT);
      return;
    }
    if (req.method === "GET" && path === "/screen.png") {
      const pending = this.#livePending();
      const png = pending?.step === "browser" ? await pending.browser?.screen().catch(() => undefined) : undefined;
      if (!png) res.writeHead(404, { "cache-control": "no-store" }).end();
      else res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(png);
      return;
    }
    if (req.method !== "POST" || !["/start", "/click", "/type", "/key", "/cancel", "/sign-out"].includes(path)) {
      res.writeHead(404).end();
      return;
    }
    const form = new URLSearchParams(await readBody(req));
    if (form.get("csrf") !== this.#csrf) {
      page(res, 400, messagePage("Form expired", "Reload the page and try again."));
      return;
    }
    if (path === "/cancel") {
      await this.#dropPending();
    } else if (path === "/sign-out") {
      // Forgets the session here; Gong's own session is left to expire, as signing out there is Gong's action.
      await this.#dropPending();
      this.api.reset();
      await this.keeper.signOut();
    } else if (path === "/start") {
      const length = SESSION_LENGTHS[form.get("length") ?? DEFAULT_SESSION_LENGTH];
      if (!length) {
        page(res, 400, startPage(this.keeper.status(), this.#csrf, "Pick how long to stay signed in."));
        return;
      }
      await this.#dropPending();
      const pending: Pending = { lengthMs: length[1], at: Date.now(), step: "opening" };
      this.#pending = pending;
      await this.#open(pending);
    } else {
      // The sign-in pages: a click, typing or a key, passed on to the browser.
      const pending = this.#livePending();
      const live = req.headers["x-screen-live"] === "1";
      const browser = pending?.step === "browser" ? pending.browser : undefined;
      if (pending && browser) {
        pending.at = Date.now();
        if (path === "/click") {
          const x = Number(form.get("p.x"));
          const y = Number(form.get("p.y"));
          if (Number.isFinite(x) && Number.isFinite(y)) await browser.click(x, y);
        } else if (path === "/type") {
          const text = form.get("text") ?? "";
          if (text.length > 0 && text.length <= 200) await browser.type(text);
        } else {
          const key = form.get("key") ?? "";
          if ((KEYS as readonly string[]).includes(key)) await browser.press(key);
        }
        // Give the page a moment to react before the next picture.
        if (!live) await new Promise((resolve) => setTimeout(resolve, Math.min(1_500, this.#stepWaitMs)).unref());
      }
      if (live) {
        res.writeHead(browser ? 204 : 410, { "cache-control": "no-store" }).end();
        return;
      }
    }
    res.writeHead(303, { location: "./", "cache-control": "no-store" }).end();
  }
}

function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, PAGE_HEADERS).end(html);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 16 * 1024) throw new Error("form too large");
  }
  return body;
}
