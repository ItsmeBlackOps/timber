// Small presentational helpers shared by the docs pages (F12). All colors come
// from theme tokens so docs reskin with the app. Recipe links are built from the
// real Filters->URL contract (lib/filters) so they can't drift from Explore.
import { ExternalLink } from "lucide-react";
import { filtersToParams } from "@/lib/filters";
import type { Recipe } from "@/content/docs/types";

export function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        margin: "28px 0 10px",
        fontSize: 20,
        fontWeight: 700,
        color: "var(--tb-text)",
      }}
    >
      {children}
    </h2>
  );
}

export function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        margin: "20px 0 8px",
        fontSize: 16,
        fontWeight: 600,
        color: "var(--tb-text)",
      }}
    >
      {children}
    </h3>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "10px 0",
        lineHeight: 1.65,
        color: "var(--tb-text)",
        fontSize: 14.5,
      }}
    >
      {children}
    </p>
  );
}

export function Lead({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "0 0 8px",
        lineHeight: 1.6,
        color: "var(--tb-mut)",
        fontSize: 15.5,
      }}
    >
      {children}
    </p>
  );
}

/** Inline monospace token (param names, field names, values). */
export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: "0.9em",
        padding: "1px 5px",
        borderRadius: 4,
        background: "var(--tb-2)",
        border: "1px solid var(--tb-border)",
        color: "var(--tb-text)",
      }}
    >
      {children}
    </code>
  );
}

export function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul
      style={{
        margin: "10px 0",
        paddingInlineStart: 22,
        lineHeight: 1.65,
        color: "var(--tb-text)",
        fontSize: 14.5,
      }}
    >
      {children}
    </ul>
  );
}

export function LI({ children }: { children: React.ReactNode }) {
  return <li style={{ margin: "4px 0" }}>{children}</li>;
}

/** Render a small table from a header row + body rows. */
export function Table({
  head,
  rows,
}: {
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div style={{ overflowX: "auto", margin: "12px 0" }}>
      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          fontSize: 13.5,
        }}
      >
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "start",
                  padding: "8px 10px",
                  borderBottom: "2px solid var(--tb-border)",
                  color: "var(--tb-mut)",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--tb-border)",
                    color: "var(--tb-text)",
                    verticalAlign: "top",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Build a recipe's Console href from its typed Filters via the real search
 * contract (lib/filters). E.g. an `ids.userEmail` filter yields
 * `/?ids.userEmail=…` and a `data.<path>__gte` filter yields a bare
 * `…?data.latencyMs__gte=300` — exactly what Explore's URL parser reads back.
 *
 * Deliberately a raw href (not a TanStack <Link search={…}>): the router's
 * default search serializer JSON-encodes values (quoting `"300"`), which would
 * diverge from the server/Console filter contract these links must mirror.
 */
export function recipeHref(recipe: Recipe): string {
  const query = filtersToParams(recipe.filters).toString();
  // recipe.route is "/" or "/stats"; keep the leading slash so the link is
  // absolute (e.g. "/?ids.userEmail=…", "/stats?event=…").
  return query ? `${recipe.route}?${query}` : recipe.route;
}

/** "Open in Console" deep link for a recipe (see recipeHref). */
export function RecipeLink({ recipe }: { recipe: Recipe }) {
  const href = recipeHref(recipe);
  return (
    <a
      href={href}
      data-testid={`recipe-link-${recipe.id}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        marginTop: 4,
        fontSize: 13.5,
        fontWeight: 600,
        color: "var(--tb-acc)",
        textDecoration: "none",
      }}
    >
      <ExternalLink size={14} aria-hidden="true" />
      Open in Console
    </a>
  );
}
