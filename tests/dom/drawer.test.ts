import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const SCRIPT_PATH = resolve(__dirname, "../../public/cloud-workspace.js");
const scriptSource = readFileSync(SCRIPT_PATH, "utf8");

const rAF = (dom) => new Promise((r) => dom.window.requestAnimationFrame(() => r()));

async function settle(dom) {
  await rAF(dom);
  await new Promise((r) => setTimeout(r, 0));
}

function buildDom() {
  const dom = new JSDOM(
    `<!doctype html>
<html><body class="cloud-workspace" data-workspace-id="wsp_test">
  <main>
    <button data-project="Portal">Portal</button>
  </main>
  <div class="drawer-backdrop" id="drawerBackdrop" hidden></div>
  <aside class="project-drawer" id="projectDrawer" role="dialog" aria-modal="true" aria-hidden="true" inert>
    <div id="drawerContent"></div>
  </aside>
</body></html>`,
    { url: "https://frank.test/w/wsp_test", runScripts: "dangerously", pretendToBeVisual: true },
  );
  dom.window.eval(scriptSource);
  return dom;
}

function click(dom, selector) {
  const el = dom.window.document.querySelector(selector);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function keydown(dom, key) {
  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

const HISTORY_DATA = {
  project: "Portal",
  openLoops: [],
  entries: [
    { type: "note", text: "n", status: "open" },
    { type: "todo", text: "t", status: "open" },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project-history drawer (focused DOM behavior)", () => {
  it("opens the drawer and moves focus into it", async () => {
    const dom = buildDom();
    const drawer = dom.window.document.getElementById("projectDrawer");
    dom.window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => HISTORY_DATA });

    click(dom, "[data-project]");
    await settle(dom);

    expect(drawer.getAttribute("aria-hidden")).toBe("false");
    expect(drawer.hasAttribute("inert")).toBe(false);
    expect(drawer.contains(dom.window.document.activeElement)).toBe(true);
  });

  it("restores focus to the close button after async history renders", async () => {
    const dom = buildDom();
    const drawer = dom.window.document.getElementById("projectDrawer");
    dom.window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => HISTORY_DATA });

    click(dom, "[data-project]");
    await settle(dom);

    const close = drawer.querySelector(".close-drawer");
    expect(close).toBeTruthy();
    // After the re-render replaced the initially-focused element, focus must
    // land on a stable drawer element (the close button).
    expect(dom.window.document.activeElement).toBe(close);
  });

  it("redirects focus into the drawer on Tab when focus was lost", async () => {
    const dom = buildDom();
    const drawer = dom.window.document.getElementById("projectDrawer");
    dom.window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => HISTORY_DATA });

    click(dom, "[data-project]");
    await settle(dom);

    // Simulate focus lost to the page (an async render removed the element).
    dom.window.document.querySelector("[data-project]").focus();
    const tab = new dom.window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    tab.preventDefault = vi.fn();
    dom.window.document.dispatchEvent(tab);

    expect(tab.preventDefault).toHaveBeenCalled();
    expect(drawer.contains(dom.window.document.activeElement)).toBe(true);
  });

  it("closes on Escape and restores focus to the opening project button", async () => {
    const dom = buildDom();
    const projectButton = dom.window.document.querySelector("[data-project]");
    projectButton.focus = vi.fn();
    dom.window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => HISTORY_DATA });

    click(dom, "[data-project]");
    await settle(dom);
    const drawer = dom.window.document.getElementById("projectDrawer");
    expect(drawer.getAttribute("aria-hidden")).toBe("false");

    keydown(dom, "Escape");

    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(projectButton.focus).toHaveBeenCalled();
  });

  it("persists filter selection with aria-pressed and hides non-matching items", async () => {
    const dom = buildDom();
    const drawer = dom.window.document.getElementById("projectDrawer");
    dom.window.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => HISTORY_DATA });

    click(dom, "[data-project]");
    await settle(dom);

    const todoChip = drawer.querySelector('[data-filter="todo"]');
    todoChip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    expect(todoChip.getAttribute("aria-pressed")).toBe("true");
    const noteItem = drawer.querySelector('[data-type="note"]');
    const todoItem = drawer.querySelector('[data-type="todo"]');
    expect(noteItem.hidden).toBe(true);
    expect(todoItem.hidden).toBe(false);
    expect(drawer.querySelector('[data-filter="all"]').getAttribute("aria-pressed")).toBe("false");
  });
});
