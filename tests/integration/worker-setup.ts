// Runs in each worker thread before the test file imports anything that reads
// these. Worker threads get their own copy of process.env.
import { workerDatabaseUrl, workerRedisUrl } from "./worker-services";

const poolId = Number(process.env.VITEST_POOL_ID);
process.env.DATABASE_URL = workerDatabaseUrl(process.env.DATABASE_URL!, poolId);
process.env.REDIS_URL = workerRedisUrl(process.env.REDIS_URL!, poolId);
