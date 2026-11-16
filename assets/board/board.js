// The board page's only script: it keeps the conversation scrolled to the newest message and reloads the page when
// /api/version says something changed, unless the operator is writing (then it shows a "new" pill instead).
(() => {
  const POLL_MS = 10_000;
  let version = document.querySelector('meta[name="board-version"]')?.getAttribute("content") ?? "";
  const news = document.getElementById("news");
  const box = document.querySelector(".composer textarea");
  const writing = () => box !== null && (box.value.trim() !== "" || document.activeElement === box);

  // Only a record opens at its newest message; the list stays at its top, and a #anchor (an ask card) is left to the browser.
  if (document.body.classList.contains("has-c") && !location.hash) window.scrollTo(0, document.body.scrollHeight);

  // A request the board could not send comes back as ?c=<its conversation>&sent=failed: its text is put back in that
  // conversation's composer to send again. Any other answer to a write drops the kept text.
  const DRAFT = "dori-board-draft";
  try {
    const params = new URL(location.href).searchParams;
    const c = box?.form?.elements.namedItem("c")?.value ?? "";
    const kept = JSON.parse(sessionStorage.getItem(DRAFT) ?? "null");
    if (box && params.get("sent") === "failed" && params.get("c") === c && kept?.c === c && box.value === "")
      box.value = kept.text ?? "";
    else if (params.has("sent")) sessionStorage.removeItem(DRAFT);
    box?.form?.addEventListener("submit", () => sessionStorage.setItem(DRAFT, JSON.stringify({ c, text: box.value })));
  } catch {
    // no sessionStorage (a private window): the failure notice still shows, only the text is not put back
  }

  box?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) box.form?.requestSubmit();
  });

  async function poll() {
    if (document.hidden) return;
    let next = version;
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (res.ok) next = (await res.json()).v ?? version;
    } catch {
      return; // offline for a moment: the next tick tries again
    }
    if (next === version) return;
    if (writing()) {
      if (news) news.hidden = false;
      version = next;
      return;
    }
    const url = new URL(location.href);
    url.searchParams.delete("sent");
    location.replace(url.pathname + url.search);
  }
  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", poll);
})();
