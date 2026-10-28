# gong-mcp

**Read your own [Gong](https://www.gong.io) calls from an AI assistant over MCP: search calls, read a call's participants, topics and trackers, read its transcript, and list your accounts and deals, signed in with your own Gong web session.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Unofficial. Not affiliated with Gong. It uses the same endpoints as Gong's web app, which can change without notice. Gong's [public API](https://gong.app.gong.io/settings/api/documentation) needs an API key from a Gong admin; this one exists for people who don't have one and only need to read what they can already see in the web app.

Everything runs on your machine. You sign in on Gong's own sign-in page, in a browser this server opens, the session is saved only on your computer, and this project has no hosted backend and collects nothing. Whatever your AI client requests is passed to that client and handled under its provider's privacy terms.

## Terms of use

- **Own account only**, and within your company's policies for Gong data.
- **Read-only.** Every call this server makes is one Gong's web app makes to read the same page, from a fixed list in `src/api.ts`. It never shares, comments, scores, renames or changes anything.
- **The session file is secret.** It holds Gong's session cookies, is saved with mode `0600` under `~/.config/gong-mcp/`, and must never be committed or pasted.

## Install

```sh
git clone <this repository> gong-mcp
cd gong-mcp
npm install
npx playwright install chromium
npm test
```

## Use it from Claude Code

```sh
claude mcp add --scope user --transport stdio gong -- /absolute/path/to/gong-mcp/node_modules/.bin/tsx /absolute/path/to/gong-mcp/src/main.ts
```

`--scope user` makes it available in every project; leave it out to add it to the current one only.

Or from any MCP client:

```json
{
  "mcpServers": {
    "gong": {
      "command": "npx",
      "args": ["tsx", "src/main.ts"],
      "cwd": "/absolute/path/to/gong-mcp"
    }
  }
}
```

For Claude Desktop, use absolute paths: `"command": "/absolute/path/to/node"` with `"args": ["/absolute/path/to/gong-mcp/node_modules/.bin/tsx", "/absolute/path/to/gong-mcp/src/main.ts"]`.

### Signing in

1. Ask your assistant something, for example "what calls did I have with Example Co last week?".
2. While nobody is signed in, the tools answer with a link to a sign-in page this server serves on `http://localhost:8769/`. `gong_login` returns the same link.
3. Open it, pick how long to stay signed in (1 hour to 30 days) and press **Open Gong's sign-in**. A Chromium window opens on Gong's sign-in page.
4. Sign in there as you always do: Google, Microsoft 365, Salesforce or email, and whatever your company's sign-in asks next. You can use the window itself, or the live picture of it on the sign-in page. The window closes by itself once Gong says you are signed in.
5. Ask again.

Your email, password and codes are only ever typed on Gong's and your identity provider's own pages. The assistant only ever sees the link. Nothing on those pages is typed, solved or skipped for you.

The browser keeps its profile in `GONG_CONFIG_DIR/browser`, so an identity provider that remembers devices asks less next time. Gong sends each account to a regional host (`us-NNNNN.app.gong.io`); the server keeps the cookies for that host and calls it directly.

Gong's web session has no refresh token. While the MCP server runs it checks in with Gong every 10 minutes, saves any cookies Gong sets, and forgets the session at the end of the length you picked, or as soon as Gong refuses it (when the next tool call answers with the sign-in link again). A restart picks the saved session back up if it hasn't ended in between.

### Tools

| Tool | What it reads |
| --- | --- |
| `search_calls` | Calls by date range, title, account name, deal or account CRM id, external contact email, or company participants; newest first, paged |
| `get_call` | One call: title, time, duration, participants, account and deal, topics, trackers |
| `get_call_transcript` | One call's transcript, by speaker, with timestamps |
| `find_people` | Company users (their ids filter `search_calls`), teams and external people by the start of a name or email |
| `list_accounts` | CRM accounts you own, or that match a name |
| `list_deals` | Your deals, or one account's |
| `whoami` | Who is signed in, the company and the workspace |
| `gong_login`, `gong_session_status`, `gong_logout` | The sign-in link, whether a session is live and until when, and forgetting it |

### Saving every transcript

```sh
npm run export-transcripts -- --count-only   # how many calls the account can see
npm run export-transcripts                   # save them all
```

This saves the transcript of every call the signed-in account can see into `~/gong-transcripts/` (or `--dir`, or `GONG_EXPORT_DIR`): one `<call id>.json` per call, with its title, start time, duration, participants, account, deal, topics and transcript lines by speaker, plus an `index.json` that says for each call whether it was saved, had no transcript, could not be opened by this account, or failed. The directory is created with mode `0700` and every file with `0600`. If nobody is signed in, it prints the sign-in link and starts once you have signed in.

It makes one request at a time, at most one a second (`--delay-ms`), and waits longer when Gong asks it to slow down. It is resumable: a second run skips what is already saved, so after a stop it carries on (`--retry-failed` also tries the failures again). It stops cleanly, keeping the index, when the session ends or when Gong's bot protection asks for a browser check, which it never tries to get past. `--from YYYY-MM-DD` limits it to recent calls. It prints counts only.

These files are your company's call content: keep them on an encrypted disk, out of any repository or synced folder, and within your company's data policy.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GONG_CONFIG_DIR` | `~/.config/gong-mcp` | Where the session and the sign-in browser's profile are saved |
| `GONG_LOGIN_HOST` | `127.0.0.1` | Address the sign-in page listens on |
| `GONG_LOGIN_PORT` | `8769` | Its port; a free one is used if another copy holds it |
| `GONG_LOGIN_URL` | `http://localhost:<port>/` | The link handed out, when the page sits behind a reverse proxy. When set, the page starts with the server. |
| `GONG_HEADLESS` | `false` | `true` hides the sign-in browser's window; the sign-in page still shows it. Google's sign-in refuses headless Chromium. On Linux without a screen the server starts an Xvfb one (install `xvfb`), as the image does |
| `GONG_CHROMIUM_PATH` | Playwright's Chromium | Another Chromium to sign in with |
| `GONG_EXPORT_DIR` | `~/gong-transcripts` | Where `export-transcripts` saves |
| `GONG_LOG_FILE` | none | Also write the log here, for example `/proc/1/fd/2` when an MCP proxy that drops its servers' stderr is the container's main process |

## Hosting one long-lived copy

To share one session between several clients, run a single copy on an always-on machine and put a stdio-to-HTTP MCP proxy in front of it, such as [TBXark/mcp-proxy](https://github.com/TBXark/mcp-proxy), with a bearer token per client. Keep it on your own network or a private VPN, never on the internet. Put the sign-in page behind your own authentication and set `GONG_LOGIN_URL` to its address (and `GONG_LOGIN_HOST=0.0.0.0` inside a container). Its links and forms are relative, so it can sit at the root of a host or under a path whose prefix the reverse proxy strips (`GONG_LOGIN_URL=https://mcp.example.com/gong/login/`, with the trailing slash).

Every token holder reads the calls of whoever signed in on the page; the proxy's tokens and the Gong session are unrelated. For a second person, run a second copy with its own `GONG_CONFIG_DIR`, tokens and sign-in page.

The `Dockerfile` builds an image of the stdio server with Chromium, with the session in `/data` and the page on port 8769. Run it with `docker run -i`, or use it as a base for an image that adds your MCP proxy.

The sign-in page answers only to `localhost`, `127.0.0.1` and the host in `GONG_LOGIN_URL`, and each form carries a per-process token. Anyone who can open the page can sign in or out, so keep it on loopback or behind your own authentication.

## License

[MIT](LICENSE)
