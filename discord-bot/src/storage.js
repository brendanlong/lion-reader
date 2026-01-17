import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = join(__dirname, "..", "data", "tokens.json");

// In-memory cache of tokens
let tokens = new Map();

/**
 * Load tokens from disk
 */
export function loadTokens() {
  try {
    if (existsSync(TOKENS_FILE)) {
      const data = JSON.parse(readFileSync(TOKENS_FILE, "utf-8"));
      tokens = new Map(Object.entries(data));
    }
  } catch (error) {
    console.error("Failed to load tokens:", error);
    tokens = new Map();
  }
  return tokens;
}

/**
 * Save tokens to disk
 */
function persistTokens() {
  try {
    const data = Object.fromEntries(tokens);
    const dir = dirname(TOKENS_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Failed to save tokens:", error);
  }
}

/**
 * Get a user's API token
 */
export function getToken(discordUserId) {
  return tokens.get(discordUserId) || null;
}

/**
 * Save a user's API token
 */
export function saveToken(discordUserId, apiToken) {
  tokens.set(discordUserId, apiToken);
  persistTokens();
}

/**
 * Remove a user's API token
 */
export function removeToken(discordUserId) {
  tokens.delete(discordUserId);
  persistTokens();
}

// Load tokens on module init
loadTokens();
