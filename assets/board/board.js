// The board page's only script: it keeps the conversation scrolled to the newest message and reloads the page when
// /api/version says something changed, unless the operator is writing or was just scrolling or tapping (then it
// shows a "new" pill instead). An answer button is sent in the background so only its card changes.
(() => {
  const POLL_MS = 10_000;
  const LIVE_MS = 30_000;
  const BUSY_MS = 30_000;
  let version = document.querySelector('meta[name="board-version"]')?.getAttribute("content") ?? "";
  const news = document.getElementById("news");
  const box = document.querySelector(".composer textarea");
  let touched = 0;
  // The operator's own input only: a scroll the script makes (opening a record at its end) is not someone reading.
  for (const t of ["wheel", "touchstart", "touchmove", "pointerdown", "keydown", "input"])
    addEventListener(t, () => (touched = Date.now()), { capture: true, passive: true });
  const writing = () =>
    (box !== null && box.value.trim() !== "") ||
    document.activeElement?.matches?.("input:not([type=hidden]):not([readonly]),textarea:not([readonly]),select") ===
      true ||
    Date.now() - touched < BUSY_MS;

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

  // The 쿠파스 tab: a copy button copies its card's text box exactly. Where the clipboard is refused, the box is
  // selected (and copied the old way when the browser still allows it) so a long press copies it.
  const shown = new WeakMap();
  document.addEventListener("click", async (e) => {
    const b = e.target instanceof Element ? e.target.closest("button[data-copy]") : null;
    const text = b?.closest(".cpf")?.querySelector("textarea");
    const tip = b?.parentElement?.querySelector(".cpok");
    if (!b || !text || !tip) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text.value);
      ok = true;
    } catch {
      text.focus();
      text.select();
      text.setSelectionRange(0, text.value.length);
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
    tip.textContent = ok ? "복사했어요" : "선택했어요. 길게 눌러 복사해 주세요";
    tip.hidden = false;
    clearTimeout(shown.get(tip));
    shown.set(
      tip,
      setTimeout(() => {
        tip.hidden = true;
      }, 1500),
    );
  });

  // 확인 필요's answer buttons (POST /decide), 쿠파스's [올렸음] (POST /coupas) and a task's buttons on 할 일 (POST /backlog:
  // priority, drop, decision) go by fetch with the same body, csrf included; the board answers such a request with the
  // card's new state, which replaces every copy of that card. On a refusal or no network the card says so and its
  // buttons can be pressed again; a held answer keeps them off. Without this script the form posts.
  const CARD = {
    "/decide": ["article.ask", (c) => c.id],
    "/coupas": ["article.cpc", (c) => c.dataset.post],
    "/backlog": ["div.tk", (c) => c.id],
  };
  document.addEventListener("submit", async (e) => {
    const f = e.target;
    // The attribute, not f.action: a /backlog form's <input name="action"> shadows that property.
    const to = f instanceof HTMLFormElement ? new URL(f.getAttribute("action") ?? "", location.href) : null;
    const kind = to ? CARD[to.pathname] : undefined;
    const card = kind ? f.closest(kind[0]) : null;
    if (!kind || !card) return;
    e.preventDefault();
    const body = new URLSearchParams(new FormData(f));
    if (e.submitter?.name) body.append(e.submitter.name, e.submitter.value);
    body.append("v", version);
    const set = f.querySelector("fieldset");
    const say = (where, text, bad) => {
      where.querySelector(".fnote")?.remove();
      if (!text) return;
      const p = Object.assign(document.createElement("p"), {
        className: bad ? "fnote bad" : "fnote",
        textContent: text,
      });
      p.setAttribute("role", "status");
      where.append(p);
    };
    if (set) set.disabled = true;
    let why = "연결이 끊겨 보내지 못했어요. 다시 눌러 주세요.";
    try {
      const res = await fetch(to, {
        method: "POST",
        body,
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (res.ok) {
        const j = await res.json();
        // Something else changed before this answer: the page keeps its version and shows the "new" pill.
        if (j.v) version = j.v;
        else if (news) news.hidden = false;
        if (j.card || j.gone) {
          const key = kind[1](card);
          for (const old of document.querySelectorAll(kind[0])) {
            if (kind[1](old) !== key) continue;
            let next = old;
            if (j.card) {
              const t = document.createElement("template");
              t.innerHTML = j.card;
              next = t.content.firstElementChild;
              if (old.id) next.id = old.id;
              // A read-only copy (an ask another person answers) stays without buttons.
              if (!old.querySelector("form")) for (const x of next.querySelectorAll("form, .tka")) x.remove();
              old.replaceWith(next);
            } else for (const x of old.querySelectorAll("form, .tka")) x.remove();
            if (old === card) say(next, j.note, j.bad);
          }
          return;
        }
        // Held (the lead's pane may have it): the note says not to press again, so the buttons stay off.
        if (set && !j.held) set.disabled = false;
        return say(card, j.note, j.bad);
      }
      why =
        res.status === 403
          ? "보내지 못했어요: 허용된 계정·기기가 아니거나 화면이 오래됐어요. 새로 불러와 주세요."
          : `보내지 못했어요 (${res.status} ${(await res.text()).trim()}). 다시 눌러 주세요.`;
    } catch {
      // no network: `why` says so
    }
    if (set) set.disabled = false;
    say(card, why, true);
  });

  box?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) box.form?.requestSubmit();
  });

  async function poll() {
    // An open sheet (시트 tab) saves itself and is never reloaded under the operator's edits.
    if (document.hidden || document.querySelector("[data-sheet]")) return;
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

  // The 지금 and 사무실 tabs read the clock (방금 끝남 turns into 대기, a run past its timeout into 상태 확인 안 됨), which
  // /api/version does not see: it reloads on its own, unless the operator is writing.
  if (document.querySelector("[data-live]"))
    setInterval(() => {
      if (document.hidden || writing()) return;
      const url = new URL(location.href);
      url.searchParams.delete("sent");
      location.replace(url.pathname + url.search);
    }, LIVE_MS);
})();
