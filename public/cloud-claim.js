const form = document.querySelector("#claim-form");
const email = document.querySelector("#claim-email");
const errorMessage = document.querySelector("#claim-error");
const fragment = new URLSearchParams(location.hash.slice(1));
const claimToken = fragment.get("token");
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  errorMessage.hidden = true;

  if (!claimToken) {
    errorMessage.textContent = "This claim link is incomplete.";
    errorMessage.hidden = false;
    button.disabled = false;
    return;
  }

  try {
    const response = await fetch("/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ claimToken, email: email.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Workspace claim failed");
    form.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "Check your email for a one-time verification link.";
    form.append(message);
  } catch (error) {
    errorMessage.textContent = error.message || "Workspace claim failed";
    errorMessage.hidden = false;
    button.disabled = false;
  }
});
