// The board page's only script: it keeps the conversation scrolled to the newest message and reloads the page when
// /api/version says something changed, unless the operator is writing (then it shows a "new" pill instead).
(() => {
  const POLL_MS = 10_000;
  let version = document.querySelector('meta[name="board-version"]')?.getAttribute("content") ?? "";
  const news = document.getElementById("news");
  const box = document.querySelector(".composer textarea");
  const writing = () => box !== null && (box.value.trim() !== "" || document.activeElement === box);

  if (!location.search.includes("sent=decide")) window.scrollTo(0, document.body.scrollHeight);

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
    location.reload();
  }
  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", poll);
})();
