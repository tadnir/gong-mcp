/**
 * Made-up answers in the shapes of Gong's web app endpoints. Every id, name,
 * email and line of speech here is invented; none comes from a real account.
 */

const user = { firstName: "Alex", lastName: "Example", id: "1000000000000000001", emailAddress: "alex@example.com", companyId: "4000000000000000004", isAvatar: false };

/** The conversations page's inline globals, written the way Gong writes them: JavaScript, not JSON. */
export const CONVERSATIONS_PAGE = `<!DOCTYPE html><html><head><title>Gong | Conversations</title>
<script>
            var CurrentUser = function () {
                return {
                    firstName: "Alex",
                    lastName: "Example",
                    id: "1000000000000000001",
                    emailAddress: 'alex@example.com',
                    companyId: "4000000000000000004",
                    isAvatar: false,
                    displayPermissions: {"a": true, "b": "x, }"},
                    workspaces: [{"id": "2000000000000000002", "name": "Sales"}],
                    title: someExpression("ignored"),
                };
            }();
</script>
<script>
                var pageContext = {
                    companyId: "4000000000000000004",
                    workspaceId: "2000000000000000002",
                    companyName: "Example Co",
                    workspaceName: "Sales",
                    customReportParams: {},
                    isImmutableDemoCompany: false
                };
</script>
</head><body></body></html>`;

export const WHOAMI = {
  workspaceId: "2000000000000000002",
  workspaceName: "Sales",
  companyId: "4000000000000000004",
  companyName: "Example Co",
  user,
};

const alex = { appUserId: "1000000000000000001", name: "Alex Example", email: "alex@example.com", title: "AE", affiliation: "COMPANY", imageUrl: null, role: null };
const sam = { appUserId: null, name: "Sam Sample", email: "sam@example.org", title: "CTO", affiliation: "NON_COMPANY", imageUrl: null, role: null };

/** One search item, in the shape the conversations page gets: the parts the summary reads, plus some it drops. */
export function searchItem(id: string, n = 1): Record<string, unknown> {
  return {
    _itemType: "CALL",
    id,
    userCanAccess: true,
    participants: [alex, sam],
    userTimezoneActivityTime: "2026-01-15 10:00",
    crmData: {
      accounts: [{ crmId: "001EXAMPLE", gongId: "5000000000000000005", name: "Example Co", source: "OFFLINE", opportunities: [{ crmId: "006EXAMPLE", name: "Example Co - New", opportunityAtActivityTime: {}, customFields: [] }], contacts: [], customFields: [{ fieldName: "Size", valueAsString: "50" }] }],
      leads: [],
    },
    isPrivate: false,
    title: `Example Co / Intro ${n}`,
    effectiveStartDateTime: "2026-01-15T10:00:00",
    direction: "Conference",
    internalOrExternal: "External",
    duration: 1800,
    poster: "https://media.example.invalid/poster.png",
    owner: alex,
    ownerName: "Alex Example",
    topics: [{ name: "Pricing", coveragePercent: 20 }],
    callBrief: "A made-up brief.",
    callStatus: "COMPLETED",
  };
}

export const SEARCH_RESULTS = {
  numOfTotalItemsContainingSearchTerm: 1,
  numOfTotalItemsThatPassedFilter: 1,
  userShortTimeZone: "UTC",
  items: [searchItem("3000000000000000003")],
  errorMessage: null,
  callItemsStream: [searchItem("3000000000000000003")],
};

export const SEARCH_SUMMARY = {
  total: 1,
  offset: 0,
  calls: [
    {
      id: "3000000000000000003",
      title: "Example Co / Intro 1",
      startTime: "2026-01-15T10:00:00",
      durationSec: 1800,
      owner: { name: "Alex Example", email: "alex@example.com", title: "AE", affiliation: "COMPANY", userId: "1000000000000000001" },
      participants: [
        { name: "Alex Example", email: "alex@example.com", title: "AE", affiliation: "COMPANY", userId: "1000000000000000001" },
        { name: "Sam Sample", email: "sam@example.org", title: "CTO", affiliation: "NON_COMPANY" },
      ],
      accounts: [{ name: "Example Co", crmId: "001EXAMPLE", deals: [{ name: "Example Co - New", crmId: "006EXAMPLE" }] }],
      topics: [{ name: "Pricing", coveragePercent: 20 }],
      direction: "Conference",
      scope: "External",
      status: "COMPLETED",
      brief: "A made-up brief.",
      canAccess: true,
    },
  ],
};

export const CALL_DATA = {
  speakersData: { identifiedSpeakers: { "1": { totalSpeech: 100, segments: [{ fromTime: 0, toTime: 10 }] } }, unidentifiedSegments: [] },
  call: { id: "3000000000000000003", title: "Example Co / Intro 1", duration: 1800 },
  companySpeakers: [{ name: "Alex Example", talkTime: 40 }],
  nonCompanySpeakers: [{ name: "Sam Sample", talkTime: 60 }],
  topics: [{ name: "Pricing", duration: 300 }],
  smartTrackers: [{ name: "Competitors", count: 2 }],
  callMediaStreamUrlPrefix: "https://media.example.invalid/",
  mp3AudioPath: "https://media.example.invalid/a.mp3",
  userAllowedTo: { share: true },
  hasTranscript: true,
  relatedCalls: null,
  presentationSlides: [],
};

export const CALL_DETAILS = {
  call: { id: "3000000000000000003", title: "Example Co / Intro 1", duration: 1800 },
  companySpeakers: [{ name: "Alex Example", talkTime: 40 }],
  nonCompanySpeakers: [{ name: "Sam Sample", talkTime: 60 }],
  topics: [{ name: "Pricing", duration: 300 }],
  smartTrackers: [{ name: "Competitors", count: 2 }],
  hasTranscript: true,
};

export function transcriptAnswer(lines: string[] = ["Hello, this is a made-up line.", "And this is another one."]): Record<string, unknown> {
  return {
    companyId: 4000000000000000004,
    callCompanyName: "Example Co",
    callId: 3000000000000000003,
    callTitle: "Example Co / Intro 1",
    callCustomers: "Example Co",
    callOrganizerName: "Alex Example",
    recorded: true,
    when: "Jan 15",
    monologues: lines.map((text, i) => ({
      startingTopic: null,
      timestamp: i * 2500,
      speakerName: i % 2 ? "Sam" : "Alex",
      speakerId: String(i % 2),
      text,
      timestampStr: `0:0${i * 2}`,
      monologueWords: { speaker: { name: null, id: i % 2 }, terms: [{ start: 0, end: 1, text: "Hello", type: "WORD", confidence: 1 }] },
    })),
    shortNamesLookup: { "0": "Alex", "1": "Sam" },
    companyParticipants: [{ fullName: "Alex Example", companyName: "Example Co", title: "AE" }],
    customerParticipants: { "Other Example": [{ fullName: "Sam Sample", companyName: "Other Example", title: "CTO" }] },
    unknownParticipants: [],
    durationHours: 0.5,
  };
}

export const TRANSCRIPT = transcriptAnswer();

export const TRANSCRIPT_SUMMARY = {
  callId: "3000000000000000003",
  title: "Example Co / Intro 1",
  when: "Jan 15",
  organizer: "Alex Example",
  companyParticipants: [{ name: "Alex Example", title: "AE" }],
  customerParticipants: [{ name: "Sam Sample", title: "CTO", company: "Other Example" }],
  lines: [
    { at: "0:00", ms: 0, speaker: "Alex", text: "Hello, this is a made-up line." },
    { at: "0:02", ms: 2500, speaker: "Sam", text: "And this is another one." },
  ],
};

export const PEOPLE = {
  PEOPLE: [{ id: "1000000000000000001", name: "Alex Example", email: "alex@example.com", affiliation: "COMPANY" }],
  TEAMS: [],
};

export const ACCOUNTS = { filteredCrmObjectsList: [{ id: "5000000000000000005", name: "Example Co", crmId: "001EXAMPLE" }] };

export const DEALS = { deals: [{ id: "6000000000000000006", name: "Example Co - New", crmId: "006EXAMPLE", stage: "Discovery" }] };
