import type { Fetch } from "../src/api.js";
import type { Cookie } from "../src/cookies.js";
import type { LoginBrowser } from "../src/login.js";
import type { SavedSession, SessionStore } from "../src/store.js";

/** A made-up regional Gong host. */
export const ORIGIN = "https://us-00000.app.gong.io";

export function memoryStore(initial?: SavedSession): SessionStore & { saved?: SavedSession } {
  const store = {
    saved: initial,
    async load() {
      return store.saved;
    },
    async save(s: SavedSession) {
      store.saved = s;
    },
    async clear() {
      store.saved = undefined;
    },
  };
  return store;
}

export function signedInSession(cookies: Cookie[] = [{ name: "session", value: "s1" }]): SavedSession {
  return { version: 1, cookies, origin: ORIGIN, signedInAt: new Date().toISOString(), endsAt: Date.now() + 3_600_000 };
}

export interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a route table and records every call. */
export function fakeFetch(routes: (call: Call) => Response | undefined): Fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    return routes(call) ?? new Response("not found", { status: 404 });
  }) as Fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export interface FakeBrowser extends LoginBrowser {
  clicks: [number, number][];
  typed: string[];
  pressed: string[];
  closed: boolean;
  /** The person finished signing in: Gong counts the browser as signed in on ORIGIN from now on. */
  finishSignIn(): void;
}

/** Gong's sign-in page in a browser, which the person completes with finishSignIn(). */
export function fakeBrowser(options: { cookies?: Cookie[] } = {}): FakeBrowser {
  let origin: string | undefined;
  const browser: FakeBrowser = {
    clicks: [],
    typed: [],
    pressed: [],
    closed: false,
    finishSignIn() {
      origin = ORIGIN;
    },
    async signedIn() {
      return origin;
    },
    async screen() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    async click(x, y) {
      browser.clicks.push([x, y]);
    },
    async type(text) {
      browser.typed.push(text);
    },
    async press(key) {
      browser.pressed.push(key);
    },
    location() {
      return "app.gong.io";
    },
    userAgent() {
      return "ExampleBrowser/1.0";
    },
    async cookies(at) {
      if (at !== ORIGIN) return [];
      return options.cookies ?? [{ name: "session", value: "s1" }];
    },
    async close() {
      browser.closed = true;
    },
  };
  return browser;
}
