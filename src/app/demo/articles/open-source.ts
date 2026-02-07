import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "open-source",
  subscriptionId: "lion-reader",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader",
  title: "Open Source & Self-Hostable",
  author: null,
  summary:
    "Lion Reader is fully open source. Self-host it, explore the code, or contribute on GitHub.",
  publishedAt: new Date("2025-12-26T10:00:00Z"),
  starred: false,
  contentHtml: `
    <h2>Open Source &amp; Self-Hostable</h2>

    <p>Lion Reader is fully open source and designed to be self-hosted. Every line of code is available on <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">GitHub</a> for you to inspect, modify, and deploy on your own infrastructure. When you self-host Lion Reader, you own your data completely &mdash; no third-party services, no vendor lock-in, just you and your feeds.</p>

    <h3>Modern Tech Stack</h3>

    <p>Lion Reader is built with cutting-edge technologies chosen for performance, developer experience, and long-term maintainability:</p>

    <ul>
      <li><strong>Frontend</strong> &mdash; <a href="https://nextjs.org/" target="_blank" rel="noopener noreferrer">Next.js</a> 16 with React 19, <a href="https://tailwindcss.com/" target="_blank" rel="noopener noreferrer">Tailwind CSS</a> 4 for styling</li>
      <li><strong>API</strong> &mdash; <a href="https://trpc.io/" target="_blank" rel="noopener noreferrer">tRPC</a> for end-to-end type-safe APIs with <a href="https://zod.dev/" target="_blank" rel="noopener noreferrer">Zod</a> 4 validation</li>
      <li><strong>Database</strong> &mdash; PostgreSQL with <a href="https://orm.drizzle.team/" target="_blank" rel="noopener noreferrer">Drizzle ORM</a> for type-safe queries, UUIDv7 primary keys</li>
      <li><strong>Caching &amp; Real-time</strong> &mdash; Redis for session caching, rate limiting, and SSE pub/sub</li>
      <li><strong>Auth</strong> &mdash; Custom session management with <a href="https://arcticjs.dev/" target="_blank" rel="noopener noreferrer">Arctic</a> for OAuth (Google, Apple, Discord), Argon2 password hashing</li>
      <li><strong>AI</strong> &mdash; <a href="https://www.anthropic.com/" target="_blank" rel="noopener noreferrer">Anthropic</a> SDK for summaries, <a href="https://groq.com/" target="_blank" rel="noopener noreferrer">Groq</a> for narration preprocessing, <a href="https://onnxruntime.ai/" target="_blank" rel="noopener noreferrer">ONNX Runtime</a> for on-device ML</li>
      <li><strong>Feed parsing</strong> &mdash; fast-xml-parser for SAX-style streaming, htmlparser2 for HTML, Mozilla Readability for content extraction</li>
      <li><strong>Deployment</strong> &mdash; <a href="https://fly.io/" target="_blank" rel="noopener noreferrer">Fly.io</a> with auto-scaling, Docker Compose for local development</li>
      <li><strong>Testing</strong> &mdash; <a href="https://vitest.dev/" target="_blank" rel="noopener noreferrer">Vitest</a> with real database integration tests (no mocks)</li>
      <li><strong>Observability</strong> &mdash; <a href="https://sentry.io/" target="_blank" rel="noopener noreferrer">Sentry</a> for error tracking, structured JSON logging, Prometheus metrics</li>
    </ul>

    <h3>Architecture Highlights</h3>

    <ul>
      <li><strong>Stateless app servers</strong> &mdash; All state lives in Postgres and Redis, enabling horizontal scaling</li>
      <li><strong>Services layer</strong> &mdash; Shared business logic between tRPC routers, MCP server, and background jobs</li>
      <li><strong>Cursor-based pagination</strong> &mdash; Efficient pagination everywhere using UUIDv7 cursors</li>
      <li><strong>Background job queue</strong> &mdash; Built on Postgres for reliable feed fetching with exponential backoff</li>
      <li><strong>Efficient data sharing</strong> &mdash; Feed and entry data deduplicated across users with strict privacy boundaries</li>
    </ul>

    <h3>Contributing</h3>

    <p>Contributions are welcome! Check out the <a href="https://github.com/brendanlong/lion-reader/issues" target="_blank" rel="noopener noreferrer">open issues</a> to find ways to help, or explore the architecture documentation in the repository to understand how everything fits together. The codebase includes comprehensive design docs, architecture diagrams, and testing guidelines to help you get started.</p>
  `,
};

export default article;
