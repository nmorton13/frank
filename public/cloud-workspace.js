const workspaceId = document.body.dataset.workspaceId;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[m]);
}

function entryIcon(entry) {
  if (entry.type === "done") return "✓";
  if (entry.type === "todo") return entry.status === "closed" ? "✓" : "☐";
  if (entry.type === "blocker") return entry.status === "closed" ? "✓" : "!";
  if (entry.type === "decision") return "◆";
  if (entry.type === "session") return "↳";
  return "•";
}

function loopBullet(entry) {
  return `<li>${esc(entry.title ? `${entry.title}: ` : "")}${esc(entry.text)}</li>`;
}

// Group open loops by project, then by type, with collapsible sections —
// matching the local dashboard. Each loop keeps its completion checkbox.
function groupOpenLoops(entries) {
  if (!entries.length) return "";
  const byProject = new Map();
  for (const entry of entries) {
    const name = entry.project || "Unassigned";
    if (!byProject.has(name)) byProject.set(name, []);
    byProject.get(name).push(entry);
  }
  return Array.from(byProject.entries())
    .map(([project, rows]) => {
      const byType = new Map();
      for (const entry of rows) {
        if (!byType.has(entry.type)) byType.set(entry.type, []);
        byType.get(entry.type).push(entry);
      }
      const sections = Array.from(byType.entries())
        .map(
          ([type, typeRows]) => `
            <details class="loop-type" open>
              <summary><span class="check">›</span>${esc(type)} (${typeRows.length})</summary>
              <ul class="loop-bullets">
                ${typeRows
                  .map(
                    (entry) => `
                  <li class="loop-item" data-entry-id="${entry.id}">
                    <label class="loop-check">
                      <input type="checkbox" aria-label="Mark ${esc(entry.type)} complete">
                      <span class="loop-box" aria-hidden="true"></span>
                    </label>
                    <div class="loop-copy">
                      <strong>${esc(entry.title || entry.text)}</strong>
                      ${entry.title ? `<p>${esc(entry.text)}</p>` : ""}
                    </div>
                  </li>`,
                  )
                  .join("")}
              </ul>
            </details>`,
        )
        .join("");
      return `
        <li class="loop-project">
          <div class="item-title"><span class="check">□</span>${esc(project)}</div>
          ${sections}
        </li>`;
    })
    .join("");
}

function historyItem(entry) {
  const closed = entry.status === "closed" ? " closed" : "";
  const when = entry.createdAt ? `<span class="badge">${esc(entry.createdAt)}</span>` : "";
  const label =
    entry.status === "closed" && ["todo", "blocker"].includes(entry.type)
      ? `closed ${entry.type}`
      : entry.type;
  return `<article class="timeline-item${closed}" data-type="${esc(entry.type)}">
    <div class="timeline-title"><span class="check">${esc(entryIcon(entry))}</span><span>${esc(
      label,
    )}</span>${when}</div>
    <div class="timeline-text">${esc(entry.title ? `${entry.title}: ` : "")}${esc(entry.text)}</div>
  </article>`;
}

function renderDrawer(data) {
  const open = data.openLoops.length
    ? `<ul>${data.openLoops.map(loopBullet).join("")}</ul>`
    : '<p class="empty">No open loops for this project.</p>';
  const filters = ["all", "note", "todo", "blocker", "done", "decision", "session", "status", "active"];
  const chips = filters
    .map(
      (f) =>
        `<button class="filter-chip${f === activeFilter ? " active" : ""}" data-filter="${f}" aria-pressed="${
          f === activeFilter ? "true" : "false"
        }">${f === "all" ? "All" : f}</button>`,
    )
    .join("");
  const timeline = data.entries.length
    ? `<div class="timeline">${data.entries.map(historyItem).join("")}</div>`
    : '<p class="empty">No history found.</p>';
  document.getElementById("drawerContent").innerHTML = `
    <div class="drawer-head">
      <div>
        <div class="kicker">project history</div>
        <h2>${esc(data.project)}</h2>
        <p class="sub">Open loops and recent history.</p>
      </div>
      <button class="close-drawer" type="button" aria-label="Close">×</button>
    </div>
    <section class="drawer-section"><h3>Open loops</h3>${open}</section>
    <section class="drawer-section"><h3>Recent history</h3><div class="filter-row">${chips}</div>${timeline}</section>
    <p class="sr-only" data-filter-live aria-live="polite" role="status"></p>`;
}

let lastProjectButton = null;
let activeFilter = "all";

function focusableIn(drawer) {
  return Array.from(
    drawer.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hidden && el.getAttribute("aria-hidden") !== "true");
}

// Focus a stable drawer element (the close button) if focus is currently
// outside the drawer. Called after async content re-renders replace the
// previously focused element, so keyboard/screen-reader focus never leaks out.
function ensureFocusInsideDrawer() {
  const drawer = document.getElementById("projectDrawer");
  if (!drawer || drawer.getAttribute("aria-hidden") !== "false") return;
  if (drawer.contains(document.activeElement)) return;
  const close = drawer.querySelector(".close-drawer");
  const first = focusableIn(drawer)[0];
  const target = close || first;
  if (target) target.focus();
}

function openDrawer() {
  const backdrop = document.getElementById("drawerBackdrop");
  const drawer = document.getElementById("projectDrawer");
  drawer.removeAttribute("inert");
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    // Move focus into the dialog and onto its first control so keyboard and
    // screen-reader users start inside the drawer, not behind it.
    const first = focusableIn(drawer)[0];
    if (first) first.focus();
  });
}

function closeDrawer({ restoreFocus = true } = {}) {
  const backdrop = document.getElementById("drawerBackdrop");
  const drawer = document.getElementById("projectDrawer");
  backdrop.classList.remove("open");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawer.setAttribute("inert", "");
  setTimeout(() => {
    backdrop.hidden = true;
  }, 220);
  // Restore focus to the control that opened the drawer.
  if (restoreFocus && lastProjectButton && typeof lastProjectButton.focus === "function") {
    lastProjectButton.focus();
  }
  lastProjectButton = null;
}

function trapFocus(event) {
  if (event.key !== "Tab") return;
  const drawer = document.getElementById("projectDrawer");
  // Redirect focus into the drawer if it somehow landed outside (e.g. after an
  // async content replacement removed the previously focused element).
  if (document.activeElement && !drawer.contains(document.activeElement)) {
    event.preventDefault();
    const first = focusableIn(drawer)[0];
    if (first) first.focus();
    return;
  }
  const items = focusableIn(drawer);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function applyFilter(value) {
  activeFilter = value;
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    const isActive = chip.dataset.filter === value;
    chip.classList.toggle("active", isActive);
    chip.setAttribute("aria-pressed", String(isActive));
  });
  document.querySelectorAll(".timeline-item").forEach((item) => {
    item.hidden = value !== "all" && item.dataset.type !== value;
  });
  // Announce the selected filter to screen readers.
  const live = document.querySelector("[data-filter-live]");
  if (live) live.textContent = `Showing ${value === "all" ? "all entries" : value + " entries"}`;
}

async function showProjectHistory(project) {
  renderDrawer({ project, openLoops: [], entries: [] });
  openDrawer();
  const response = await fetch(
    `/w/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(project)}/entries`,
    { cache: "no-store" },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load project history");
  // The re-render below replaces the previously focused element, so restore
  // focus to a stable drawer element once the real content is in place.
  renderDrawer(data);
  ensureFocusInsideDrawer();
}

// Open-loop completion (review-only). Uses event delegation so re-renders from
// auto-refresh never orphan the checkbox handlers.
document.querySelector("[data-open-loop-list]")?.addEventListener("change", async (event) => {
  const checkbox = event.target;
  if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== "checkbox") return;
  const item = checkbox.closest("[data-entry-id]");
  if (!workspaceId || !item) return;

  checkbox.disabled = true;
  try {
    const response = await fetch(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/entries/${encodeURIComponent(
        item.dataset.entryId,
      )}/close`,
      { method: "PATCH", headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw new Error("Completion failed");
    item.remove();
    const list = document.querySelector("[data-open-loop-list]");
    const remaining = document.querySelectorAll("[data-entry-id]").length;
    const count = document.querySelector("[data-open-count]");
    if (count) count.textContent = `${remaining} open`;
    if (list && remaining === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "No open loops. The page is clear.";
      list.append(empty);
    }
  } catch {
    checkbox.checked = false;
    checkbox.disabled = false;
  }
});

document.querySelector("#logout-button")?.addEventListener("click", async () => {
  const response = await fetch("/v1/logout", {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (response.ok) location.replace("/login");
});

// Project drawer + filters.
document.addEventListener("click", (event) => {
  const projectButton = event.target.closest("[data-project]");
  if (projectButton) {
    lastProjectButton = projectButton;
    showProjectHistory(projectButton.dataset.project).catch((err) => alert(err.message));
  }
  if (event.target.closest(".close-drawer") || event.target.id === "drawerBackdrop") {
    closeDrawer();
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    applyFilter(filter.dataset.filter);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDrawer();
    return;
  }
  const drawer = document.getElementById("projectDrawer");
  if (drawer && drawer.getAttribute("aria-hidden") === "false") {
    trapFocus(event);
  }
});

// Auto-refresh the dashboard every 30 seconds (quiet live view). Re-renders
// the status projection in place; the drawer, if open, is left untouched.
async function refreshDashboard() {
  if (!workspaceId) return;
  try {
    const response = await fetch(`/w/${encodeURIComponent(workspaceId)}/status`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json();
    const updated = document.getElementById("updated");
    if (updated) updated.textContent = `Updated ${new Date().toLocaleString()}`;
    const current = document.getElementById("currentStatuses");
    if (current) {
      current.innerHTML = data.active
        ? `<div class="current-status-item"><div class="status-lines"><p class="active">${esc(
            data.active.title ? `${data.active.title}: ${data.active.text}` : data.active.text,
          )}</p></div><div class="meta">${
            data.active.project ? `<span>Project: ${esc(data.active.project)}</span>` : ""
          }<span class="badge">status</span></div></div>`
        : '<p class="empty">No status set yet.</p>';
    }
    const loops = document.querySelector("[data-open-loop-list]");
    if (loops) {
      loops.innerHTML = data.openLoops.length
        ? groupOpenLoops(data.openLoops)
        : '<li class="empty-state">No open loops. The page is clear.</li>';
      const count = document.querySelector("[data-open-count]");
      if (count) count.textContent = `${data.openLoops.length} open`;
    }
    const projects = document.getElementById("activeProjects");
    if (projects) {
      projects.innerHTML = data.activeProjects.length
        ? data.activeProjects
            .map(
              (project) => `
            <li>
              <div class="item-title"><span class="check">✓</span>
                <button class="project-button" data-project="${esc(project.name)}">${esc(
                  project.name,
                )}</button>
              </div>
              <div class="item-text">${esc(
                `${project.count} recent update${project.count === 1 ? "" : "s"} · latest: ${project.lastType}`,
              )}</div>
            </li>`,
            )
            .join("")
        : '<li class="empty">No active projects captured.</li>';
    }
    const recent = document.getElementById("recent");
    if (recent) {
      recent.innerHTML = data.recent.length
        ? data.recent
            .map(
              (entry) => `
            <li>
              <div class="item-title"><span class="check">›</span>${esc(
                [entry.project ? `Project: ${entry.project}` : "", entry.type]
                  .filter(Boolean)
                  .join(" · "),
              )}</div>
              <div class="item-text">${esc(
                entry.title ? `${entry.title}: ${entry.text}` : entry.text,
              )}</div>
            </li>`,
            )
            .join("")
        : '<li class="empty">No recent Frank activity.</li>';
    }
  } catch {
    // Transient network/refresh errors are ignored; the next tick retries.
  }
}

setInterval(refreshDashboard, 30000);
