import { afterEach, describe, expect, test } from "vitest";
import { request } from "node:http";
import { READ_PATHS, assertRead, assignedObject, callSearchJson } from "../src/api.js";
import { signedInOrigin, isRequestToken } from "../src/login.js";
import { SessionManager } from "../src/session.js";
import { createMcpServer } from "../src/server.js";
import { ORIGIN, fakeBrowser, fakeFetch, json, memoryStore, type FakeBrowser } from "./helpers.js";
import * as fixtures from "./fixtures.js";

/** Gong's web app for a made-up account: answers only with the session cookie, POSTs only with the request token. */
function world() {
  return fakeFetch((call) => {
    const url = new URL(call.url);
    if (url.origin !== ORIGIN) return new Response("wrong host", { status: 421 });
    if (call.headers.cookie !== "session=s1") {
      if (url.pathname === "/ajax/common/rtkn") return json({ error: "unauthorized" }, 401);
      return new Response("", { status: 302, headers: { location: "/welcome/sign-in?targeturl=%2F" } });
    }
    if (call.method === "POST" && call.headers["X-CSRF-TOKEN"] !== "t0ken") return json({ error: "csrf" }, 403);
    switch (url.pathname) {
      case "/ajax/common/rtkn":
        return json({ headerName: "X-CSRF-TOKEN", token: "t0ken" }, 200, { "set-cookie": "session=s1; Path=/; HttpOnly" });
      case "/conversations":
        return new Response(fixtures.CONVERSATIONS_PAGE, { headers: { "content-type": "text/html" } });
      case "/conversations/ajax/results":
        return json(fixtures.SEARCH_RESULTS);
      case "/ajax/call/get-call-data":
        return json(fixtures.CALL_DATA);
      case "/call/detailed-transcript":
        return json(fixtures.TRANSCRIPT);
      case "/conversations/ajax/participants-suggestions":
        return json(fixtures.PEOPLE);
      case "/engagewebapi/ajax/prospecting/accounts-by-owner-or-search-key":
        return json(fixtures.ACCOUNTS);
      case "/engagewebapi/ajax/ae-home/get-deals-list":
        return json(fixtures.DEALS);
      default:
        return undefined;
    }
  });
}

function http(port: number, method: string, path: string, body?: string, host = `127.0.0.1:${port}`, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host, "content-type": "application/x-www-form-urlencoded", ...extra } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode!, text: t }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

let session: SessionManager | undefined;
afterEach(() => session?.stop());

async function signedOutSession() {
  const browsers: FakeBrowser[] = [];
  const f = world();
  session = new SessionManager({
    store: memoryStore(),
    fetch: f,
    port: 0,
    stepWaitMs: 50,
    watchMs: 10,
    openBrowser: async () => {
      const b = fakeBrowser();
      browsers.push(b);
      return b;
    },
  });
  await session.start();
  const url = await session.signInUrl();
  return { f, session, browsers, port: Number(new URL(url).port) };
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)![1]!;
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("sign-in page", () => {
  test("Gong's sign-in is shown live, input reaches it, and it finishes by itself", async () => {
    const { session, browsers, port, f } = await signedOutSession();
    const first = await http(port, "GET", "/");
    expect(first.text).toContain("Open Gong&#39;s sign-in");
    const csrf = csrfOf(first.text);

    expect((await http(port, "POST", "/start", `csrf=${csrf}&length=1d`)).status).toBe(303);
    const browser = browsers[0]!;
    const page = await http(port, "GET", "/");
    expect(page.text).toContain("Finish signing in");
    expect(page.text).toContain("app.gong.io");
    expect(page.text).toContain('src="screen.js"');
    expect((await http(port, "GET", "/screen.js")).text).toContain("x-screen-live");
    expect((await http(port, "GET", "/screen.png")).status).toBe(200);

    expect((await http(port, "POST", "/click", `csrf=${csrf}&p.x=10&p.y=20`, undefined, { "x-screen-live": "1" })).status).toBe(204);
    expect((await http(port, "POST", "/type", `csrf=${csrf}&text=someone%40example.com`, undefined, { "x-screen-live": "1" })).status).toBe(204);
    expect((await http(port, "POST", "/key", `csrf=${csrf}&key=Enter`)).status).toBe(303);
    expect((await http(port, "POST", "/key", `csrf=${csrf}&key=F12`)).status).toBe(303);
    expect(browser.clicks).toEqual([[10, 20]]);
    expect(browser.typed).toEqual(["someone@example.com"]);
    expect(browser.pressed).toEqual(["Enter"]);
    expect(session.keeper.status().state).toBe("signed_out");

    browser.finishSignIn();
    await until(() => session.keeper.status().state === "signed_in");
    expect(session.keeper.status()).toMatchObject({ state: "signed_in", endsAt: expect.any(String) });
    expect(session.keeper.origin()).toBe(ORIGIN);
    // Later calls go to the account's own host, as the browser that signed in.
    await session.api.ping();
    expect(f.calls.at(-1)!.url).toBe(`${ORIGIN}/ajax/common/rtkn`);
    expect(f.calls.at(-1)!.headers["user-agent"]).toBe("ExampleBrowser/1.0");
    expect(browser.closed).toBe(true);
    expect((await http(port, "GET", "/screen.png")).status).toBe(404);
    expect((await http(port, "POST", "/click", `csrf=${csrf}&p.x=1&p.y=1`, undefined, { "x-screen-live": "1" })).status).toBe(410);

    const status = (await http(port, "GET", "/")).text;
    expect(status).toContain("Signed in to Gong");
    expect((await http(port, "POST", "/sign-out", `csrf=${csrf}`)).status).toBe(303);
    expect(session.keeper.status().state).toBe("signed_out");
  });

  test("other hosts, forms without the token and bad input are refused", async () => {
    const { port, browsers } = await signedOutSession();
    expect((await http(port, "GET", "/", undefined, "attacker.example")).status).toBe(421);
    expect((await http(port, "POST", "/start", "csrf=nope&length=1d")).status).toBe(400);
    const csrf = csrfOf((await http(port, "GET", "/")).text);
    expect((await http(port, "POST", "/start", `csrf=${csrf}&length=forever`)).status).toBe(400);
    expect(browsers).toHaveLength(0);
  });

  test("cancel closes the browser", async () => {
    const { port, browsers, session } = await signedOutSession();
    const csrf = csrfOf((await http(port, "GET", "/")).text);
    await http(port, "POST", "/start", `csrf=${csrf}&length=1h`);
    expect((await http(port, "POST", "/cancel", `csrf=${csrf}`)).status).toBe(303);
    expect(browsers[0]!.closed).toBe(true);
    expect((await http(port, "GET", "/")).text).toContain("Open Gong&#39;s sign-in");
    expect(session.keeper.status().state).toBe("signed_out");
  });
});

describe("tools", () => {
  async function callTool(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) {
    const handler = (server as unknown as { _requestHandlers: Map<string, (r: unknown, x: unknown) => Promise<unknown>> })._requestHandlers.get("tools/call")!;
    return (await handler({ method: "tools/call", params: { name, arguments: args } }, {})) as { isError?: boolean; content: { text: string }[] };
  }
  const result = async (server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(server, name, args);
    if (r.isError) throw new Error(r.content[0]!.text);
    return JSON.parse(r.content[0]!.text);
  };

  async function signedIn() {
    const s = await signedOutSession();
    await s.session.keeper.signedIn([{ name: "session", value: "s1" }], ORIGIN, 3_600_000);
    return { ...s, server: createMcpServer(s.session) };
  }

  test("every tool is listed with a schema", async () => {
    const { server } = await signedIn();
    const handler = (server as unknown as { _requestHandlers: Map<string, (r: unknown, x: unknown) => Promise<unknown>> })._requestHandlers.get("tools/list")!;
    const { tools } = (await handler({ method: "tools/list", params: {} }, {})) as { tools: { name: string; inputSchema: { properties: Record<string, { type: string }> } }[] };
    expect(tools.map((t) => t.name)).toEqual(["gong_login", "gong_session_status", "gong_logout", "whoami", "search_calls", "get_call", "get_call_transcript", "find_people", "list_accounts", "list_deals"]);
    const search = tools.find((t) => t.name === "search_calls")!.inputSchema.properties;
    expect(search.limit!.type).toBe("integer");
    expect(search.participantIds!.type).toBe("array");
  });

  test("signed out: data tools answer with the sign-in link", async () => {
    const { session, port } = await signedOutSession();
    const r = await callTool(createMcpServer(session), "search_calls", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(`http://localhost:${port}/`);
    expect(r.content[0]!.text).toContain("Never ask the user");
  });

  test("whoami reads the conversations page's own context", async () => {
    const { server } = await signedIn();
    expect(await result(server, "whoami")).toEqual(fixtures.WHOAMI);
  });

  test("search_calls posts the conversations page's search, with the request token and workspace", async () => {
    const { server, f } = await signedIn();
    const r = await result(server, "search_calls", { from: "2026-01-01", to: "2026-01-31", account: "Example Co", participantIds: ["1000000000000000001"], limit: 10 });
    expect(r).toEqual(fixtures.SEARCH_RESULTS);
    const post = f.calls.find((c) => c.url.includes("/conversations/ajax/results"))!;
    expect(post.method).toBe("POST");
    expect(post.url).toBe(`${ORIGIN}/conversations/ajax/results?workspace-id=2000000000000000002`);
    expect(post.headers["X-CSRF-TOKEN"]).toBe("t0ken");
    const body = JSON.parse(post.body!) as { callsSearchJson: string; pageSize: number; callsOffset: number };
    expect(body.pageSize).toBe(10);
    expect(body.callsOffset).toBe(0);
    expect(JSON.parse(body.callsSearchJson)).toEqual({
      search: {
        type: "And",
        filters: [
          { type: "AbsoluteCallDateRange", from: "2026-01-01", to: "2026-01-31" },
          { type: "AccountName", phrase: "Example Co" },
          { type: "Participants", userIds: ["1000000000000000001"], host: true, attendee: true, invitee: true },
        ],
      },
    });
  });

  test("call, transcript, people, accounts and deals read the web app's endpoints", async () => {
    const { server, f } = await signedIn();
    expect(await result(server, "get_call", { callId: "3000000000000000003" })).toEqual(fixtures.CALL_DATA);
    expect(f.calls.at(-1)!.url).toBe(`${ORIGIN}/ajax/call/get-call-data?call-id=3000000000000000003`);
    expect(await result(server, "get_call_transcript", { callId: "3000000000000000003" })).toEqual(fixtures.TRANSCRIPT);
    expect(f.calls.at(-1)!.url).toBe(`${ORIGIN}/call/detailed-transcript?call-id=3000000000000000003`);
    expect(await result(server, "find_people", { text: "Ali" })).toEqual(fixtures.PEOPLE);
    expect(f.calls.at(-1)!.url).toBe(`${ORIGIN}/conversations/ajax/participants-suggestions?workspace-id=2000000000000000002&partial-text=Ali`);
    expect(await result(server, "list_accounts", { search: "Example" })).toEqual(fixtures.ACCOUNTS);
    expect(f.calls.at(-1)!.url).toBe(`${ORIGIN}/engagewebapi/ajax/prospecting/accounts-by-owner-or-search-key?workspace-id=2000000000000000002&search-keyword=Example`);
    expect(await result(server, "list_deals", {})).toEqual(fixtures.DEALS);
    expect(f.calls.at(-1)!.url).toBe(`${ORIGIN}/engagewebapi/ajax/ae-home/get-deals-list?workspace-id=2000000000000000002`);
    expect(f.calls.every((c) => c.method === "GET" || c.url.includes("/conversations/ajax/results"))).toBe(true);
  });

  test("a refused cookie ends the session and the tools ask for a sign-in", async () => {
    const { session } = await signedOutSession();
    await session.keeper.signedIn([{ name: "session", value: "stale" }], ORIGIN, 3_600_000);
    const r = await callTool(createMcpServer(session), "get_call", { callId: "3000000000000000003" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Not signed in");
    expect(session.keeper.status().state).toBe("expired");
  });

  test("Gong's sign-in page in place of an answer ends the session too", async () => {
    const f = fakeFetch((call) => {
      if (new URL(call.url).pathname === "/ajax/common/rtkn") return json({ headerName: "X-CSRF-TOKEN", token: "t0ken" });
      return new Response('<html><head><title>Gong | Sign in</title></head><body><form action="/welcome/sign-in"></form></body></html>', { headers: { "content-type": "text/html" } });
    });
    session = new SessionManager({ store: memoryStore(), fetch: f, port: 0 });
    await session.keeper.signedIn([{ name: "session", value: "s1" }], ORIGIN, 3_600_000);
    const r = await callTool(createMcpServer(session), "get_call_transcript", { callId: "3000000000000000003" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Not signed in");
    expect(session.keeper.status().state).toBe("expired");
  });

  test("the keep-alive check uses the session", async () => {
    const { session } = await signedIn();
    await session.keeper.tick();
    expect(session.keeper.status()).toMatchObject({ state: "signed_in" });
    expect(session.keeper.status().lastError).toBeUndefined();
  });

  test("bad ids and arguments never reach a URL", async () => {
    const { server, f } = await signedIn();
    const before = f.calls.length;
    expect((await callTool(server, "get_call", { callId: "../x" })).isError).toBe(true);
    expect((await callTool(server, "get_call_transcript", { callId: "1; drop" })).isError).toBe(true);
    expect((await callTool(server, "search_calls", { from: "yesterday" })).isError).toBe(true);
    expect((await callTool(server, "search_calls", { participantIds: ["me"] })).isError).toBe(true);
    expect((await callTool(server, "search_calls", { limit: 1000 })).isError).toBe(true);
    expect(f.calls.length).toBe(before);
  });
});

describe("read-only", () => {
  test("only the listed reads can be called: no other path, and no POST but the web app's read POSTs", () => {
    expect(() => assertRead("GET", "/ajax/call/get-call-data")).not.toThrow();
    expect(() => assertRead("POST", "/conversations/ajax/results")).not.toThrow();
    expect(() => assertRead("POST", "/ajax/call/get-call-data")).toThrow(/only reads/);
    expect(() => assertRead("DELETE", "/conversations/ajax/results")).toThrow(/only reads/);
    expect(() => assertRead("POST", "/json/call/share-internal")).toThrow(/not one of/);
    expect(() => assertRead("GET", "/ajax/call/rename")).toThrow(/not one of/);
    for (const path of READ_PATHS) expect(path).not.toMatch(/share|delete|update|save|create|edit|remove|set-|add|mark|purge|move|rename|comment|score|feedback/);
  });
});

describe("helpers", () => {
  test("the search JSON defaults to a since-date range and drops empty filters", () => {
    expect(callSearchJson({ from: "2026-01-01" })).toEqual({ search: { type: "And", filters: [{ type: "SinceCallDateRange", from: "2026-01-01" }] } });
    expect(callSearchJson({ from: "2026-01-01", title: "Kickoff", contactEmail: "a@example.com", accountCrmId: "001X", dealCrmId: "006Y", userIds: [] }).search.filters).toEqual([
      { type: "SinceCallDateRange", from: "2026-01-01" },
      { type: "CallTitle", phrase: "Kickoff" },
      { type: "ContactEmail", phrase: "a@example.com" },
      { type: "AccountCrmId", phrase: "001X" },
      { type: "OpportunityCrmId", phrase: "006Y" },
    ]);
  });

  test("inline page objects are read as JSON, strings with braces included", () => {
    const html = `<script>window.pageContext = {"workspaceId":"1","note":"a } b {"};\nvar CurrentUser = {"id":"2"};</script>`;
    expect(assignedObject(html, "pageContext")).toEqual({ workspaceId: "1", note: "a } b {" });
    expect(assignedObject(html, "CurrentUser")).toEqual({ id: "2" });
    expect(assignedObject(html, "missing")).toBeUndefined();
    expect(assignedObject("window.pageContext = {not: json}", "pageContext")).toBeUndefined();
  });

  test("signed in means a Gong host outside its sign-in pages", () => {
    expect(signedInOrigin(`${ORIGIN}/home`)).toBe(ORIGIN);
    expect(signedInOrigin("https://app.gong.io/welcome/sign-in")).toBeUndefined();
    expect(signedInOrigin("https://accounts.google.com/o/oauth2")).toBeUndefined();
    expect(signedInOrigin("https://gong.io.example.com/home")).toBeUndefined();
    expect(signedInOrigin("http://app.gong.io/home")).toBeUndefined();
    expect(isRequestToken('{"headerName":"X-CSRF-TOKEN","token":"abc"}')).toBe(true);
    expect(isRequestToken("<html>")).toBe(false);
    expect(isRequestToken('{"token":""}')).toBe(false);
  });
});
