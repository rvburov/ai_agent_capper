import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import { describe, expect, it } from "vitest";

import { meQueryKey } from "../../api/keys";
import { ToastProvider } from "../../components";
import { adminUser } from "../../features/admin/testData";
import { useBetSummary } from "../../features/bets/api";
import { baseApi } from "../../test/factories";
import { json, ME_ADMIN, mockFetch } from "../../test/fetchMock";
import { createTestQueryClient } from "../../test/renderPage";
import { ThemeProvider } from "../theme/ThemeProvider";
import { AppShell } from "./AppShell";

function Probe() {
  const s = useBetSummary({});
  return (
    <p data-testid="probe">
      profit=
      {String((s.data as { profit?: string } | undefined)?.profit ?? "...")} ph=
      {String(s.isPlaceholderData)}
    </p>
  );
}

// Смена владельца данных не показывает данные прежнего под новым именем (ревью Р27)
describe("смена владельца в режиме просмотра", () => {
  it("данные прежнего владельца не видны, пока грузятся новые", async () => {
    const routes: RouteObject[] = [
      {
        path: "/",
        element: <AppShell />,
        children: [
          {
            path: "bets",
            element: <Probe />,
            handle: { title: "bets", nav: "bets" },
          },
        ],
      },
    ];
    mockFetch({
      ...baseApi(ME_ADMIN),
      "GET /api/bets/summary": async (request) => {
        const as = new URL(request.url).searchParams.get("as_user");
        if (as) await new Promise((r) => setTimeout(r, 400));
        return json({ profit: as ? "MEMBER-" + as : "ADMIN-OWN" });
      },
      "GET /api/admin/users": () =>
        json([
          adminUser({
            id: 1,
            display_name: "Роман Буров",
            email: "o@example.com",
            role: "admin",
          }),
          adminUser({ id: 7 }),
          adminUser({
            id: 8,
            display_name: "Дмитрий Шульц",
            email: "d@example.com",
          }),
        ]),
      "GET /api/bets/counts": () => json({ open: 0, awaiting_result: 0 }),
      "GET /api/me/bank": () =>
        json({ balance: "1", equity: "1", currency: "RUB" }),
    });
    const client = createTestQueryClient();
    client.setQueryData(meQueryKey, ME_ADMIN);
    const router = createMemoryRouter(routes, { initialEntries: ["/bets"] });
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/profit=ADMIN-OWN/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /^Чьи данные смотреть/ }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Ольга Лехтинен",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Режим просмотра данных участника",
        }),
      ).not.toBeNull(),
    );
    const during = screen.getByTestId("probe").textContent;
    expect(await screen.findByText(/profit=MEMBER-7/)).toBeInTheDocument();
    // A -> B
    await router.navigate("/bets?as=8");
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", {
            name: "Режим просмотра данных участника",
          }),
        ).getByText("Дмитрий Шульц", { selector: "b" }),
      ).toBeInTheDocument(),
    );
    const during2 = screen.getByTestId("probe").textContent;
    await screen.findByText(/profit=MEMBER-8/);
    expect(during).not.toMatch(/ADMIN-OWN/);
    expect(during2).not.toMatch(/MEMBER-7/);
  });
});
