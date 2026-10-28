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

export const SEARCH_RESULTS = {
  totalCount: 1,
  items: [{ id: "3000000000000000003", title: "Example Co / Intro", ownerName: "Alex Example", startTime: "2026-01-15T10:00:00Z", duration: 1800 }],
};

export const CALL_DATA = {
  id: "3000000000000000003",
  title: "Example Co / Intro",
  duration: 1800,
  participants: [
    { name: "Alex Example", email: "alex@example.com", affiliation: "COMPANY" },
    { name: "Sam Sample", email: "sam@example.org", affiliation: "EXTERNAL" },
  ],
  topics: [{ name: "Pricing", duration: 300 }],
  trackers: [{ name: "Competitors", count: 2 }],
};

export const TRANSCRIPT = {
  monologues: [
    { speakerId: "s1", sentences: [{ start: 0, end: 2000, text: "Hello, this is a made-up line." }] },
    { speakerId: "s2", sentences: [{ start: 2500, end: 4000, text: "And this is another one." }] },
  ],
};

export const PEOPLE = {
  PEOPLE: [{ id: "1000000000000000001", name: "Alex Example", email: "alex@example.com", affiliation: "COMPANY" }],
  TEAMS: [],
};

export const ACCOUNTS = { filteredCrmObjectsList: [{ id: "5000000000000000005", name: "Example Co", crmId: "001EXAMPLE" }] };

export const DEALS = { deals: [{ id: "6000000000000000006", name: "Example Co - New", crmId: "006EXAMPLE", stage: "Discovery" }] };
