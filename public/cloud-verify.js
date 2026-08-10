const message = document.querySelector("#verify-message");
const fragment = new URLSearchParams(location.hash.slice(1));
const verificationToken = fragment.get("token");
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

async function verify() {
  if (!verificationToken) {
    message.textContent = "This verification link is incomplete.";
    return;
  }
  try {
    const response = await fetch("/v1/claim-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ verificationToken }),
    });
    const body = await response.json();
    if (!response.ok || !body.workspaceId) throw new Error(body.error || "Verification failed");
    location.replace(`/w/${encodeURIComponent(body.workspaceId)}`);
  } catch (error) {
    message.textContent = error.message || "Verification failed.";
  }
}

void verify();
