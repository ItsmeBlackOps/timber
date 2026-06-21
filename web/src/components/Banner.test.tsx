import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Banner } from "@/components/Banner";

describe("Banner", () => {
  it("renders a 401 message about the key/authorization with an action", () => {
    render(<Banner kind="401" onAction={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/key|unauthor|sign in|settings/i);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("renders a 503 message about storage being unavailable with an action", () => {
    render(<Banner kind="503" onAction={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /storage|unavailable|retry/i,
    );
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("renders an offline message with a retry action", () => {
    render(<Banner kind="offline" onAction={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/offline|connection|retry/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("invokes onAction when the action button is clicked", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Banner kind="503" onAction={onAction} />);
    await user.click(screen.getByRole("button"));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("omits the action button when onAction is not provided", () => {
    render(<Banner kind="offline" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // message still shows
    expect(screen.getByRole("alert")).toHaveTextContent(/offline|connection/i);
  });
});
