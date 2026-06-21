// ReqResView (Task F7) — auto-detects request/response-shaped payloads and shows
// them side by side, each pane a JsonTree. This is what makes "view anything"
// feel purpose-built for API/LLM logs without hardcoding any one schema.
//
// Detection is purely structural: we look for the FIRST matching key pair in a
// priority list. If none match we fall back to a single JsonTree of the whole
// payload. String values that are themselves JSON get parsed + pretty-printed;
// plain multiline strings render in a <pre>.
import { JsonTree } from "@/components/JsonTree";
import type { PivotFragment } from "@/components/JsonTree";

export interface ReqResViewProps {
  /** The document's `data` payload (any shape). */
  data: unknown;
  /** Threaded to each pane's leaves for pivot-on-value. */
  onPivot?: (fragment: PivotFragment) => void;
  /** Substring to highlight (DetailPanel's in-document search). */
  highlight?: string;
}

/** Request/response key pairs to detect, in priority order. */
const PAIRS: { req: string; res: string }[] = [
  { req: "request", res: "response" },
  { req: "req", res: "res" },
  { req: "prompt", res: "completion" },
  { req: "input", res: "output" },
  { req: "messages", res: "output" },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string that parses as a JSON object/array — worth tree-rendering. */
function tryParseJson(s: string): unknown | undefined {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * Render one pane's value:
 *   - JSON string -> parse and tree-render
 *   - multiline / long plain string -> <pre>
 *   - everything else -> JsonTree
 */
function PaneBody({
  value,
  path,
  onPivot,
  highlight,
}: {
  value: unknown;
  path: string;
  onPivot?: (f: PivotFragment) => void;
  highlight?: string;
}) {
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== undefined) {
      return (
        <JsonTree value={parsed} path={path} onPivot={onPivot} highlight={highlight} />
      );
    }
    if (value.includes("\n")) {
      return (
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            color: "var(--tb-text)",
          }}
        >
          {value}
        </pre>
      );
    }
  }
  return <JsonTree value={value} path={path} onPivot={onPivot} highlight={highlight} />;
}

function Pane({
  title,
  value,
  path,
  onPivot,
  highlight,
}: {
  title: string;
  value: unknown;
  path: string;
  onPivot?: (f: PivotFragment) => void;
  highlight?: string;
}) {
  return (
    <section
      aria-label={title}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        border: "1px solid var(--tb-border)",
        borderRadius: 8,
        background: "var(--tb-surface)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "6px 10px",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "var(--tb-mut)",
          background: "var(--tb-2)",
          borderBottom: "1px solid var(--tb-border)",
        }}
      >
        {title}
      </header>
      <div style={{ padding: 10, overflow: "auto", maxHeight: 480 }}>
        <PaneBody value={value} path={path} onPivot={onPivot} highlight={highlight} />
      </div>
    </section>
  );
}

/** Find the first request/response pair present on the payload. */
function detectPair(
  data: Record<string, unknown>,
): { req: string; res: string } | null {
  for (const pair of PAIRS) {
    if (pair.req in data && pair.res in data) return pair;
  }
  return null;
}

export function ReqResView({ data, onPivot, highlight }: ReqResViewProps) {
  const pair = isPlainObject(data) ? detectPair(data) : null;

  if (pair && isPlainObject(data)) {
    return (
      <div
        data-reqres
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <Pane
          title="Request"
          value={data[pair.req]}
          path={`data.${pair.req}`}
          onPivot={onPivot}
          highlight={highlight}
        />
        <Pane
          title="Response"
          value={data[pair.res]}
          path={`data.${pair.res}`}
          onPivot={onPivot}
          highlight={highlight}
        />
      </div>
    );
  }

  // No detectable pair — show the whole payload as one tree.
  return (
    <div data-reqres="fallback">
      <JsonTree value={data} path="data" onPivot={onPivot} highlight={highlight} />
    </div>
  );
}
