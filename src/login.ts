/**
 * Signing in to Gong: Gong's own sign-in page (email, Google, Microsoft 365
 * or Salesforce), and whatever the company's identity provider asks after it
 * (a password, a second factor, a device prompt).
 *
 * The whole sign-in runs inside a real browser (Playwright's Chromium) on
 * Gong's site and the provider's pages. This server knows nothing about those
 * pages: its sign-in page shows the browser's screen and passes the person's
 * clicks and typing on, and the browser's own window can be used directly
 * too. Nothing is typed automatically, and no check on those pages is
 * skipped or solved for the person. Once Gong's web app hands the browser its
 * request token, the server keeps the browser's Gong cookies and closes it.
 */
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { SITE_ORIGIN, isGongHost } from "./api.js";
import type { Cookie } from "./cookies.js";
import { configDir } from "./store.js";

export const LOGIN_PAGE_URL = `${SITE_ORIGIN}/welcome/sign-in`;

export class GongLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GongLoginError";
  }
}

/** The browser the sign-in runs in, open on Gong's sign-in page. */
export interface LoginBrowser {
  /** The Gong host the browser is signed in on, or undefined while it is not. */
  signedIn(): Promise<string | undefined>;
  /** The browser's screen as a PNG. */
  screen(): Promise<Uint8Array>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  /** The host the browser is on, for the person to see where they are. */
  location(): string;
  /** Gong's cookies for that host, HttpOnly ones included. */
  cookies(origin: string): Promise<Cookie[]>;
  /** The browser's user agent, which Gong may tie the session to. */
  userAgent(): string;
  close(): Promise<void>;
}

export type OpenBrowser = () => Promise<LoginBrowser>;

/** The keys the sign-in page can send besides typed text. */
export const KEYS = ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown"] as const;

/** Where a page of the web app counts as signed in: a Gong host, outside its sign-in pages. */
export function signedInOrigin(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !isGongHost(u.hostname)) return undefined;
    if (/^\/(welcome|login|sso|saml|oauth)/.test(u.pathname)) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** The answer to the web app's request-token call, as it reads it. */
export function isRequestToken(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { token?: unknown };
    return typeof parsed?.token === "string" && parsed.token.length > 0;
  } catch {
    return false;
  }
}

let virtualScreen: Promise<string> | undefined;

/**
 * A windowed browser on a Linux machine without a screen gets an Xvfb one,
 * started once and kept for the process's life.
 */
function display(): Promise<string | undefined> {
  if (process.platform !== "linux" || process.env.DISPLAY) return Promise.resolve(process.env.DISPLAY);
  virtualScreen ??= (async () => {
    const n = 90 + Math.floor(Math.random() * 400);
    const xvfb = spawn("Xvfb", [`:${n}`, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: "ignore", detached: false });
    xvfb.unref();
    const failed = new Promise<never>((_, reject) => xvfb.once("error", (err) => reject(new GongLoginError(`Could not start Xvfb for the sign-in browser (${err.message}). Install xvfb, or set GONG_HEADLESS=true.`))));
    for (let i = 0; i < 50; i++) {
      const up = await Promise.race([access(`/tmp/.X11-unix/X${n}`).then(() => true, () => false), failed]);
      if (up) return `:${n}`;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    xvfb.kill();
    throw new GongLoginError("Xvfb did not start for the sign-in browser.");
  })().catch((err: unknown) => {
    virtualScreen = undefined;
    throw err;
  });
  return virtualScreen;
}

/**
 * Chromium on Gong's sign-in page, with a window unless GONG_HEADLESS=true
 * (Google's sign-in refuses headless browsers); GONG_CHROMIUM_PATH picks
 * another Chromium than Playwright's own. It keeps one profile in
 * GONG_CONFIG_DIR/browser, so an identity provider that remembers the device
 * asks less next time. It runs as Playwright starts it: nothing hides that
 * the browser is automated.
 */
export async function openChromium(): Promise<LoginBrowser> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new GongLoginError("Playwright is not installed: run `npm install` and `npx playwright install chromium`.");
  }
  const headless = process.env.GONG_HEADLESS === "true";
  const executablePath = process.env.GONG_CHROMIUM_PATH || undefined;
  const profile = join(configDir(), "browser");
  // One sign-in runs at a time, so a lock left in the profile is from a browser that died with its container.
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await rm(join(profile, lock), { force: true });
  const screen = headless ? undefined : await display();
  const context = await chromium
    .launchPersistentContext(profile, {
      headless,
      ...(screen ? { env: { ...process.env, DISPLAY: screen } } : {}),
      ...(executablePath ? { executablePath } : {}),
      viewport: { width: 1000, height: 760 },
      deviceScaleFactor: 1,
    })
    .catch((err: unknown) => {
      throw new GongLoginError(`Could not start Chromium (${err instanceof Error ? err.message : String(err)}). Run \`npx playwright install chromium\`.`);
    });
  try {
    // The page the person is on: a provider may open its sign-in in a new window.
    let page = context.pages()[0] ?? (await context.newPage());
    context.on("page", (opened) => {
      page = opened;
      opened.on("close", () => {
        const open = context.pages();
        if (open.length > 0) page = open[open.length - 1]!;
      });
    });
    const userAgent = String(await page.evaluate("navigator.userAgent"));
    await page.goto(LOGIN_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return {
      async signedIn() {
        for (const candidate of context.pages()) {
          const origin = signedInOrigin(candidate.url());
          if (!origin) continue;
          const res = await context.request.get(`${origin}/ajax/common/rtkn`, { headers: { accept: "application/json; charset=utf-8" }, failOnStatusCode: false, maxRedirects: 0 });
          if (res.status() === 200 && isRequestToken(await res.text())) return origin;
        }
        return undefined;
      },
      async screen() {
        return new Uint8Array(await page.screenshot({ type: "png" }));
      },
      async click(x, y) {
        const size = page.viewportSize() ?? { width: 1000, height: 760 };
        await page.mouse.click(Math.min(Math.max(x, 0), size.width), Math.min(Math.max(y, 0), size.height));
      },
      async type(text) {
        await page.keyboard.type(text, { delay: 30 });
      },
      async press(key) {
        await page.keyboard.press(key);
      },
      location() {
        try {
          return new URL(page.url()).host;
        } catch {
          return "";
        }
      },
      async cookies(origin) {
        // Every cookie the signed-in host gets, whatever its path.
        const host = new URL(origin).hostname;
        const forSite = (await context.cookies()).filter((c) => {
          const domain = c.domain.replace(/^\./, "");
          return host === domain || host.endsWith(`.${domain}`);
        });
        // Where two share a name, the one sent to the most specific domain, then to the site's root, wins.
        forSite.sort((a, b) => a.domain.replace(/^\./, "").length - b.domain.replace(/^\./, "").length || (a.path === "/" ? 1 : 0) - (b.path === "/" ? 1 : 0));
        const byName = new Map(forSite.map((c) => [c.name, c]));
        return [...byName.values()].map((c) => ({ name: c.name, value: c.value, ...(c.expires > 0 ? { expires: Math.floor(c.expires) } : {}) }));
      },
      userAgent() {
        return userAgent;
      },
      async close() {
        await context.close();
      },
    };
  } catch (err) {
    await context.close().catch(() => undefined);
    throw err instanceof GongLoginError ? err : new GongLoginError(`Could not open Gong's sign-in page: ${err instanceof Error ? err.message : String(err)}`);
  }
}
