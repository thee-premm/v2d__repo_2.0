import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MealToken } from "../pages/student/MealToken";
import Login from "../pages/auth/Login";
import { SessionProvider } from "../lib/session";
import { ToastProvider } from "../components/ui";
import { fmtKg, fmtNum, fmtPct, fmtCountdown } from "../lib/format";
import type { StudentMeal } from "../lib/types";

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SessionProvider>{ui}</SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const NOW = Date.parse("2026-10-21T04:00:00Z");
const meal = (over: Partial<StudentMeal> = {}): StudentMeal => ({
  id: 7,
  messName: "Kaveri Mess",
  mealType: { code: "LUNCH", name: "Lunch" },
  serviceDate: "2026-10-21",
  votingOpensAt: "2026-10-20T00:00:00Z",
  votingClosesAt: "2026-10-21T05:00:00Z",
  serviceStartsAt: "2026-10-21T07:00:00Z",
  serviceEndsAt: "2026-10-21T09:00:00Z",
  status: "OPEN",
  notes: null,
  specialEvent: false,
  cancelReason: null,
  votingState: "OPEN",
  myVote: null,
  myVoteUpdatedAt: null,
  intentAtCutoff: null,
  attendedAt: null,
  menu: [{ name: "Dal tadka", category: "MAIN", isVegetarian: true }],
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((url: string) => (String(url).endsWith("/auth/session") ? json(401, { success: false, error: { code: "UNAUTHENTICATED", message: "Sign in" } }) : json(404, {})));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("formatting never turns missing data into zero", () => {
  it("renders null as a dash", () => {
    expect(fmtNum(null)).toBe("—");
    expect(fmtKg(null)).toBe("—");
    expect(fmtPct(undefined)).toBe("—");
    expect(fmtKg(0)).toBe("0 kg");
  });
  it("formats countdowns", () => {
    expect(fmtCountdown(0)).toBe("closed");
    expect(fmtCountdown(90 * 60_000)).toBe("1 h 30 min");
    expect(fmtCountdown(45_000)).toBe("45 s");
  });
});

describe("MealToken", () => {
  it("lets a student vote while open and shows the server-confirmed choice", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/vote") && init?.method === "PUT") return json(200, { success: true, data: { intent: "YES", changed: true } });
      return json(401, { success: false, error: { code: "UNAUTHENTICATED", message: "x" } });
    });
    wrap(<MealToken meal={meal()} now={NOW} />);
    const yes = screen.getByRole("button", { name: /yes/i });
    expect(yes).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(yes);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/me/meals/7/vote", expect.objectContaining({ method: "PUT", body: JSON.stringify({ intent: "YES" }) })));
    expect(await screen.findByText(/Saved: you will eat lunch/i)).toBeInTheDocument();
  });

  it("stops offering a vote once the server clock passes the cutoff, even before a refresh", () => {
    wrap(<MealToken meal={meal()} now={Date.parse("2026-10-21T05:00:01Z")} />);
    expect(screen.queryByRole("button", { name: /yes|no/i })).toBeNull();
    expect(screen.getByText("Your vote at cutoff")).toBeInTheDocument();
  });

  it("reports a server rejection instead of pretending the vote was saved", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json(422, { success: false, error: { code: "VOTING_CLOSED", message: "Voting for this meal has closed" } });
      return json(401, { success: false, error: { code: "UNAUTHENTICATED", message: "x" } });
    });
    wrap(<MealToken meal={meal()} now={NOW} />);
    await userEvent.click(screen.getByRole("button", { name: /no/i }));
    expect(await screen.findByText("Voting for this meal has closed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /no/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the cutoff declaration, not vote buttons, after voting closes", () => {
    wrap(<MealToken meal={meal({ status: "APPROVED", votingState: "CLOSED", intentAtCutoff: "UNVOTED" })} now={NOW} />);
    expect(screen.getByText("Your vote at cutoff")).toBeInTheDocument();
    expect(screen.getByText("No vote")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^yes/i })).toBeNull();
  });
});

describe("Login", () => {
  it("validates required fields before calling the server", async () => {
    wrap(<Login />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your username, roll number or email")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/auth/login"))).toBe(false);
  });

  it("explains which workspaces an account actually has when a role is refused", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/auth/login"))
        return json(403, { success: false, error: { code: "ROLE_NOT_ASSIGNED", message: "This account does not have access to the Institution admin workspace.", details: { assignedRoles: ["STUDENT"] } } });
      return json(401, { success: false, error: { code: "UNAUTHENTICATED", message: "x" } });
    });
    wrap(<Login />);
    await userEvent.type(await screen.findByLabelText("Username, roll number or email"), "demo.student");
    await userEvent.type(screen.getByLabelText("Password"), "some-password");
    await userEvent.click(screen.getByText("Administrator"));
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/does not have access to the Institution admin workspace/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Student" })).toBeInTheDocument();
  });
});
