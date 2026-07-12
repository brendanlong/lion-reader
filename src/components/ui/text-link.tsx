/**
 * TextLink Component
 *
 * Inline text link with the standard accent color styling. Use for links
 * inside prose (descriptions, help text, legal pages) instead of copying
 * the accent classes onto raw anchors.
 */

import type { AnchorHTMLAttributes } from "react";

export interface TextLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Open in a new tab with rel="noopener noreferrer" */
  external?: boolean;
}

export function TextLink({ external = false, className = "", children, ...props }: TextLinkProps) {
  return (
    <a
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={`text-accent hover:text-accent-hover font-medium ${className}`}
      {...props}
    >
      {children}
    </a>
  );
}
