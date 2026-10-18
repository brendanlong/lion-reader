/**
 * The single public client_id every Wallabag credential is minted under (the
 * setup UI and the scraped developer page both hand out wallabag/wallabag).
 * The token endpoint accepts no other, and the Wallabag API accepts only this
 * client's tokens — see SECURITY.md §8.
 */
export const WALLABAG_CLIENT_ID = "wallabag";
