/**
 * Unit tests for forwarded email detection and parsing.
 */

import { describe, it, expect } from "vitest";
import {
  hasForwardPrefix,
  stripForwardPrefix,
  hasForwardedBlock,
  extractOriginalSenderFromBody,
  extractOriginalSubjectFromBody,
  parseForwardedEmail,
  generateForwardedByBlock,
  prependForwardedByBlock,
} from "@/server/email/forwarded-email";

describe("hasForwardPrefix", () => {
  it("detects Fwd: prefix", () => {
    expect(hasForwardPrefix("Fwd: Newsletter Title")).toBe(true);
  });

  it("detects Fw: prefix", () => {
    expect(hasForwardPrefix("Fw: Newsletter Title")).toBe(true);
  });

  it("detects FWD: prefix (uppercase)", () => {
    expect(hasForwardPrefix("FWD: Newsletter Title")).toBe(true);
  });

  it("detects [Fwd] prefix", () => {
    expect(hasForwardPrefix("[Fwd] Newsletter Title")).toBe(true);
  });

  it("detects Forward: prefix", () => {
    expect(hasForwardPrefix("Forward: Newsletter Title")).toBe(true);
  });

  it("detects German Wg: prefix", () => {
    expect(hasForwardPrefix("Wg: Newsletter Title")).toBe(true);
  });

  it("detects French Tr: prefix", () => {
    expect(hasForwardPrefix("Tr: Newsletter Title")).toBe(true);
  });

  it("returns false for normal subject", () => {
    expect(hasForwardPrefix("Newsletter Title")).toBe(false);
  });

  it("returns false for Re: prefix (reply, not forward)", () => {
    expect(hasForwardPrefix("Re: Newsletter Title")).toBe(false);
  });

  it("handles leading whitespace", () => {
    expect(hasForwardPrefix("  Fwd: Newsletter Title")).toBe(true);
  });
});

describe("stripForwardPrefix", () => {
  it("strips Fwd: prefix", () => {
    expect(stripForwardPrefix("Fwd: Newsletter Title")).toBe("Newsletter Title");
  });

  it("strips Fw: prefix", () => {
    expect(stripForwardPrefix("Fw: Newsletter Title")).toBe("Newsletter Title");
  });

  it("strips FWD: prefix (uppercase)", () => {
    expect(stripForwardPrefix("FWD: Newsletter Title")).toBe("Newsletter Title");
  });

  it("strips [Fwd] prefix", () => {
    expect(stripForwardPrefix("[Fwd] Newsletter Title")).toBe("Newsletter Title");
  });

  it("returns original subject if no prefix", () => {
    expect(stripForwardPrefix("Newsletter Title")).toBe("Newsletter Title");
  });

  it("handles multiple Fwd prefixes (strips only first)", () => {
    expect(stripForwardPrefix("Fwd: Fwd: Newsletter Title")).toBe("Fwd: Newsletter Title");
  });

  it("trims whitespace", () => {
    expect(stripForwardPrefix("  Fwd:   Newsletter Title  ")).toBe("Newsletter Title");
  });
});

describe("hasForwardedBlock", () => {
  it("detects Gmail forwarded message block", () => {
    const content = `Some intro text

---------- Forwarded message ---------
From: Original Sender <original@example.com>
Date: Mon, Jan 1, 2024
Subject: Newsletter Title

The actual content here.`;
    expect(hasForwardedBlock(content)).toBe(true);
  });

  it("detects Apple Mail format", () => {
    const content = `
Begin forwarded message:

From: Original Sender <original@example.com>
Subject: Newsletter Title

The actual content here.`;
    expect(hasForwardedBlock(content)).toBe(true);
  });

  it("detects Outlook format with dashes", () => {
    const content = `
-------- Original Message --------
From: original@example.com
Subject: Newsletter Title

Content here.`;
    expect(hasForwardedBlock(content)).toBe(true);
  });

  it("detects Outlook format with underscores", () => {
    const content = `
_____ Original Message _____
From: original@example.com

Content here.`;
    expect(hasForwardedBlock(content)).toBe(true);
  });

  it("returns false for regular email content", () => {
    const content = `Hello,

This is a regular newsletter.

Best regards,
Sender`;
    expect(hasForwardedBlock(content)).toBe(false);
  });
});

describe("extractOriginalSenderFromBody", () => {
  it("extracts sender from Gmail format", () => {
    const content = `---------- Forwarded message ---------
From: Newsletter Name <newsletter@example.com>
Date: Mon, Jan 1, 2024
Subject: Weekly Update

Content here.`;
    const result = extractOriginalSenderFromBody(content);
    expect(result).toEqual({
      address: "newsletter@example.com",
      name: "Newsletter Name",
    });
  });

  it("extracts sender without display name", () => {
    const content = `---------- Forwarded message ---------
From: newsletter@example.com
Subject: Weekly Update

Content here.`;
    const result = extractOriginalSenderFromBody(content);
    expect(result).toEqual({
      address: "newsletter@example.com",
    });
  });

  it("extracts sender from Apple Mail format", () => {
    const content = `Begin forwarded message:

From: Tech News <news@tech.example.com>
Subject: Daily Digest
Date: January 1, 2024

Content here.`;
    const result = extractOriginalSenderFromBody(content);
    expect(result).toEqual({
      address: "news@tech.example.com",
      name: "Tech News",
    });
  });

  it("extracts sender from quoted email (>)", () => {
    const content = `
> ---------- Forwarded message ---------
> From: Original Sender <original@example.com>
> Subject: Newsletter

Content.`;
    const result = extractOriginalSenderFromBody(content);
    expect(result).toEqual({
      address: "original@example.com",
      name: "Original Sender",
    });
  });

  it("handles HTML entities in sender", () => {
    const content = `From: News &amp; Updates &lt;news@example.com&gt;
Subject: Weekly`;
    const result = extractOriginalSenderFromBody(content);
    expect(result).toEqual({
      address: "news@example.com",
      name: "News & Updates",
    });
  });

  it("extracts from HTML bold format", () => {
    const content = `<div>
<b>From:</b> Newsletter &lt;news@example.com&gt;<br>
<b>Subject:</b> Update
</div>`;
    const result = extractOriginalSenderFromBody(content);
    expect(result).toEqual({
      address: "news@example.com",
      name: "Newsletter",
    });
  });

  it("returns undefined if no sender found", () => {
    const content = "Just regular email content without forwarding headers.";
    const result = extractOriginalSenderFromBody(content);
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid email format", () => {
    const content = "From: not-an-email\nSubject: Test";
    const result = extractOriginalSenderFromBody(content);
    expect(result).toBeUndefined();
  });
});

describe("extractOriginalSubjectFromBody", () => {
  it("extracts subject from forwarded content", () => {
    const content = `---------- Forwarded message ---------
From: sender@example.com
Subject: Original Newsletter Subject
Date: Jan 1, 2024

Content.`;
    expect(extractOriginalSubjectFromBody(content)).toBe("Original Newsletter Subject");
  });

  it("extracts subject with HTML entities", () => {
    const content = `Subject: News &amp; Updates for Today
From: sender@example.com`;
    expect(extractOriginalSubjectFromBody(content)).toBe("News & Updates for Today");
  });

  it("returns undefined if no subject found", () => {
    const content = "Just regular content.";
    expect(extractOriginalSubjectFromBody(content)).toBeUndefined();
  });
});

describe("parseForwardedEmail", () => {
  it("detects forwarded email with subject prefix", () => {
    const result = parseForwardedEmail("Fwd: Newsletter", "Regular content");
    expect(result.isForwarded).toBe(true);
    expect(result.cleanedSubject).toBe("Newsletter");
  });

  it("detects forwarded email with body block", () => {
    const content = `---------- Forwarded message ---------
From: news@example.com
Subject: Weekly Update

Content.`;
    const result = parseForwardedEmail("Newsletter", content);
    expect(result.isForwarded).toBe(true);
    expect(result.originalSender?.address).toBe("news@example.com");
  });

  it("extracts all information from Gmail forward", () => {
    const content = `Hey, thought you might like this!

---------- Forwarded message ---------
From: Tech Newsletter <newsletter@tech.example.com>
Date: Mon, Jan 1, 2024 at 10:00 AM
Subject: Weekly Tech Roundup
To: user@example.com

The actual newsletter content goes here.`;

    const result = parseForwardedEmail("Fwd: Weekly Tech Roundup", content);

    expect(result.isForwarded).toBe(true);
    expect(result.cleanedSubject).toBe("Weekly Tech Roundup");
    expect(result.originalSender).toEqual({
      address: "newsletter@tech.example.com",
      name: "Tech Newsletter",
    });
    expect(result.originalSubject).toBe("Weekly Tech Roundup");
  });

  it("returns not forwarded for regular email", () => {
    const result = parseForwardedEmail("Newsletter Subject", "Regular newsletter content.");
    expect(result.isForwarded).toBe(false);
    expect(result.originalSender).toBeUndefined();
    expect(result.cleanedSubject).toBeUndefined();
  });
});

describe("generateForwardedByBlock", () => {
  it("generates HTML block with name", () => {
    const result = generateForwardedByBlock("user@example.com", "John Doe", true);
    expect(result).toContain("Forwarded by:");
    expect(result).toContain("John Doe (user@example.com)");
    expect(result).toContain("<div");
    expect(result).toContain("background-color");
  });

  it("generates HTML block without name", () => {
    const result = generateForwardedByBlock("user@example.com", undefined, true);
    expect(result).toContain("Forwarded by:");
    expect(result).toContain("user@example.com");
    expect(result).not.toContain("(user@example.com)");
  });

  it("generates plain text block with name", () => {
    const result = generateForwardedByBlock("user@example.com", "John Doe", false);
    expect(result).toBe("[Forwarded by: John Doe (user@example.com)]\n\n");
  });

  it("generates plain text block without name", () => {
    const result = generateForwardedByBlock("user@example.com", undefined, false);
    expect(result).toBe("[Forwarded by: user@example.com]\n\n");
  });

  it("escapes HTML special characters", () => {
    const result = generateForwardedByBlock("user@example.com", "John <script> Doe", true);
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });
});

describe("prependForwardedByBlock", () => {
  it("prepends to plain text content", () => {
    const content = "Original content here.";
    const result = prependForwardedByBlock(content, "forwarder@example.com", "John", false);
    expect(result).toBe("[Forwarded by: John (forwarder@example.com)]\n\nOriginal content here.");
  });

  it("inserts after body tag in HTML", () => {
    const content = "<html><body><p>Content</p></body></html>";
    const result = prependForwardedByBlock(content, "forwarder@example.com", undefined, true);
    expect(result).toContain("<body><div");
    expect(result).toContain("Forwarded by:");
    expect(result).toContain("<p>Content</p>");
  });

  it("prepends to HTML without body tag", () => {
    const content = "<div><p>Content</p></div>";
    const result = prependForwardedByBlock(content, "forwarder@example.com", undefined, true);
    expect(result).toContain("Forwarded by:");
    expect(result.startsWith("<div style=")).toBe(true);
  });

  it("handles body tag with attributes", () => {
    const content = '<html><body class="email"><p>Content</p></body></html>';
    const result = prependForwardedByBlock(content, "forwarder@example.com", undefined, true);
    expect(result).toContain('<body class="email"><div');
  });
});
