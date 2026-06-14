import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "@/components/SettingsDialog";
import { loadSettings, DEFAULTS } from "@/lib/settings";

// jsdom lacks matchMedia; theme.applyTheme (called when theme changes) resolves
// "system" through it.
function installMatchMedia(prefersDark = false) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches: prefersDark,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  installMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsDialog", () => {
  it("renders nothing when closed", () => {
    render(<SettingsDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders a dialog with all setting controls when open", () => {
    render(<SettingsDialog open onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText(/read key/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/base url/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/theme/i)).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText(/tail interval/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/user.*keys/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/slow/i)).toBeInTheDocument();
  });

  it("seeds inputs from current settings", () => {
    localStorage.setItem(
      "timber.settings",
      JSON.stringify({ readKey: "r-abc", slowMs: 750 }),
    );
    render(<SettingsDialog open onClose={() => {}} />);
    expect(screen.getByLabelText(/read key/i)).toHaveValue("r-abc");
    expect(screen.getByLabelText(/slow/i)).toHaveValue(750);
  });

  it("renders the read key as a password field", () => {
    render(<SettingsDialog open onClose={() => {}} />);
    expect(screen.getByLabelText(/read key/i)).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("persists edited values to settings on save", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} />);

    await user.type(screen.getByLabelText(/read key/i), "r-secret");
    await user.clear(screen.getByLabelText(/base url/i));
    await user.type(
      screen.getByLabelText(/base url/i),
      "https://timber.example.com",
    );
    await user.selectOptions(screen.getByLabelText(/theme/i), "dark");
    await user.clear(screen.getByLabelText(/tail interval/i));
    await user.type(screen.getByLabelText(/tail interval/i), "5000");
    await user.clear(screen.getByLabelText(/user.*keys/i));
    await user.type(screen.getByLabelText(/user.*keys/i), "userId, accountId");
    await user.clear(screen.getByLabelText(/slow/i));
    await user.type(screen.getByLabelText(/slow/i), "900");

    await user.click(screen.getByRole("button", { name: /save/i }));

    const s = loadSettings();
    expect(s.readKey).toBe("r-secret");
    expect(s.apiBaseUrl).toBe("https://timber.example.com");
    expect(s.theme).toBe("dark");
    expect(s.tailIntervalMs).toBe(5000);
    expect(s.userKeys).toEqual(["userId", "accountId"]);
    expect(s.slowMs).toBe(900);
    expect(onClose).toHaveBeenCalled();
  });

  it("applies the chosen theme to the document on save", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onClose={() => {}} />);
    await user.selectOptions(screen.getByLabelText(/theme/i), "dark");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("does not persist changes when cancelled", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} />);

    await user.type(screen.getByLabelText(/read key/i), "should-not-save");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(loadSettings().readKey).toBe(DEFAULTS.readKey);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes via the close (X) control without saving", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
    expect(loadSettings().readKey).toBe(DEFAULTS.readKey);
  });
});
