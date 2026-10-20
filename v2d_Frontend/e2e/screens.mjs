#!/usr/bin/env node
/**
 * Browser smoke test + screenshots across every workspace.
 *
 *   BASE_URL=http://localhost:5000 OUT=./e2e/out node e2e/screens.mjs
 *
 * Signs in through the real login form as each demo role (seed with
 * `npm run db:seed:demo` in v2d_Backend), visits each page at desktop and
 * phone widths, saves screenshots, and fails if any page logs a console error
 * or a request fails unexpectedly. Uses the locally installed Chrome/Edge.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:5000";
const OUT = path.resolve(process.env.OUT ?? "e2e/out");
const PASSWORD = process.env.DEMO_PASSWORD ?? "vote2dine-demo";
const CHANNEL = process.env.BROWSER_CHANNEL ?? "chrome";
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const problems = [];

async function session(browser, viewport, { username, role }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, colorScheme: process.env.SCHEME ?? "light" });
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    // Failed-resource messages duplicate the network check below, which knows which 401s are expected.
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) problems.push(`[console] ${username} ${page.url()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`[pageerror] ${username} ${page.url()}: ${err.message}`));
  page.on("response", (res) => {
    const url = res.url();
    // A 401 from /auth/session before sign-in is expected.
    if (res.status() >= 400 && !(res.status() === 401 && url.includes("/auth/session"))) problems.push(`[http ${res.status()}] ${username} ${url}`);
  });
  if (username) {
    await page.goto(`${BASE}/login`);
    await page.getByLabel("Username, roll number or email").fill(username);
    await page.locator("#password").fill(PASSWORD);
    if (role) await page.locator(`input[name="workspace"][value="${role}"]`).check({ force: true });
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  }
  return { ctx, page };
}

async function shot(page, name, pathname) {
  if (pathname) await page.goto(`${BASE}${pathname}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(250);
  // Horizontal overflow check: the page must never scroll sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) problems.push(`[overflow ${overflow}px] ${name} ${page.url()}`);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ✓ ${name}`);
}

async function api(page, p) {
  return page.evaluate(async (url) => (await fetch(url)).json().then((j) => j.data), `/api/v1${p}`);
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
try {
  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    console.log(`\n${vpName} (${viewport.width}×${viewport.height})`);

    const anon = await session(browser, viewport, {});
    await shot(anon.page, `${vpName}-login`, "/login");
    await shot(anon.page, `${vpName}-activate`, "/activate");
    await anon.page.goto(`${BASE}/login`);
    await anon.page.getByLabel("Username, roll number or email").fill("demo.student");
    await anon.page.locator("#password").fill("definitely-wrong");
    await anon.page.getByRole("button", { name: "Sign in" }).click();
    await anon.page.getByText("The username or password is incorrect.").waitFor();
    await shot(anon.page, `${vpName}-login-error`);
    // That failed sign-in is expected — remove it from the problem list.
    for (let i = problems.length - 1; i >= 0; i--) if (problems[i].includes("/auth/login") && problems[i].includes("401")) problems.splice(i, 1);
    await anon.ctx.close();

    const student = await session(browser, viewport, { username: "demo.student" });
    for (const [n, p] of [
      ["home", "/student"],
      ["meals", "/student/meals"],
      ["history", "/student/history"],
      ["warnings", "/student/warnings"],
      ["inbox", "/student/notifications"],
    ])
      await shot(student.page, `${vpName}-student-${n}`, p);
    // Role escalation through the URL must not render another workspace.
    await student.page.goto(`${BASE}/admin`);
    await student.page.waitForURL((u) => u.pathname.startsWith("/student"));
    await student.ctx.close();

    const sup = await session(browser, viewport, { username: "demo.supervisor", role: "SUPERVISOR" });
    const overview = await api(sup.page, "/messes/1/overview");
    const pick = overview?.attention?.awaitingApproval?.[0]?.id ?? overview?.today?.[0]?.id ?? overview?.upcoming?.[0]?.id;
    const reconciled = await api(sup.page, `/messes/1/slots?from=2020-01-01&to=2100-01-01&status=RECONCILED`);
    const lastReconciled = reconciled?.at(-1)?.id;
    for (const [n, p] of [
      ["today", "/supervisor"],
      ["meals", "/supervisor/meals"],
      ...(pick ? [["meal-detail", `/supervisor/meals/${pick}`]] : []),
      ...(lastReconciled ? [["reconciled", `/supervisor/meals/${lastReconciled}/reconcile`]] : []),
      ["counter", "/supervisor/counter"],
      ["appeals", "/supervisor/appeals"],
      ["analyze", "/supervisor/analyze"],
      ["inventory", "/supervisor/inventory"],
      ["catalog", "/supervisor/catalog"],
      ["incidents", "/supervisor/incidents"],
    ])
      await shot(sup.page, `${vpName}-supervisor-${n}`, p);
    await sup.ctx.close();

    const kitchen = await session(browser, viewport, { username: "demo.kitchen" });
    await shot(kitchen.page, `${vpName}-kitchen-board`, "/kitchen");
    const board = await api(kitchen.page, "/kitchen/board?messId=1");
    const kMeal = board?.meals?.[0]?.id ?? lastReconciled;
    if (kMeal) await shot(kitchen.page, `${vpName}-kitchen-meal`, `/kitchen/meals/${kMeal}`);
    await shot(kitchen.page, `${vpName}-kitchen-incidents`, "/kitchen/incidents");
    await kitchen.ctx.close();

    const admin = await session(browser, viewport, { username: "demo.admin" });
    for (const [n, p] of [
      ["overview", "/admin"],
      ["accounts", "/admin/accounts"],
      ["structure", "/admin/structure"],
      ["settings", "/admin/settings"],
      ["analyze", "/admin/analyze"],
      ["analyze-mess", "/admin/analyze/mess/1"],
      ["audit", "/admin/audit"],
      ["import", "/admin/accounts/import"],
    ])
      await shot(admin.page, `${vpName}-admin-${n}`, p);
    await admin.ctx.close();
  }
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${[...new Set(problems)].map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nNo console errors, failed requests or horizontal overflow. Screenshots in ${OUT}`);
