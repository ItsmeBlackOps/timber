// JsonTree (Task F7) — the product's "view anything" core.
//
// Renders ARBITRARY JSON (objects / arrays / scalars / null) as a collapsible
// tree. Design goals baked in here:
//   - Lazy children: a collapsed container does NOT render (or stringify) its
//     subtree — children mount only when the node is open. This keeps a huge
//     payload cheap until the operator drills in.
//   - Depth budget: nodes deeper than `defaultOpenDepth` (2) start collapsed.
//   - Pivot-on-value: every leaf offers "filter by this", emitting a
//     PivotFragment the Explore route maps onto Filters (ids/data).
//   - Copy-subtree: any node copies its own JSON to the clipboard.
//   - Long-string clamp with expand.
//   - Truncated payloads: a server-side `{_truncated, _bytes/_head}` shape (see
//     validate.js) renders its head plus a loud "truncated (N bytes)" badge.
//
// Colors come from theme tokens (tokens.css) via CSS variables — never hardcode.
import { useState } from "react";

/**
 * A filter fragment produced by clicking a leaf (or an ids chip). The Explore
 * route maps this onto the URL Filters:
 *   - kind:'ids'  -> path is the bare id key (no `ids.` prefix), value stringified
 *   - kind:'data' -> path is the full dotted path INCLUDING the `data.` prefix
 *                    (e.g. `data.response.status`); the route strips `data.` for
 *                    DataFilter.path.
 */
export interface PivotFragment {
  kind: "data" | "ids";
  path: string;
  value: unknown;
}

export interface JsonTreeProps {
  value: unknown;
  /** Dotted path of this node from the document root, e.g. `data` or `ids`. */
  path: string;
  /** When present, leaves render a "filter by this" pivot action. */
  onPivot?: (fragment: PivotFragment) => void;
  /** Depth (0-based) at which this subtree starts; used for the collapse budget. */
  depth?: number;
  /** Nodes at depth > this render collapsed initially. Default 2. */
  defaultOpenDepth?: number;
  /** Highlight substring (lowercased match) — used by DetailPanel's search. */
  highlight?: string;
}

const MUT = "var(--tb-mut)";
const ACC = "var(--tb-acc)";
const TEXT = "var(--tb-text)";

const STRING_CLAMP = 120;

type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

function kindOf(v: unknown): JsonKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  const k = kindOf(v);
  return k === "object" || k === "array";
}

/** Does this object look like a server-truncated payload? */
function isTruncated(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>)._truncated === true
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/** Join a parent path and a child key/index into a dotted path. */
function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

/**
 * Map a node's full dotted document path to a PivotFragment. The first segment
 * is the namespace (`ids` or `data`); everything else is the location within it.
 */
function toFragment(fullPath: string, value: unknown): PivotFragment | null {
  if (fullPath === "ids" || fullPath.startsWith("ids.")) {
    const key = fullPath.slice("ids.".length);
    if (!key) return null; // pivoting on the whole ids object isn't a filter
    return { kind: "ids", path: key, value };
  }
  if (fullPath === "data" || fullPath.startsWith("data.")) {
    if (fullPath === "data") return null;
    return { kind: "data", path: fullPath, value };
  }
  // Top-level scalars (level/app/event) aren't pivotable via this component.
  return null;
}

function copyJson(value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  void navigator.clipboard?.writeText(text);
}

/** A tiny inline icon-button used for copy / pivot affordances. */
function MiniButton(props: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      style={{
        marginInlineStart: 6,
        padding: "0 4px",
        fontSize: 11,
        lineHeight: "16px",
        background: "transparent",
        border: "1px solid var(--tb-border)",
        borderRadius: 4,
        color: MUT,
        cursor: "pointer",
      }}
    >
      {props.children}
    </button>
  );
}

/** Render a scalar value with type-appropriate color and quoting. */
function ScalarValue({
  value,
  highlight,
}: {
  value: unknown;
  highlight?: string;
}) {
  const kind = kindOf(value);

  if (kind === "string") {
    return <ClampedString text={value as string} highlight={highlight} />;
  }

  const display =
    kind === "null" ? "null" : kind === "boolean" ? String(value) : String(value);
  const color =
    kind === "null"
      ? MUT
      : kind === "number"
        ? "var(--tb-info)"
        : kind === "boolean"
          ? "var(--tb-warn)"
          : TEXT;
  return (
    <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
      <Highlighted text={display} highlight={highlight} />
    </span>
  );
}

/** A long string clamps to STRING_CLAMP chars with a "show more" toggle. */
function ClampedString({
  text,
  highlight,
}: {
  text: string;
  highlight?: string;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > STRING_CLAMP;
  const shown = !long || open ? text : text.slice(0, STRING_CLAMP) + "…";

  return (
    <span style={{ color: "var(--tb-ok)", wordBreak: "break-word" }}>
      {'"'}
      <Highlighted text={shown} highlight={highlight} />
      {'"'}
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            marginInlineStart: 6,
            fontSize: 11,
            background: "transparent",
            border: "none",
            color: ACC,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {open ? "show less" : "show more"}
        </button>
      ) : null}
    </span>
  );
}

/** Wraps matches of `highlight` (case-insensitive) in a <mark>. */
function Highlighted({ text, highlight }: { text: string; highlight?: string }) {
  if (!highlight) return <>{text}</>;
  const needle = highlight.toLowerCase();
  const hay = text.toLowerCase();
  const idx = hay.indexOf(needle);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark
        style={{
          background: "var(--tb-warn)",
          color: "var(--tb-bg)",
          borderRadius: 2,
          padding: "0 1px",
        }}
      >
        {text.slice(idx, idx + highlight.length)}
      </mark>
      <Highlighted text={text.slice(idx + highlight.length)} highlight={highlight} />
    </>
  );
}

/** Truncated-payload renderer: head + loud byte-count badge. */
function TruncatedNode({ value }: { value: Record<string, unknown> }) {
  const bytes =
    typeof value._bytes === "number"
      ? value._bytes
      : typeof value._truncatedBytes === "number"
        ? (value._truncatedBytes as number)
        : undefined;
  const head =
    typeof value._head === "string"
      ? value._head
      : typeof value.head === "string"
        ? (value.head as string)
        : "";

  return (
    <div data-json-node data-truncated style={{ fontSize: 13 }}>
      <span
        data-testid="truncated-badge"
        style={{
          display: "inline-block",
          marginBottom: 6,
          padding: "1px 8px",
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 600,
          color: "var(--tb-bg)",
          background: "var(--tb-warn)",
        }}
      >
        truncated{bytes !== undefined ? ` (${fmtBytes(bytes)})` : ""}
      </span>
      <pre
        style={{
          margin: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: TEXT,
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
        }}
      >
        {head}
      </pre>
    </div>
  );
}

interface NodeProps {
  /** The key (object key or array index) labeling this node; undefined at root. */
  label?: string;
  value: unknown;
  path: string;
  depth: number;
  defaultOpenDepth: number;
  onPivot?: (fragment: PivotFragment) => void;
  highlight?: string;
}

function Node({
  label,
  value,
  path,
  depth,
  defaultOpenDepth,
  onPivot,
  highlight,
}: NodeProps) {
  const container = isContainer(value);
  const [open, setOpen] = useState(depth <= defaultOpenDepth);

  const fragment = onPivot ? toFragment(path, value) : null;

  // Leaf (scalar): "key: value" + optional pivot/copy actions.
  if (!container) {
    return (
      <div
        data-json-node
        data-path={path}
        style={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          padding: "1px 0",
        }}
      >
        {label !== undefined ? (
          <span style={{ color: ACC, marginInlineEnd: 6 }}>
            <Highlighted text={label} highlight={highlight} />
            <span style={{ color: MUT }}>:</span>
          </span>
        ) : null}
        <ScalarValue value={value} highlight={highlight} />
        {fragment ? (
          <MiniButton
            label={`Filter by this (${path})`}
            onClick={() => onPivot?.(fragment)}
          >
            ⊕ filter
          </MiniButton>
        ) : null}
      </div>
    );
  }

  // Server-truncated payload — render head + badge, no drill-in.
  if (isTruncated(value)) {
    return (
      <div data-json-node data-path={path} style={{ padding: "1px 0" }}>
        {label !== undefined ? (
          <span style={{ color: ACC, marginInlineEnd: 6 }}>{label}:</span>
        ) : null}
        <TruncatedNode value={value} />
      </div>
    );
  }

  // Container (object/array): collapsible header + lazily-rendered children.
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const count = entries.length;
  const open_brace = Array.isArray(value) ? "[" : "{";
  const close_brace = Array.isArray(value) ? "]" : "}";

  return (
    <div data-json-node data-path={path} style={{ padding: "1px 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap" }}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={label !== undefined ? `${label} (toggle)` : "toggle"}
          onClick={() => setOpen((o) => !o)}
          style={{
            background: "transparent",
            border: "none",
            color: TEXT,
            cursor: "pointer",
            padding: 0,
            font: "inherit",
            display: "inline-flex",
            alignItems: "baseline",
            gap: 4,
          }}
        >
          <span style={{ color: MUT, width: 10, display: "inline-block" }}>
            {open ? "▾" : "▸"}
          </span>
          {label !== undefined ? (
            <span style={{ color: ACC }}>
              <Highlighted text={label} highlight={highlight} />
              <span style={{ color: MUT }}>:</span>
            </span>
          ) : null}
          <span style={{ color: MUT }}>
            {open_brace}
            {!open ? (
              <span style={{ fontStyle: "italic" }}>
                {" "}
                {count} {count === 1 ? "item" : "items"}{" "}
              </span>
            ) : null}
            {!open ? close_brace : null}
          </span>
        </button>
        <MiniButton label={`Copy ${path}`} onClick={() => copyJson(value)}>
          ⧉ copy
        </MiniButton>
      </div>

      {open ? (
        <>
          <div
            style={{
              marginInlineStart: 14,
              borderInlineStart: "1px solid var(--tb-border)",
              paddingInlineStart: 8,
            }}
          >
            {entries.map(([k, v]) => (
              <Node
                key={k}
                label={k}
                value={v}
                path={childPath(path, k)}
                depth={depth + 1}
                defaultOpenDepth={defaultOpenDepth}
                onPivot={onPivot}
                highlight={highlight}
              />
            ))}
          </div>
          <span style={{ color: MUT, marginInlineStart: 14 }}>{close_brace}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Public entry. Renders `value` rooted at `path`. The root container itself is
 * always open (depth 0); descendants follow the depth budget.
 */
export function JsonTree({
  value,
  path,
  onPivot,
  depth = 0,
  defaultOpenDepth = 2,
  highlight,
}: JsonTreeProps) {
  return (
    <div
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        lineHeight: 1.5,
        color: TEXT,
      }}
    >
      <Node
        value={value}
        path={path}
        depth={depth}
        defaultOpenDepth={defaultOpenDepth}
        onPivot={onPivot}
        highlight={highlight}
      />
    </div>
  );
}
