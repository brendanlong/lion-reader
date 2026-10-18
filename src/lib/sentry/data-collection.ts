import type { init } from "@sentry/nextjs";

type DataCollection = NonNullable<NonNullable<Parameters<typeof init>[0]>["dataCollection"]>;

// Must always be passed explicitly: leaving `dataCollection` unset makes the
// SDK collect cookies, full request/response bodies (login passwords), headers
// (including the IP-bearing `x-forwarded-for`/`fly-client-ip`), query
// parameters, and gen-AI inputs/outputs (article text).
const IP_AND_FORWARDING_KEYS = ["forwarded", "-ip", "remote-", "via", "-user"];

export const SENTRY_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: IP_AND_FORWARDING_KEYS },
    response: { deny: IP_AND_FORWARDING_KEYS },
  },
  httpBodies: [],
  urlQueryParams: { deny: IP_AND_FORWARDING_KEYS },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: false, variables: false },
};
