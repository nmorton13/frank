const form = document.querySelector("#login-form");
const email = document.querySelector("#login-email");
const message = document.querySelector("#login-message");
const fragment = new URLSearchParams(location.hash.slice(1));
const loginToken = fragment.get("token");
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

async function redeemLoginToken() {
  if (!loginToken) return;
  form?.setAttribute("hidden", "");
  try {
    const response = await fetch("/v1/login-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ loginToken }),
    });
    const body = await response.json();
    if (!response.ok || !body.workspaceId) throw new Error("Sign-in link is invalid or expired");
    location.replace(`/w/${encodeURIComponent(body.workspaceId)}`);
  } catch (error) {
    form?.removeAttribute("hidden");
    message.textContent = error.message || "Sign-in failed.";
    message.hidden = false;
  }
}

void redeemLoginToken();

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  message.hidden = true;

  try {
    const response = await fetch("/v1/login-links", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: email.value }),
    });
    if (!response.ok) throw new Error("Sign-in request failed");
    form.replaceChildren();
    const sent = document.createElement("p");
    sent.textContent = "If that address belongs to a Frank workspace, a sign-in link is on its way.";
    form.append(sent);
  } catch {
    message.textContent = "Frank could not request a sign-in link. Try again shortly.";
    message.hidden = false;
    button.disabled = false;
  }
});
