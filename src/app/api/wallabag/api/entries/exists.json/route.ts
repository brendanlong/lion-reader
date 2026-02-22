/**
 * Wallabag API: Entry Exists (.json suffix)
 *
 * GET /api/wallabag/api/entries/exists.json?url={url}
 *
 * Mirrors the /api/wallabag/api/entries/exists endpoint.
 * The Wallabag Android app uses the .json suffix when testing
 * API accessibility during connection setup.
 */

export { GET } from "../exists/route";
