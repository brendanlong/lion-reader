import { type DemoArticle } from "./types";

// Feed Types
import rssAtom from "./rss-atom";
import jsonFeed from "./json-feed";
import emailNewsletters from "./email-newsletters";
import saveForLater from "./save-for-later";
import fileUpload from "./file-upload";

// Reading Experience
import fullContent from "./full-content";
import appearance from "./appearance";
import textToSpeech from "./text-to-speech";
import aiSummaries from "./ai-summaries";
import keyboardShortcuts from "./keyboard-shortcuts";

// Organization & Search
import tags from "./tags";
import search from "./search";
// TODO Publish this once the feature is actually finished: https://github.com/brendanlong/lion-reader/issues/323
// import scoring from "./scoring";
import opml from "./opml";

// Integrations & Sync
import mcpServer from "./mcp-server";
import discordBot from "./discord-bot";
import plugins from "./plugins";
import websub from "./websub";
import pwa from "./pwa";
import realTime from "./real-time";

// About
import welcome from "./welcome";
import openSource from "./open-source";
import authSecurity from "./auth-security";

export const DEMO_ARTICLES: DemoArticle[] = [
  // Feed Types
  rssAtom,
  jsonFeed,
  emailNewsletters,
  saveForLater,
  fileUpload,
  // Reading Experience
  fullContent,
  appearance,
  textToSpeech,
  aiSummaries,
  keyboardShortcuts,
  // Organization & Search
  tags,
  search,
  // scoring,
  opml,
  // Integrations & Sync
  mcpServer,
  discordBot,
  plugins,
  websub,
  pwa,
  realTime,
  // About
  welcome,
  openSource,
  authSecurity,
];

export type { DemoArticle } from "./types";
