import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const source = (name: string) =>
  readFileSync(resolve(__dirname, `../../public/${name}`), "utf8");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function dom(html: string, url: string): { dom: JSDOM; jsdomErrors: Error[] } {
  const virtualConsole = new VirtualConsole();
  const jsdomErrors: Error[] = [];
  virtualConsole.on("jsdomError", (error) => jsdomErrors.push(error));
  return {
    dom: new JSDOM(html, {
      url,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
    }),
    jsdomErrors,
  };
}

describe("cloud authentication browser flows", () => {
  it("captures and clears the claim fragment and posts the capability", async () => {
    const { dom: page } = dom(
      `<form id="claim-form"><input id="claim-email" value="owner@example.com"><button></button><p id="claim-error" hidden></p></form>`,
      "https://frank.test/claim#token=frank_claim_secret",
    );
    page.window.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ checkEmail: true }),
    });
    page.window.eval(source("cloud-claim.js"));
    page.window.document.querySelector("form")!.dispatchEvent(
      new page.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();

    expect(page.window.location.hash).toBe("");
    expect(page.window.fetch).toHaveBeenCalledWith(
      "/v1/claims",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ claimToken: "frank_claim_secret", email: "owner@example.com" }),
      }),
    );
    expect(page.window.document.querySelector("form")!.textContent).toContain("Check your email");
  });

  it("executes verification exchange, clears history, and attempts the dashboard redirect", async () => {
    const { dom: page, jsdomErrors } = dom(
      `<p id="verify-message"></p>`,
      "https://frank.test/verify#token=frank_verify_secret",
    );
    page.window.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ workspaceId: "wsp_verified" }),
    });
    page.window.eval(source("cloud-verify.js"));
    await settle();

    expect(page.window.location.hash).toBe("");
    expect(page.window.fetch).toHaveBeenCalledWith(
      "/v1/claim-sessions",
      expect.objectContaining({
        body: JSON.stringify({ verificationToken: "frank_verify_secret" }),
      }),
    );
    expect(jsdomErrors.some((error) => error.message.includes("navigation"))).toBe(true);
  });

  it("redeems login fragments and exposes a safe error on failed email requests", async () => {
    const { dom: page, jsdomErrors } = dom(
      `<form id="login-form"><input id="login-email" value="owner@example.com"><button></button></form><p id="login-message" hidden></p>`,
      "https://frank.test/login#token=frank_login_secret",
    );
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workspaceId: "wsp_login" }),
    });
    page.window.fetch = fetchMock;
    page.window.eval(source("cloud-login.js"));
    await settle();

    expect(page.window.location.hash).toBe("");
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/login-sessions",
      expect.objectContaining({ body: JSON.stringify({ loginToken: "frank_login_secret" }) }),
    );
    expect(jsdomErrors.some((error) => error.message.includes("navigation"))).toBe(true);

    fetchMock.mockResolvedValueOnce({ ok: false });
    page.window.document.querySelector("form")!.removeAttribute("hidden");
    page.window.document.querySelector("form")!.dispatchEvent(
      new page.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(page.window.document.querySelector("#login-message")!.textContent).toContain(
      "could not request",
    );
  });

  it("posts logout and attempts to return to login", async () => {
    const { dom: page, jsdomErrors } = dom(
      `<body data-workspace-id="wsp_logout"><button id="logout-button"></button><div id="drawerBackdrop"></div><aside id="projectDrawer"><div id="drawerContent"></div></aside></body>`,
      "https://frank.test/w/wsp_logout",
    );
    page.window.fetch = vi.fn().mockResolvedValue({ ok: true });
    page.window.eval(source("cloud-workspace.js"));
    page.window.document.querySelector("#logout-button")!.dispatchEvent(
      new page.window.MouseEvent("click", { bubbles: true }),
    );
    await settle();

    expect(page.window.fetch).toHaveBeenCalledWith(
      "/v1/logout",
      expect.objectContaining({ method: "POST" }),
    );
    expect(jsdomErrors.some((error) => error.message.includes("navigation"))).toBe(true);
  });
});
