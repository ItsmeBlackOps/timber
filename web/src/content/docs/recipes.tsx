import type { DocPage } from "@/content/docs/types";
import { CodeBlock } from "@/components/CodeBlock";
import { H3, Lead, P, RecipeLink } from "@/content/docs/_ui";
import { RECIPES } from "@/content/docs/recipes-data";

function Body() {
  return (
    <div>
      <Lead>
        Common questions, each with a copy-pasteable curl and a one-click link
        that opens the same query here in the Console. The link is built from the
        exact URL filters the Console reads — so what you see matches the curl.
      </Lead>

      {RECIPES.map((r) => (
        <section key={r.id} data-testid={`recipe-${r.id}`} style={{ marginTop: 8 }}>
          <H3>{r.title}</H3>
          <P>{r.description}</P>
          <CodeBlock lang="bash" code={r.curl} />
          <RecipeLink recipe={r} />
        </section>
      ))}
    </div>
  );
}

export const recipes: DocPage = {
  slug: "recipes",
  title: "Recipes",
  blurb:
    "All logs for a user, errors for a service, AI cost by model, slow queries — curl + Console links.",
  Body,
};
