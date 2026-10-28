import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DAY, GONG_ID, Unauthorized } from "./api.js";
import { callDetails, searchPage, transcript } from "./calls.js";
import type { SessionManager } from "./session.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Unofficial, read-only client for the user's own Gong account, through the same endpoints as Gong's web app, signed in as the user. Unaffiliated with Gong.",
  "search_calls finds calls by date range, title, account, deal, external contact email or company participant (find_people gives participant ids); get_call gives one call's participants, duration, topics and trackers; get_call_transcript gives what was said, by speaker.",
  "list_accounts and list_deals list the CRM accounts and deals Gong shows the user; their CRM ids narrow search_calls.",
  "whoami says who is signed in and in which workspace.",
  "Call content is the user's company's confidential data: quote only what the user asks for.",
  "When a tool says the user must sign in, call gong_login and give the user the link it returns; the user signs in on that page. Never ask for their password, codes or cookies in the chat.",
].join(" ");

const callId = z.string().regex(GONG_ID).describe("The call's Gong id, from search_calls (the number in a call page's ?id=).");
const day = z.string().regex(DAY);

const schemas = {
  empty: z.object({}),
  search: z.object({
    from: day.optional().describe("First day, YYYY-MM-DD. Default: 30 days ago."),
    to: day.optional().describe("Last day, YYYY-MM-DD. Default: today."),
    title: z.string().max(200).optional().describe("Words in the call's title."),
    account: z.string().max(200).optional().describe("Account (company) name, as in the CRM."),
    contactEmail: z.string().max(200).optional().describe("Email of an external participant."),
    accountCrmId: z.string().max(100).optional().describe("The account's CRM id, from list_accounts."),
    dealCrmId: z.string().max(100).optional().describe("The deal's (opportunity's) CRM id, from list_deals."),
    participantIds: z.array(z.string().regex(GONG_ID)).max(20).optional().describe("Gong user ids of company participants, from find_people."),
    limit: z.coerce.number().int().min(1).max(100).default(25).describe("How many calls, 1-100. Default 25."),
    offset: z.coerce.number().int().min(0).max(10_000).default(0).describe("Skip this many, for the next page."),
  }),
  call: z.object({ callId }),
  people: z.object({ text: z.string().min(1).max(30).describe("The start of a name or email.") }),
  accounts: z.object({ search: z.string().max(100).optional().describe("Account name to look for. Default: the accounts the user owns.") }),
  deals: z.object({ accountId: z.string().max(100).optional().describe("Only this account's deals: its id from list_accounts. Default: the user's deals.") }),
};

function jsonType(inner: z.ZodTypeAny): Record<string, unknown> {
  if (inner instanceof z.ZodNumber) return { type: "integer" };
  if (inner instanceof z.ZodArray) return { type: "array", items: { type: "string" } };
  if (inner instanceof z.ZodEnum) return { type: "string", enum: inner.options };
  return { type: "string" };
}

function inputSchema(schema: z.ZodObject<z.ZodRawShape>): Tool["inputSchema"] {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const field = value as z.ZodTypeAny;
    let inner = field;
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) inner = inner._def.innerType;
    properties[key] = { ...jsonType(inner), ...(field.description ? { description: field.description } : {}) };
    if (!field.isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

const TOOLS: { name: string; description: string; schema: z.ZodObject<z.ZodRawShape> }[] = [
  { name: "gong_login", description: "Get the link where the user signs in to Gong (Gong's own sign-in and the company's SSO run on that page, never in the chat). Returns the status when already signed in.", schema: schemas.empty },
  { name: "gong_session_status", description: "Whether this server is signed in to Gong, since when, until when, and the sign-in link when it is not.", schema: schemas.empty },
  { name: "gong_logout", description: "Forget the Gong session saved here.", schema: schemas.empty },
  { name: "whoami", description: "Who is signed in to Gong: the user, the company and the workspace this server reads.", schema: schemas.empty },
  { name: "search_calls", description: "Find calls, newest first: by date range, title, account, deal, external contact email or company participants. Returns the total and each call's id, title, start time, duration, owner, participants, account and deal, topics and Gong's brief.", schema: schemas.search },
  { name: "get_call", description: "One call's details: title, time, duration, participants (company and external), the account and deal, topics, trackers and other analysis Gong shows on the call page.", schema: schemas.call },
  { name: "get_call_transcript", description: "One call's transcript: what each speaker said, with timestamps.", schema: schemas.call },
  { name: "find_people", description: "Look up company users, teams and external people by the start of a name or email; company users' ids are for search_calls' participantIds.", schema: schemas.people },
  { name: "list_accounts", description: "CRM accounts Gong shows the user: the ones they own, or those matching a name.", schema: schemas.accounts },
  { name: "list_deals", description: "Deals (opportunities) Gong shows the user, or one account's.", schema: schemas.deals },
];

function daysAgo(n: number, now = Date.now()): string {
  return new Date(now - n * 86_400_000).toISOString().slice(0, 10);
}

export function createMcpServer(session: SessionManager): Server {
  const api = session.api;
  const server = new Server({ name: "gong-mcp", version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.schema) })),
  }));

  async function call(name: string, raw: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "gong_login": {
        const status = await session.status();
        if (status.state === "signed_in") return { ...status, message: "Already signed in." };
        return { ...status, message: `Ask the user to open ${status.signInUrl} and sign in to Gong there, then try the request again.` };
      }
      case "gong_session_status":
        return session.status();
      case "gong_logout":
        api.reset();
        await session.keeper.signOut();
        return { state: "signed_out", message: "Signed out here; the saved session is gone." };
      case "whoami":
        return api.pageContext();
      case "search_calls": {
        const args = schemas.search.parse(raw);
        const from = args.from ?? daysAgo(30);
        const answer = await api.searchCalls(
          {
            from,
            ...(args.to ? { to: args.to } : {}),
            ...(args.title ? { title: args.title } : {}),
            ...(args.account ? { accountName: args.account } : {}),
            ...(args.contactEmail ? { contactEmail: args.contactEmail } : {}),
            ...(args.accountCrmId ? { accountCrmId: args.accountCrmId } : {}),
            ...(args.dealCrmId ? { dealCrmId: args.dealCrmId } : {}),
            ...(args.participantIds?.length ? { userIds: args.participantIds } : {}),
          },
          args.limit,
          args.offset,
        );
        return searchPage(answer, args.offset);
      }
      case "get_call":
        return callDetails(await api.callData(schemas.call.parse(raw).callId));
      case "get_call_transcript": {
        const args = schemas.call.parse(raw);
        return transcript(await api.transcript(args.callId), args.callId);
      }
      case "find_people":
        return api.participants(schemas.people.parse(raw).text);
      case "list_accounts":
        return api.accounts(schemas.accounts.parse(raw).search);
      case "list_deals":
        return api.deals(schemas.deals.parse(raw).accountId);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await call(request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Unauthorized ? (await session.refused()).message : err instanceof z.ZodError ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : err instanceof Error ? err.message : "tool failed";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });

  return server;
}
