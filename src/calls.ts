/**
 * Gong's answers trimmed to what a reader needs. The web app's answers are
 * large (a search result carries every CRM field of every account; a call
 * page carries media links, speaker segments and settings; a transcript
 * carries every word with its timing), so the tools return these instead.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Drops undefined fields and empty arrays, so the summaries stay small. */
function compact<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined || (Array.isArray(o[k]) && (o[k] as unknown[]).length === 0)) delete o[k];
  return o;
}

export interface Person {
  name?: string;
  email?: string;
  title?: string;
  affiliation?: string;
  userId?: string;
}

function person(p: unknown): Person {
  if (!isObj(p)) return {};
  return compact({ name: str(p.name) ?? str(p.fullName), email: str(p.email) ?? str(p.emailAddress), title: str(p.title), affiliation: str(p.affiliation), userId: str(p.appUserId) });
}

export interface CallSummary {
  id: string;
  title?: string;
  startTime?: string;
  durationSec?: number;
  owner?: Person;
  participants?: Person[];
  accounts?: { name?: string; crmId?: string; deals?: { name?: string; crmId?: string }[] }[];
  topics?: { name?: string; coveragePercent?: number }[];
  direction?: string;
  scope?: string;
  status?: string;
  brief?: string;
  canAccess?: boolean;
}

/** One call from the conversations search. */
export function callSummary(item: unknown): CallSummary | undefined {
  if (!isObj(item)) return undefined;
  const id = str(item.id);
  if (!id) return undefined;
  const crm = isObj(item.crmData) ? item.crmData : {};
  return compact({
    id,
    title: str(item.title),
    startTime: str(item.effectiveStartDateTime) ?? str(item.userTimezoneActivityTime),
    durationSec: num(item.duration),
    owner: isObj(item.owner) ? person(item.owner) : undefined,
    participants: arr(item.participants).map(person),
    accounts: arr(crm.accounts)
      .filter(isObj)
      .map((a) =>
        compact({
          name: str(a.name),
          crmId: str(a.crmId),
          deals: arr(a.opportunities)
            .filter(isObj)
            .map((o) => compact({ name: str(o.name), crmId: str(o.crmId) }))
            .filter((o) => o.name || o.crmId),
        }),
      ),
    topics: arr(item.topics)
      .filter(isObj)
      .map((t) => compact({ name: str(t.name), coveragePercent: num(t.coveragePercent) })),
    direction: str(item.direction),
    scope: str(item.internalOrExternal),
    status: str(item.callStatus),
    brief: str(item.callBrief),
    canAccess: typeof item.userCanAccess === "boolean" ? item.userCanAccess : undefined,
  }) as CallSummary;
}

export interface SearchPage {
  total?: number;
  offset: number;
  calls: CallSummary[];
}

/** A page of the conversations search. */
export function searchPage(answer: unknown, offset: number): SearchPage {
  const o = isObj(answer) ? answer : {};
  const items = arr(o.items).length ? arr(o.items) : arr(o.callItemsStream);
  return compact({
    total: num(o.numOfTotalItemsThatPassedFilter),
    offset,
    calls: items.map(callSummary).filter((c): c is CallSummary => c !== undefined),
  }) as SearchPage;
}

/** Fields of the call page that carry media links, recordings or settings rather than what was discussed. */
const CALL_PAGE_NOISE = /url|path|src|poster|image|segments|media|recording|s3|sharing|permission|allowedto|options|integration|coaching|scorecard|playbook|collaborator|workspaces|speakersdata|techadmins|feedback|listened|lastTimePlayed/i;

/** Keeps the call page's content (participants, CRM context, topics, trackers, stats) and drops links, media and settings. */
export function callDetails(answer: unknown, depth = 0): unknown {
  if (Array.isArray(answer)) return answer.map((v) => callDetails(v, depth + 1));
  if (!isObj(answer)) return answer;
  if (depth > 8) return undefined;
  const out: Obj = {};
  for (const [k, v] of Object.entries(answer)) {
    if (CALL_PAGE_NOISE.test(k) || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const kept = callDetails(v, depth + 1);
    if (kept !== undefined && !(isObj(kept) && Object.keys(kept).length === 0)) out[k] = kept;
  }
  return out;
}

export interface TranscriptLine {
  at?: string;
  ms?: number;
  speaker?: string;
  text: string;
}

export interface Transcript {
  callId?: string;
  title?: string;
  when?: string;
  organizer?: string;
  companyParticipants?: Person[];
  customerParticipants?: Person[];
  lines: TranscriptLine[];
}

/**
 * The transcript as lines by speaker, without the word-by-word timing.
 * callId is the id asked for: Gong sends its own as a JSON number too long
 * for JavaScript to keep exact.
 */
export function transcript(answer: unknown, callId?: string): Transcript {
  const o = isObj(answer) ? answer : {};
  const customers: Person[] = [];
  if (isObj(o.customerParticipants)) {
    for (const [company, people] of Object.entries(o.customerParticipants)) for (const p of arr(people)) customers.push(compact({ ...person(p), company }) as Person);
  } else for (const p of arr(o.customerParticipants)) customers.push(person(p));
  const lines = arr(o.monologues)
    .filter(isObj)
    .map((m) => compact({ at: str(m.timestampStr), ms: num(m.timestamp), speaker: str(m.speakerName), text: str(m.text) ?? "" }) as TranscriptLine)
    .filter((l) => l.text !== "");
  // lines stays even when empty: an empty transcript is an answer, not a missing field.
  return {
    ...compact({
      callId: callId ?? (typeof o.callId === "string" ? o.callId : undefined),
      title: str(o.callTitle),
      when: str(o.when),
      organizer: str(o.callOrganizerName),
      companyParticipants: arr(o.companyParticipants).map(person),
      customerParticipants: customers,
    }),
    lines,
  };
}
