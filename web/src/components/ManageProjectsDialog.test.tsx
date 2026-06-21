// Tests for the Manage Projects dialog (Projects feature). MSW's default
// handlers serve /v1/projects (Acme[api,worker], Web Co[scheduler]) and
// /v1/events (api, worker, scheduler), so the list + service checkboxes render
// from realistic data; individual cases override a single endpoint with
// server.use(...). Renders are wrapped in a throwaway QueryClient (retry off, no
// gc) so a mutation error surfaces immediately and cases stay isolated.
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { server } from "../../test/msw-server";
import type { Settings } from "@/lib/settings";
import { ManageProjectsDialog } from "@/components/ManageProjectsDialog";

// The data hooks gate reads on a read key (useHasReadKey, via useSettings →
// useSyncExternalStore). Mock the settings module so the hooks are enabled
// without depending on F3's localStorage impl — only the C-F5 shape matters.
const settingsMock = vi.hoisted(() => ({ loadSettings: vi.fn() }));
vi.mock("@/lib/settings", () => ({
  loadSettings: settingsMock.loadSettings,
  getSnapshot: () => settingsMock.loadSettings(),
  subscribe: () => () => {},
}));

const BASE_SETTINGS: Settings = {
  apiBaseUrl: "",
  readKey: "tb_read", // non-empty so useProjects / useEvents are enabled
  theme: "system",
  tailIntervalMs: 2000,
  userKeys: ["userEmail", "userId"],
  slowMs: 300,
};

function renderDialog() {
  settingsMock.loadSettings.mockReturnValue({ ...BASE_SETTINGS });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }
  return render(<ManageProjectsDialog open onClose={() => {}} />, {
    wrapper: Wrapper,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  settingsMock.loadSettings.mockReturnValue({ ...BASE_SETTINGS });
});

test("lists existing projects", async () => {
  renderDialog();
  expect(await screen.findByText("Acme")).toBeInTheDocument();
  expect(screen.getByText("Web Co")).toBeInTheDocument();
});

test("create submits name + checked services", async () => {
  let body: unknown;
  server.use(
    http.post("/v1/projects", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(
        { slug: "new", name: "New", apps: ["api"] },
        { status: 201 },
      );
    }),
  );
  renderDialog();
  await screen.findByText("Acme");
  await userEvent.type(screen.getByLabelText(/name/i), "New");
  await userEvent.click(screen.getByLabelText("api"));
  await userEvent.click(screen.getByRole("button", { name: /create project/i }));
  await waitFor(() => expect(body).toEqual({ name: "New", apps: ["api"] }));
});

test("delete calls DELETE with the slug (after confirm)", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let deletedUrl = "";
  server.use(
    http.delete("/v1/projects", ({ request }) => {
      deletedUrl = request.url;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  renderDialog();
  await screen.findByText("Acme");
  await userEvent.click(screen.getAllByRole("button", { name: /delete/i })[0]);
  await waitFor(() => expect(deletedUrl).toContain("slug="));
});

test("a 409 shows an inline error", async () => {
  server.use(
    http.post("/v1/projects", () =>
      HttpResponse.json({ error: "dup" }, { status: 409 }),
    ),
  );
  renderDialog();
  await screen.findByText("Acme");
  await userEvent.type(screen.getByLabelText(/name/i), "Acme");
  await userEvent.click(screen.getByRole("button", { name: /create project/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
});
