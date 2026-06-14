// F12 — in-app API docs (spec §8.4). Left nav of the 8 pages + the selected
// page's body. The slug comes from the route param ($page); an unknown or
// missing slug falls back to Overview. Content lives in src/content/docs/*.
import { Link, useParams } from "@tanstack/react-router";
import { DEFAULT_DOC_SLUG, DOC_PAGES, getDoc } from "@/content/docs";

const navLinkBase: React.CSSProperties = {
  display: "block",
  padding: "7px 10px",
  borderRadius: 6,
  textDecoration: "none",
  color: "var(--tb-mut)",
  fontSize: 14,
  lineHeight: 1.3,
};

const navLinkActive: React.CSSProperties = {
  ...navLinkBase,
  color: "var(--tb-text)",
  background: "var(--tb-2)",
  fontWeight: 600,
};

export function DocsRoute() {
  // strict:false: read the param from an ambiguous location (works wherever the
  // route is mounted, incl. tests).
  const params = useParams({ strict: false }) as { page?: string };
  const page = getDoc(params.page) ?? getDoc(DEFAULT_DOC_SLUG)!;

  return (
    <div
      style={{
        display: "flex",
        gap: 24,
        alignItems: "flex-start",
        maxWidth: 1100,
        margin: "0 auto",
        padding: "20px 16px",
      }}
    >
      <nav
        aria-label="Docs"
        style={{
          flex: "0 0 220px",
          position: "sticky",
          top: 16,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--tb-mut)",
            padding: "0 10px 6px",
          }}
        >
          Documentation
        </span>
        {DOC_PAGES.map((p) => {
          const active = p.slug === page.slug;
          return (
            <Link
              key={p.slug}
              to="/docs/$page"
              params={{ page: p.slug }}
              title={p.blurb}
              style={active ? navLinkActive : navLinkBase}
            >
              {p.title}
            </Link>
          );
        })}
      </nav>

      <article
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          maxWidth: 760,
        }}
      >
        <h1 style={{ margin: "0 0 6px", fontSize: 28, fontWeight: 700 }}>
          {page.title}
        </h1>
        <page.Body />
      </article>
    </div>
  );
}
