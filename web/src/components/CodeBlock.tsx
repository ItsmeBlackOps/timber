import { useState } from "react";
import { Check, Copy } from "lucide-react";

export interface CodeBlockProps {
  /** The verbatim code/command to display and copy. */
  code: string;
  /** Optional language hint (curl, bash, json, js, python, …) — surfaced for labelling. */
  lang?: string;
}

/**
 * A monospaced code block with a one-click copy button (contract C-F9).
 *
 * Used throughout the in-app docs (F12) for copy-pasteable curl / Node / Python
 * snippets. Colors come from theme tokens so it reskins with the rest of the app;
 * the copy button flips to a transient "Copied" state for feedback.
 */
export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(code);
    } catch {
      // Clipboard may be unavailable (insecure context / denied permission);
      // the snippet is still selectable by hand, so fail quietly.
    }
    setCopied(true);
    // Revert the confirmation after a short beat.
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      data-lang={lang}
      style={{
        position: "relative",
        border: "1px solid var(--tb-border)",
        borderRadius: 8,
        background: "var(--tb-2)",
        margin: "12px 0",
      }}
    >
      {lang ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 6,
            insetInlineStart: 12,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--tb-mut)",
          }}
        >
          {lang}
        </span>
      ) : null}

      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        style={{
          position: "absolute",
          top: 6,
          insetInlineEnd: 6,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "3px 8px",
          fontSize: 12,
          borderRadius: 6,
          border: "1px solid var(--tb-border)",
          background: "var(--tb-surface)",
          color: copied ? "var(--tb-info)" : "var(--tb-mut)",
          cursor: "pointer",
        }}
      >
        {copied ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>

      <pre
        style={{
          margin: 0,
          padding: lang ? "28px 14px 14px" : "14px 64px 14px 14px",
          overflowX: "auto",
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--tb-text)",
          whiteSpace: "pre",
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
