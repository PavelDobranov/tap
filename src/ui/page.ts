/**
 * The page Tap serves, as the three files a browser asks for.
 *
 * Everything here is literal text rather than a build step: the UI is one
 * page, it ships inside the CLI, and a viewer must be able to read the record
 * with nothing fetched from anywhere else. Keeping it beside the server that
 * serves it, rather than inside it, is only so that the transport and the page
 * can be read separately.
 *
 * The page is an *evidence* view, deliberately: it shows the payload Tap
 * reconstructed and the response events as they arrived, and interprets
 * neither. No message rendering, no diff. Those representations have not been
 * designed yet, and a view that guessed at them would hide the shapes the
 * design has to start from.
 */

export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tap · live requests</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
<body><header><div><strong>tap</strong><span id="connection">connecting</span></div><p id="lifecycle">Live session</p></header>
<main id="panes">
<section id="request-list">
<div id="controls">
<label for="thread">Thread</label><select id="thread"></select>
<label for="type">Type</label><select id="type"><option value="messages">messages</option><option value="count_tokens">count_tokens</option><option value="other">other</option><option value="any">any type</option></select>
<button type="button" id="turns" data-grouping="true">Turns: grouped</button>
<button type="button" id="show-all">Show every request</button>
</div>
<p id="grouping-note">Turns are inferred from the shape of each request\u2019s messages, not stated by the wire. A divider can be in the wrong place; no request is hidden, dropped or reordered by one.</p>
<p id="counts">0 requests</p>
<div id="rows"><table><thead><tr><th>Sequence</th><th>Type</th><th>Thread</th><th>Model</th><th>Status</th><th>Started</th><th>Duration</th><th>Tokens / cache</th></tr></thead><tbody id="requests"></tbody></table></div>
<p id="empty">Waiting for requests…</p>
</section>
<section id="evidence">
<p id="no-selection">Select a request to read the evidence Tap captured for it.</p>
<article id="evidence-body" hidden>
<h2 id="selected-title"></h2>
<p id="evidence-marks" hidden></p>
<h3>Payload</h3>
<pre id="payload"></pre>
<h3 id="response-heading">Raw response</h3>
<pre id="response"></pre>
</article>
</section>
</main></body></html>`;

export const APP = `(() => {
  "use strict";
  const pick = (id) => document.querySelector("#" + id);
  const body = pick("requests");
  const empty = pick("empty");
  const counts = pick("counts");
  const connection = pick("connection");
  const lifecycle = pick("lifecycle");
  const threadFilter = pick("thread");
  const typeFilter = pick("type");
  const showAll = pick("show-all");
  const turnsToggle = pick("turns");
  const groupingNote = pick("grouping-note");
  const evidence = pick("evidence-body");
  const prompt = pick("no-selection");
  const title = pick("selected-title");
  const marks = pick("evidence-marks");
  const payload = pick("payload");
  const responseHeading = pick("response-heading");
  const response = pick("response");

  // Everything the server has said, kept whole. Filters decide what is drawn
  // and never what is held: a request the filters hide is one action away,
  // and a viewer that dropped it would have to reconnect to get it back.
  const requests = new Map();
  const blobs = new Map();
  const rows = new Map();
  let threads = [];
  /**
   * Presentation state: what this viewer is looking at, and nothing the
   * record knows about. It never filters what is held, so no other viewer
   * can see it and nothing here has to survive a re-snapshot.
   */
  const viewing = { selected: null, thread: "main", type: "messages", grouping: true };
  /**
   * The turns this viewer has folded away, by thread and turn. Presentation
   * state like the filters: a folded turn is a row a reader is not looking
   * at, never a request the page has stopped holding.
   */
  const collapsed = new Set();
  let threadValues = "";

  const fields = ["seq", "type", "thread", "model", "state", "started", "duration", "usage"];
  const text = (cell, value) => { cell.textContent = value; };
  const plural = (count, noun) => count + " " + noun + (count === 1 ? "" : "s");

  const usage = (value) => {
    if (!value) return "—";
    const bits = [];
    if (value.inputTokens != null) bits.push("in " + value.inputTokens);
    if (value.outputTokens != null) bits.push("out " + value.outputTokens);
    if (value.cacheReadInputTokens != null) bits.push("cache read " + value.cacheReadInputTokens);
    if (value.cacheCreationInputTokens != null) bits.push("cache write " + value.cacheCreationInputTokens);
    return bits.join(" · ") || "—";
  };
  const state = (request) => {
    const activity = request.rawResponse.length ? " · receiving " + request.rawResponse.length : "";
    if (request.completedAt == null) return request.status == null ? "in flight" + activity : request.status + activity;
    return request.interrupted ? "interrupted" : String(request.status ?? "complete");
  };

  const mainThread = () => {
    const first = threads.find((thread) => thread.main);
    return first ? first.id : 1;
  };
  /** The thread the filter is asking for, or null when it asks for every one. */
  const wantedThread = () =>
    viewing.thread === "any" ? null : viewing.thread === "main" ? mainThread() : Number(viewing.thread);
  const matches = (request) => {
    const want = wantedThread();
    if (want !== null && request.thread !== want) return false;
    return viewing.type === "any" || request.type === viewing.type;
  };

  const render = (request) => {
    let held = rows.get(request.seq);
    if (!held) {
      const row = document.createElement("tr");
      row.dataset.seq = String(request.seq);
      row.addEventListener("click", () => select(request.seq));
      const cells = Object.fromEntries(fields.map((name) => {
        const cell = document.createElement("td"); row.append(cell); return [name, cell];
      }));
      held = { row, cells }; rows.set(request.seq, held);
    }
    text(held.cells.seq, String(request.seq)); text(held.cells.type, request.type);
    text(held.cells.thread, request.thread == null ? "—" : request.thread === mainThread() ? "main" : "thread " + request.thread);
    text(held.cells.model, request.model ?? "—"); text(held.cells.state, state(request));
    text(held.cells.started, new Date(request.startedAt).toLocaleTimeString());
    text(held.cells.duration, request.durationMs == null ? "—" : request.durationMs + " ms");
    text(held.cells.usage, usage(request.usage));
    held.row.dataset.selected = request.seq === viewing.selected ? "true" : "false";
    // A row redrawn on its own — a response event arriving, say — stays where
    // the layout put it: a folded turn that unfolded itself because one of
    // its requests was still streaming would be a list that moves under a
    // reader who asked it to hold still.
    held.row.hidden = away(request);
  };

  /**
   * Whether a request is off screen, and the only rule that decides it: the
   * filters are hiding it, or the turn it is grouped into is folded away.
   * Neither is the record forgetting it.
   */
  const away = (request) => !matches(request) || collapsed.has(groupKey(request));

  /**
   * The group a request is read in: its turn, within its thread. Null where
   * there is none to read it in — grouping is off, or the record left the
   * request ungrouped because it is not conversation.
   */
  const groupKey = (request) =>
    viewing.grouping && request.turn != null && request.thread != null
      ? request.thread + ":" + request.turn
      : null;

  const label = (run, folded) =>
    (folded ? "\u25b8 " : "\u25be ") +
    (run.thread === mainThread() ? "" : "thread " + run.thread + " \u00b7 ") +
    "turn " + run.turn + " \u00b7 inferred \u00b7 " + plural(run.size, "request") +
    (run.resumed ? " \u00b7 resumed" : "");

  /** The divider a run of a turn begins at, and the one thing that folds it. */
  const divider = (run) => {
    const folded = collapsed.has(run.key);
    const row = document.createElement("tr");
    row.className = "turn";
    row.dataset.turn = String(run.turn);
    row.dataset.thread = String(run.thread);
    row.dataset.collapsed = folded ? "true" : "false";
    const cell = document.createElement("td");
    cell.setAttribute("colspan", String(fields.length));
    cell.textContent = label(run, folded);
    row.append(cell);
    row.addEventListener("click", () => {
      if (folded) collapsed.delete(run.key); else collapsed.add(run.key);
      redraw();
    });
    return row;
  };

  /**
   * The runs the visible list falls into: one per divider, in the order they
   * appear, each the stretch of adjacent requests of one turn.
   *
   * A turn is a run rather than the whole turn because wire order comes
   * first. Two threads interleave, and a count_tokens request lands mid-loop, so
   * the requests of one turn need not be adjacent — and gathering them would
   * mean reordering the list, which grouping is never allowed to do. A turn
   * picked up again after something else is a second divider saying so, and
   * each divider counts the requests under it rather than the turn's, so a
   * heading never claims rows that are not beneath it.
   */
  const runs = (ordered) => {
    const found = new Map();
    const seen = new Set();
    let open = null;
    for (const request of ordered) {
      if (!matches(request)) continue;
      const key = groupKey(request);
      if (key === null) {
        open = null;
        continue;
      }
      if (open === null || open.key !== key) {
        open = { key, turn: request.turn, thread: request.thread, size: 0, resumed: seen.has(key) };
        seen.add(key);
        // Keyed by the request the divider goes above.
        found.set(request.seq, open);
      }
      open.size += 1;
    }
    return found;
  };

  /**
   * The list as it reads down the page: every request in wire order, with a
   * divider where an inferred turn begins or is picked up again.
   *
   * Grouping is a layer over the list and never the list itself. Rows are
   * the same elements whether they are grouped, folded or filtered away —
   * they are re-ordered into nothing, dropped from nothing, and a divider in
   * the wrong place costs a reader a misplaced heading and nothing else.
   */
  const layout = () => {
    const ordered = [...requests.values()].sort((first, second) => first.seq - second.seq);
    // Worked out before anything is drawn, so that a divider can say how many
    // requests it is holding while it is holding them out of sight.
    const dividers = runs(ordered);

    const children = [];
    let hidden = 0;
    let folded = 0;
    for (const request of ordered) {
      const held = rows.get(request.seq);
      if (!held) continue;
      const run = dividers.get(request.seq);
      if (run !== undefined) children.push(divider(run));
      const gone = away(request);
      if (!matches(request)) hidden += 1;
      else if (gone) folded += 1;
      held.row.hidden = gone;
      children.push(held.row);
    }
    body.replaceChildren(...children);
    return { hidden, folded };
  };

  // The list redrawn, and what is on screen and what is not said in full and
  // at all times: a list that does not count what it is hiding — behind a
  // filter or inside a folded turn — is a screen a reader can confidently
  // draw the wrong conclusion from.
  const redraw = () => {
    const { hidden, folded } = layout();
    counts.textContent = plural(requests.size, "request") + " · " +
      (hidden === 0 ? "none hidden" : hidden + " hidden") +
      (folded === 0 ? "" : " · " + folded + " collapsed into turns");
    empty.hidden = requests.size - hidden > 0;
    empty.textContent = requests.size === 0
      ? "Waiting for requests…"
      : "No request matches these filters. Every request is still here: show every request.";
  };

  const threadOptions = () => {
    const ids = new Set();
    threads.forEach((thread) => ids.add(thread.id));
    requests.forEach((request) => { if (request.thread != null) ids.add(request.thread); });
    const main = mainThread();
    const values = ["main"]
      .concat([...ids].filter((id) => id !== main).sort((a, b) => a - b).map(String))
      .concat(["any"]);
    const key = values.join(",");
    if (key === threadValues) return;
    threadValues = key;
    // Only reachable if a snapshot lists fewer threads than the one before
    // it, which a session never does: threads are numbered in order of first
    // appearance and never retired. Here so that a filter can never name a
    // thread the list has no option for, which would read as an empty record.
    if (values.indexOf(viewing.thread) < 0) viewing.thread = "main";
    threadFilter.replaceChildren(...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "main" ? "main thread" : value === "any" ? "any thread" : "thread " + value;
      return option;
    }));
    threadFilter.value = viewing.thread;
  };

  // The rule the snapshot documents: the skeleton's text as it stands, each
  // reference filled from the blob map with its annotations put back, and a
  // marked hole where a blob has been evicted. Never nothing — a gap a reader
  // cannot see reads as a shorter conversation than the one that happened.
  const holeText = (hash) => "/* tap evicted this unit to stay under its cap: " + hash + " */";
  const restore = (json, annotations) => {
    let restored = "";
    let cursor = 0;
    for (const annotation of annotations) {
      restored += json.slice(cursor, annotation.at) + annotation.text;
      cursor = annotation.at;
    }
    return restored + json.slice(cursor);
  };
  const payloadParts = (skeleton) => skeleton.map((part) => {
    if (typeof part === "string") return { text: part, hole: false };
    const blob = blobs.get(part.blob);
    if (!blob) return { text: holeText(part.blob), hole: true };
    return { text: restore(blob.json, part.annotations), hole: false };
  });
  const references = (request, hash) =>
    request != null && request.skeleton != null &&
    request.skeleton.some((part) => typeof part !== "string" && part.blob === hash);

  const countEvents = (request) => {
    responseHeading.textContent = "Raw response · " + plural(request.rawResponse.length, "event");
  };
  const renderResponse = (request) => {
    countEvents(request);
    response.textContent = request.rawResponse.join("");
  };

  const renderEvidence = () => {
    const request = viewing.selected == null ? null : requests.get(viewing.selected);
    evidence.hidden = request == null;
    prompt.hidden = request != null;
    if (request == null) return;
    title.textContent = "Request " + request.seq + " · " + request.type + " · " +
      request.method + " " + request.endpoint;

    const parts = request.skeleton == null ? [] : payloadParts(request.skeleton);
    const holes = parts.filter((part) => part.hole).length;
    payload.replaceChildren(...parts.map((part) => {
      if (!part.hole) return document.createTextNode(part.text);
      const mark = document.createElement("mark");
      mark.className = "hole";
      mark.textContent = part.text;
      return mark;
    }));

    const notes = [];
    if (request.skeleton == null) notes.push("No payload was captured for this request.");
    if (holes > 0) {
      notes.push("Incomplete: " + plural(holes, "unit") + " evicted to stay under the record cap, " +
        "so this is not the whole payload and is not valid JSON.");
    }
    if (request.interrupted) {
      notes.push("Interrupted: the response ended without the upstream closing it. " +
        "Every event that arrived is below, and it is not the whole response.");
    } else if (request.completedAt == null) {
      notes.push("In flight: response events are still arriving.");
    }
    marks.textContent = notes.join(" ");
    marks.hidden = notes.length === 0;
    marks.dataset.partial = holes > 0 || request.interrupted ? "true" : "false";
    renderResponse(request);
  };

  const select = (seq) => {
    viewing.selected = seq;
    rows.forEach((held, key) => { held.row.dataset.selected = key === seq ? "true" : "false"; });
    renderEvidence();
  };

  const freeze = (agent) => {
    lifecycle.textContent = agent.signal ? "Frozen · agent exited by " + agent.signal : "Frozen · agent exited with code " + agent.code;
    document.body.dataset.frozen = "true";
  };

  const snapshot = (value) => {
    requests.clear(); rows.clear(); blobs.clear(); body.replaceChildren();
    threads = value.threads || [];
    const held = value.blobs || {};
    for (const hash of Object.keys(held)) blobs.set(hash, held[hash]);
    value.requests.forEach((request) => { requests.set(request.seq, request); render(request); });
    if (viewing.selected != null && !requests.has(viewing.selected)) viewing.selected = null;
    threadOptions(); redraw(); renderEvidence();
    if (value.lifecycle.phase === "frozen") freeze(value.lifecycle.agent);
  };

  const delta = (event) => {
    if (event.type === "request-start") {
      requests.set(event.request.seq, event.request);
      render(event.request); threadOptions(); redraw();
    } else if (event.type === "request-change") {
      const request = requests.get(event.seq);
      if (!request) return;
      Object.assign(request, event.changes);
      render(request); threadOptions(); redraw();
      if (viewing.selected === event.seq) renderEvidence();
    } else if (event.type === "raw-response") {
      const request = requests.get(event.seq);
      if (!request) return;
      request.rawResponse.push(event.event);
      render(request);
      // Appended rather than redrawn: the events of one response are the one
      // thing here that grows without bound while it is being read.
      if (viewing.selected === event.seq) {
        countEvents(request);
        response.append(document.createTextNode(event.event));
      }
    } else if (event.type === "blob-added") {
      blobs.set(event.hash, event.blob);
      if (references(requests.get(viewing.selected), event.hash)) renderEvidence();
    } else if (event.type === "blob-evicted") {
      blobs.delete(event.eviction.blob);
      if (references(requests.get(viewing.selected), event.eviction.blob)) renderEvidence();
    } else if (event.type === "frozen") freeze(event.agent);
  };

  threadFilter.addEventListener("change", () => { viewing.thread = threadFilter.value; redraw(); });
  typeFilter.addEventListener("change", () => { viewing.type = typeFilter.value; redraw(); });
  turnsToggle.addEventListener("click", () => {
    viewing.grouping = !viewing.grouping;
    // Dropped rather than remembered: the flat list is the whole of the
    // record in wire order, and a turn folded before grouping was switched
    // off would fold requests a reader had asked to see all of.
    if (!viewing.grouping) collapsed.clear();
    turnsToggle.dataset.grouping = String(viewing.grouping);
    turnsToggle.textContent = viewing.grouping ? "Turns: grouped" : "Turns: flat";
    groupingNote.hidden = !viewing.grouping;
    redraw();
  });
  showAll.addEventListener("click", () => {
    viewing.thread = "any"; viewing.type = "any";
    threadFilter.value = "any"; typeFilter.value = "any";
    redraw();
  });
  typeFilter.value = viewing.type;
  threadOptions(); redraw();

  const token = new URL(location.href).searchParams.get("token");
  const source = new EventSource("/api/events" + (token ? "?token=" + encodeURIComponent(token) : ""));
  source.addEventListener("open", () => { connection.textContent = "connected"; });
  source.addEventListener("error", () => { connection.textContent = "reconnecting"; });
  source.addEventListener("snapshot", (message) => snapshot(JSON.parse(message.data).snapshot));
  source.addEventListener("delta", (message) => delta(JSON.parse(message.data)));
})();`;

export const STYLE = `:root{color-scheme:dark;font:14px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;background:#101211;color:#e7ebe8}
*{box-sizing:border-box}body{margin:0}
header{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:16px 24px;background:#171a18;border-bottom:1px solid #303632}
header div{display:flex;gap:16px;align-items:center}header strong{color:#7ee2a8;font-size:18px}header span{color:#9da7a0}header p{margin:0;color:#7ee2a8}
#panes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;padding:16px;align-items:start}
#panes>section{min-width:0;background:#151816;border:1px solid #2b302d}
#controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px;border-bottom:1px solid #2b302d}
#controls label{color:#98a39c;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
select,button{font:inherit;color:inherit;background:#1c211e;border:1px solid #39413b;padding:4px 8px}
button{cursor:pointer}button:hover{background:#242b26}
#grouping-note{margin:0;padding:8px 12px;color:#98a39c;border-bottom:1px solid #2b302d}
tr.turn{cursor:pointer;background:#1a201d}tr.turn:hover{background:#212925}
tr.turn td{color:#7ee2a8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;white-space:normal}
tr.turn[data-collapsed=true] td{color:#cfa85f}
#counts{margin:0;padding:8px 12px;color:#98a39c;border-bottom:1px solid #2b302d}
#rows{overflow:auto}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #2b302d;white-space:nowrap}
th{color:#98a39c;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
tbody tr{cursor:pointer}tbody tr:hover{background:#1c211e}tbody tr[data-selected=true]{background:#20302a;outline:1px solid #7ee2a8}
#empty{color:#7d8780;text-align:center;padding:32px 16px}
#evidence{padding:12px}#evidence h2{font-size:14px;margin:0 0 8px}#evidence h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#98a39c;margin:16px 0 6px}
#no-selection{color:#7d8780;margin:0;padding:32px 16px;text-align:center}
#evidence-marks{margin:0;padding:8px 10px;border-left:3px solid #7ee2a8;background:#1a201d;color:#cfd8d2}
#evidence-marks[data-partial=true]{border-left-color:#e2726a;background:#2a1c1a;color:#f0c9c4}
pre{margin:0;padding:10px;background:#0d0f0e;border:1px solid #2b302d;max-height:40vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
mark.hole{background:#4a1f1b;color:#ffb9b1;font-weight:700;outline:1px solid #e2726a}
[data-frozen=true] header p{color:#d8b66a}
@media(max-width:900px){#panes{grid-template-columns:1fr}header,#panes{padding:12px}th:nth-child(6),td:nth-child(6){display:none}}`;
