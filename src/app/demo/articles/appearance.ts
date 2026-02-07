import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "appearance",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/304",
  title: "Appearance & Themes",
  author: null,
  summary: "Customize fonts, text size, alignment, and switch between light and dark themes.",
  publishedAt: new Date("2025-12-28T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader provides comprehensive customization options to create your ideal reading environment. <strong>Dark mode</strong> fully integrates with system preferences or manual toggle using next-themes.</p>
<p><strong>Typography controls</strong> include:</p>
<ul>
<li>Multiple font families (System, Merriweather, Literata, Inter, Source Sans)</li>
<li>Text size options from small to extra-large with responsive scaling</li>
<li>Choice between left-aligned or justified text alignment</li>
</ul>
<p>All settings save locally and apply instantly.</p>
<p>As a <strong>Progressive Web App</strong>, Lion Reader can be installed on desktop or mobile devices for a native app-like experience, with portrait orientation lock on mobile for optimal reading comfort.</p>`,
  contentHtml: `
    <h2>Appearance &amp; Themes</h2>

    <p>Reading comfort is personal. What works for one person might strain another&rsquo;s eyes. That&rsquo;s why Lion Reader gives you comprehensive control over how your content appears, letting you create the perfect reading environment for your preferences and lighting conditions.</p>

    <h3>Dark Mode</h3>

    <p>Full dark mode support comes powered by <a href="https://github.com/pacocoursey/next-themes" target="_blank" rel="noopener noreferrer">next-themes</a>. You can follow your system&rsquo;s light/dark preference or manually toggle between modes. Every component, from the sidebar to article content, adapts seamlessly to your chosen theme.</p>

    <h3>Typography Controls</h3>

    <p>Fine-tune your reading experience with multiple font families to choose from:</p>

    <ul>
      <li><strong>System</strong> &mdash; Uses your operating system&rsquo;s default font</li>
      <li><strong>Serif options</strong> &mdash; Merriweather and Literata for traditional book-like reading</li>
      <li><strong>Sans-serif options</strong> &mdash; Inter and Source Sans for modern, clean typography</li>
    </ul>

    <p>Text size options range from small to extra-large, with responsive scaling across all screen sizes. Choose left-aligned or justified text alignment based on your preference. All settings save locally and apply instantly as you adjust them.</p>

    <h3>Progressive Web App</h3>

    <p>Lion Reader is a Progressive Web App, which means you can install it on your desktop or mobile device for a native app-like experience. On mobile, the app locks to portrait orientation for optimal reading comfort. The demo page you&rsquo;re viewing right now showcases the reading experience with all these customization options available.</p>
  `,
};

export default article;
