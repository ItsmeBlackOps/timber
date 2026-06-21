import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSwitcher } from "@/components/AppSwitcher";

describe("AppSwitcher", () => {
  it("lists an 'all apps' option plus every app", () => {
    render(
      <AppSwitcher apps={["api", "worker"]} value={undefined} onChange={() => {}} />,
    );
    const select = screen.getByRole("combobox", { name: /app/i });
    expect(select).toBeInTheDocument();
    // all + 2 apps
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.getByRole("option", { name: /all apps/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "api" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "worker" })).toBeInTheDocument();
  });

  it("selects the current app value", () => {
    render(
      <AppSwitcher apps={["api", "worker"]} value="worker" onChange={() => {}} />,
    );
    expect(screen.getByRole("combobox", { name: /app/i })).toHaveValue("worker");
  });

  it("emits the chosen app on change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AppSwitcher apps={["api", "worker"]} value={undefined} onChange={onChange} />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /app/i }),
      "api",
    );
    expect(onChange).toHaveBeenCalledWith("api");
  });

  it("emits undefined when 'all apps' is chosen", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AppSwitcher apps={["api", "worker"]} value="api" onChange={onChange} />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /app/i }),
      screen.getByRole("option", { name: /all apps/i }),
    );
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
