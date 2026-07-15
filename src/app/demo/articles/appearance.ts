import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "appearance",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/304",
  title: "Appearance & Themes",
  author: null,
  summary:
    "Customize fonts, text size, alignment, and switch between light, a sleep-friendly low-blue-light dark theme, and an e-paper theme for e-ink screens.",
  publishedAt: new Date("2025-12-28T12:00:00Z"),
  starred: false,
  heroImage: "/demo/appearance.png",
  heroImageAlt:
    "The Lion Reader lion holding a card split into a light half with a sun and a dark half with a moon, with a paintbrush and color swatches.",
  summaryHtml: `<p>Lion Reader offers extensive reading customization: <strong>dark mode</strong> with sleep-friendly warm amber tones to reduce blue light, an <strong>e-paper theme</strong> optimized for e-ink displays, typography controls including font family and size options, and Progressive Web App support for native-like installation on any device.</p>`,
  contentHtml: `
    <p>Reading comfort is personal. What works for one person might strain another&rsquo;s eyes. That&rsquo;s why Lion Reader gives you comprehensive control over how your content appears, letting you create the perfect reading environment for your preferences and lighting conditions.</p>

    <h3>Dark Mode</h3>

    <p>Full dark mode support comes powered by <a href="https://github.com/pacocoursey/next-themes" target="_blank" rel="noopener noreferrer">next-themes</a>. You can follow your system&rsquo;s light/dark preference or manually toggle between modes. Every component, from the sidebar to article content, adapts seamlessly to your chosen theme.</p>

    <h3>Sleep-friendly dark mode</h3>

    <p>Lion Reader&rsquo;s dark theme is designed for late-night reading. Rather than the usual blue-accented dark mode, it deliberately minimizes blue light: the accent is a warm <strong>amber</strong> (amber-500, <code>#f59e0b</code>) &mdash; the same warm hue that brands the light theme &mdash; and informational highlights use neutral <strong>zinc</strong> grays (zinc-400, <code>#a1a1aa</code>) instead of blue. Only semantic status colors keep their conventional hues, so an error is still unmistakably red.</p>

    <p>The motivation is simple: blue light in the evening is the wavelength most associated with suppressing melatonin, the hormone that helps you wind down for sleep. By steering the dark theme toward warm and neutral tones, Lion Reader aims to be gentler on your eyes and your circadian rhythm when you&rsquo;re reading in bed with the lights off. This is a design choice to reduce blue light, not a medical claim &mdash; but if you read at night, it&rsquo;s one less thing keeping you awake.</p>

    <h3>E-paper theme</h3>

    <p>Reading on a Kindle, Kobo, or Onyx Boox? The <strong>E-paper</strong> theme is built for e-ink screens: a pure white background, near-black text, and colors chosen so everything stays readable even when the display forces the page to grayscale. Borders and highlights are darker than in the regular light theme because e-ink panels can&rsquo;t render faint grays. When your theme is set to <strong>Auto</strong>, Lion Reader even tries to detect e-reader devices and switches to the e-paper theme automatically.</p>

    <h3>Typography Controls</h3>

    <p>Fine-tune your reading experience with multiple font families to choose from:</p>

    <ul>
      <li><strong>System</strong> &mdash; Uses your operating system&rsquo;s default font</li>
      <li><strong>Serif options</strong> &mdash; Merriweather and Literata for traditional book-like reading</li>
      <li><strong>Sans-serif options</strong> &mdash; Inter and Source Sans for modern, clean typography</li>
    </ul>

    <p>Text size options range from small to extra-large, with responsive scaling across all screen sizes. Choose left-aligned or justified text alignment based on your preference. All settings save locally and apply instantly as you adjust them.</p>

    <h3>Progressive Web App</h3>

    <p>Lion Reader is a <a href="/demo/all?entry=pwa">Progressive Web App</a>, which means you can install it on your desktop or mobile device for a native app-like experience. On mobile, the app locks to portrait orientation for optimal reading comfort. The demo page you&rsquo;re viewing right now showcases the reading experience with all these customization options available.</p>
  `,
};

export default article;
