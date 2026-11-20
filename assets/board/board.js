// The board page's only script: it keeps the conversation scrolled to the newest message and reloads the page when
// /api/version says something changed, unless the operator is writing (then it shows a "new" pill instead).
(() => {
  const POLL_MS = 10_000;
  const LIVE_MS = 30_000;
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
    // A 채널 composer names its channel in `d` and comes back as ?d=<key>&sent=cfailed.
    const d = box?.form?.elements.namedItem("d")?.value;
    const c = d !== undefined ? `d:${d}` : (box?.form?.elements.namedItem("c")?.value ?? "");
    const failedHere =
      (params.get("sent") === "failed" && params.get("c") === c) ||
      (params.get("sent") === "cfailed" && `d:${params.get("d")}` === c);
    const kept = JSON.parse(sessionStorage.getItem(DRAFT) ?? "null");
    if (box && failedHere && kept?.c === c && box.value === "") box.value = kept.text ?? "";
    else if (params.has("sent")) sessionStorage.removeItem(DRAFT);
    box?.form?.addEventListener("submit", () => sessionStorage.setItem(DRAFT, JSON.stringify({ c, text: box.value })));
  } catch {
    // no sessionStorage (a private window): the failure notice still shows, only the text is not put back
  }

  // A channel's new-message badge counts only what arrived after the channel was last opened on this device.
  const SEEN = "dori-board-seen";
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN) ?? "{}") ?? {};
    const open = document.querySelector("[data-seen]");
    const key = open?.getAttribute("data-seen");
    if (key) {
      seen[key] = Math.max(Number(seen[key]) || 0, Number(open.getAttribute("data-at")) || 0);
      localStorage.setItem(SEEN, JSON.stringify(seen));
    }
    for (const b of document.querySelectorAll(".unr[data-d]")) {
      const after = Number(seen[b.getAttribute("data-d")]) || 0;
      const n = (b.getAttribute("data-ats") || "").split(",").filter((a) => a !== "" && Number(a) > after).length;
      b.textContent = n > 99 ? "99+" : String(n);
      b.hidden = n === 0;
    }
  } catch {
    // no localStorage: the badge keeps the server's count (new since the operator last wrote there)
  }

  // A tablet's detail panel (a checkbox the 미션 button toggles) closes on Escape too.
  const panel = document.getElementById("dt");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel?.checked) panel.checked = false;
  });

  // A wide screen shows a long path or id short (.lt: its full form in title, .lf full, .ls short). Copying a selection
  // that touches one copies the full form: the selection is widened to whole folds and read while body.copying shows
  // the full forms, then put back. A selection without a fold is left to the browser.
  document.addEventListener("copy", (e) => {
    const sel = getSelection();
    if (!e.clipboardData || !sel || sel.rangeCount !== 1 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const foldOf = (n) => (n instanceof Element ? n : n?.parentElement)?.closest(".lt") ?? null;
    const first = foldOf(range.startContainer);
    const last = foldOf(range.endContainer);
    if (!first && !last && !range.cloneContents().querySelector(".lt")) return;
    const kept = range.cloneRange();
    const whole = range.cloneRange();
    if (first) whole.setStartBefore(first);
    if (last) whole.setEndAfter(last);
    sel.removeAllRanges();
    sel.addRange(whole);
    document.body.classList.add("copying");
    const text = sel.toString();
    document.body.classList.remove("copying");
    sel.removeAllRanges();
    sel.addRange(kept);
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });

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

  // The 지금 tab reads the clock (방금 끝남 turns into 대기, a run past its timeout into 상태 확인 안 됨), which
  // /api/version does not see: it reloads on its own, unless the operator is writing.
  if (document.querySelector("[data-live]"))
    setInterval(() => {
      if (document.hidden || writing()) return;
      const url = new URL(location.href);
      url.searchParams.delete("sent");
      location.replace(url.pathname + url.search);
    }, LIVE_MS);
})();
