// Top-level resilience contract for the SPA bootstrap (main.tsx).
//
// Finding (web-react-quality): there was no React error boundary anywhere in the
// tree, so an unexpected render throw in any deep component unmounted the whole
// app. Per-route TanStack `errorComponent`s (and the router's
// `defaultErrorComponent`) catch throws *inside* a matched route while keeping
// the persistent shell — but a throw *above* the router (router internals, the
// QueryClientProvider tree, or RootShell itself before any route renders) needs a
// classic React error boundary as a last-resort net. `AppErrorBoundary` is that
// net: it wraps <RouterProvider> in main.tsx and renders a branded, recoverable
// fallback instead of a blank page.
//
// Bootstrap testability: importing main.tsx must NOT execute its createRoot mount
// in the test environment (jsdom has no real #root and we are unit-testing the
// boundary, not bootstrapping the app). The mount is therefore guarded on the
// presence of #root, so importing the module is side-effect-free here.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppErrorBoundary } from "@/main";

// A child that throws on render, to trip the boundary.
function Boom({ message = "kaboom" }: { message?: string }): React.ReactNode {
  throw new Error(message);
}

describe("main.tsx bootstrap", () => {
  it("exports an AppErrorBoundary and importing the module does not mount/throw", () => {
    // The import above already ran; reaching here means no createRoot side effect
    // blew up (jsdom has no #root, so the guarded mount is skipped).
    expect(typeof AppErrorBoundary).toBe("function");
  });
});

describe("AppErrorBoundary", () => {
  // React logs the caught error to console.error; silence it so the suite output
  // stays clean (the throw is intentional).
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("renders children unchanged when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <div>healthy app</div>
      </AppErrorBoundary>,
    );
    expect(screen.getByText("healthy app")).toBeInTheDocument();
    // No fallback alert when there's no error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("catches a render throw and shows a branded, recoverable fallback (not a blank page)", () => {
    render(
      <AppErrorBoundary>
        <Boom message="render exploded" />
      </AppErrorBoundary>,
    );
    // Branded: the fallback identifies the app as Timber so the user isn't left
    // staring at a blank/anonymous screen.
    expect(screen.getByText(/timber/i)).toBeInTheDocument();
    // Surfaced as a status/alert region with recovery affordance.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/something went wrong|unexpected error|error/i);
    // Recoverable: offers a reload affordance rather than a dead end.
    expect(
      screen.getByRole("button", { name: /reload|try again|reload app/i }),
    ).toBeInTheDocument();
    // The throwing child is gone (it did not render its own output).
    expect(screen.queryByText("render exploded")).not.toBeInTheDocument();
  });

  it("reloads the page when the recovery button is clicked", async () => {
    // jsdom's location.reload is a no-op that warns 'Not implemented'; stub it so
    // we can assert the click wires to a full reload (the only safe recovery for
    // an above-router crash, since component-local state is already corrupt).
    const reload = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...origLocation, reload },
    });
    try {
      const user = userEvent.setup();
      render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
      await user.click(
        screen.getByRole("button", { name: /reload|try again|reload app/i }),
      );
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: origLocation,
      });
    }
  });
});
