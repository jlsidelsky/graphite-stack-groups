// ponytail: keyed by PR number only — collides only if two repos in the org
// share a PR number in the same inbox, which just mis-groups a row.
const stacks = new Map();
// Stacks the user opened this page load. React re-renders wipe our DOM, so
// this set is what regroup() restores state from. Default collapsed.
const expanded = new Set();

const COLORS = [
  "#e05d5d",
  "#3d8bfd",
  "#2eaf7d",
  "#c06fd4",
  "#e0a13f",
  "#3fb8c4",
  "#8f7ce0",
  "#d46f9d",
];

const colorFor = (stackId) => {
  let h = 0;
  for (const c of stackId) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
};

const prNumber = (row) => {
  const a = row.querySelector('a[href*="/pr/"]');
  const m = a?.href.match(/\/pr\/[^/]+\/[^/]+\/(\d+)/);
  return m ? Number(m[1]) : null;
};

// "feat(api): verify webhook signatures (ABC-123)" -> "verify webhook signatures"
const stackLabel = (stack) =>
  (stack.title || stack.branch || "")
    .replace(/^[a-z]+\([a-z-]+\):\s*/i, "")
    .replace(/\s*\(?\[?[A-Z]{2,}-\d+\]?\)?\s*$/, "")
    .slice(0, 60) || `#${stack.number}`;

function renderHeader(tr, stackId, sorted, colSpan) {
  const top = sorted[0].stack;
  const isOpen = expanded.has(stackId);
  // Idempotence: skip the rewrite (a mutation) when nothing changed, so a
  // quiet DOM stays quiet and the observer never feeds itself.
  const key = `${isOpen}|${sorted.length}|${top.height}|${top.number}|${colSpan}`;
  if (tr.dataset.gsgKey === key) return;
  tr.dataset.gsgKey = key;
  const color = colorFor(stackId);
  const td = tr.cells[0] ?? tr.appendChild(document.createElement("td"));
  td.colSpan = colSpan;
  td.style.cssText = "padding:8px 12px;";
  td.innerHTML = `<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#374151;">
    <span style="color:#9ca3af;font-size:10px;width:10px;">${isOpen ? "&#9660;" : "&#9654;"}</span>
    <span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none;"></span>
    <span style="font-weight:600;">${stackLabel(top)}</span>
    <span style="background:#f3f4f6;border-radius:10px;padding:1px 8px;font-size:11px;color:#6b7280;">${sorted.length} PR${sorted.length > 1 ? "s" : ""} · stack of ${top.height}</span>
  </div>`;
}

function regroup() {
  observer.disconnect();
  try {
    regroupInner();
  } catch (e) {
    console.warn("[graphite-stack-groups]", e);
  } finally {
    observer.takeRecords();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}

function regroupInner() {
  for (const el of document.querySelectorAll(".gsg-ctl")) el.remove();
  // Inbox only: PR pages have stack tables with PR links too, and React re-renders them.
  if (location.pathname.startsWith("/github/")) return;
  for (const tbody of document.querySelectorAll(
    'table tbody',
  )) {
    if (![...tbody.rows].some((row) => prNumber(row) !== null)) continue;
    const headers = new Map(
      [...tbody.querySelectorAll(".gsg-header")].map((h) => [
        h.dataset.gsgStack,
        h,
      ]),
    );
    const dataRows = [...tbody.rows].filter(
      (r) => !r.classList.contains("gsg-header"),
    );
    const infos = dataRows.map((row) => ({
      row,
      stack: stacks.get(prNumber(row)),
    }));

    const byStack = new Map();
    for (const i of infos) {
      if (!i.stack) continue;
      if (!byStack.has(i.stack.stackId)) byStack.set(i.stack.stackId, []);
      byStack.get(i.stack.stackId).push(i);
    }
    for (const [k, v] of byStack) if (v.length < 2) byStack.delete(k);

    const colSpan = dataRows[0]?.cells.length ?? 8;

    // Desired child sequence: at a group's first member, its header row then
    // all members top-of-stack first; everything else keeps its position.
    const emitted = new Set();
    const seq = [];
    for (const i of infos) {
      const group = i.stack && byStack.get(i.stack.stackId);
      if (group) {
        const stackId = i.stack.stackId;
        if (emitted.has(stackId)) continue;
        emitted.add(stackId);
        const sorted = [...group].sort(
          (a, b) => b.stack.position - a.stack.position,
        );
        let header = headers.get(stackId);
        if (!header) {
          header = document.createElement("tr");
          header.className = "gsg-header";
          header.dataset.gsgStack = stackId;
          header.style.cursor = "pointer";
          header.addEventListener("click", () => {
            expanded.has(stackId)
              ? expanded.delete(stackId)
              : expanded.add(stackId);
            regroup();
          });
        }
        headers.delete(stackId);
        renderHeader(header, stackId, sorted, colSpan);
        seq.push(header, ...sorted.map((m) => m.row));
      } else {
        seq.push(i.row);
      }
    }
    for (const orphan of headers.values()) orphan.remove();

    const cur = [...tbody.children];
    if (seq.length !== cur.length || seq.some((el, idx) => el !== cur[idx])) {
      for (const el of seq) tbody.appendChild(el);
    }

    for (const i of infos) {
      const group = i.stack && byStack.get(i.stack.stackId);
      const cell = i.row.cells[0];
      if (!group) {
        if (i.row.style.display) i.row.style.display = "";
        if (cell?.style.boxShadow) cell.style.boxShadow = "";
        continue;
      }
      const isOpen = expanded.has(i.stack.stackId);
      const display = isOpen ? "" : "none";
      if (i.row.style.display !== display) i.row.style.display = display;
      const shadow = isOpen
        ? `inset 3px 0 0 ${colorFor(i.stack.stackId)}`
        : "";
      if (cell && cell.style.boxShadow !== shadow)
        cell.style.boxShadow = shadow;
    }
  }
}

// Debounce + circuit breaker: if something re-triggers us persistently
// (a React re-render fight), back off instead of saturating the main thread.
const REGROUP_DEBOUNCE_MS = 300;
const BREAKER_WINDOW_MS = 10_000;
const BREAKER_MAX_RUNS = 20;
const BREAKER_PAUSE_MS = 5_000;
let runTimes = [];
let pending = null;

const scheduleRegroup = () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const now = Date.now();
    runTimes = runTimes.filter((t) => now - t < BREAKER_WINDOW_MS);
    if (runTimes.length >= BREAKER_MAX_RUNS) {
      console.warn("[graphite-stack-groups] regroup storm, pausing");
      setTimeout(scheduleRegroup, BREAKER_PAUSE_MS);
      return;
    }
    runTimes.push(now);
    regroup();
  }, REGROUP_DEBOUNCE_MS);
};

const observer = new MutationObserver(scheduleRegroup);
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener("gsg-stacks", (e) => {
  for (const item of JSON.parse(e.detail)) stacks.set(item.number, item);
  scheduleRegroup();
});
