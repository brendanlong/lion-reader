/**
 * Wallabag API: Entries (.json suffix)
 *
 * GET/POST /api/wallabag/api/entries.json
 *
 * Mirrors the /api/wallabag/api/entries endpoint.
 * The Wallabag Android app uses .json suffixed endpoints.
 */

export { GET, POST } from "../entries/route";
