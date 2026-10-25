// Runs in each worker thread before the test file imports anything that reads
// these. Worker threads get their own copy of process.env.
import { inject } from "vitest";

const { databaseUrl, redisUrl } = inject("workerServices")[Number(process.env.VITEST_POOL_ID) - 1];
process.env.DATABASE_URL = databaseUrl;
process.env.REDIS_URL = redisUrl;
