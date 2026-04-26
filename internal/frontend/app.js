// commander web renderer — vanilla-JS SPA.
//
// Unary calls hit the Connect endpoints via plain JSON POST. State-attach
// streaming uses Connect's server-streaming wire format (framed JSON over a
// single chunked response). See https://connectrpc.com/docs/protocol/.

const SERVICE = "/commander.v1.Commander";

async function callUnary(method, msg) {
  const resp = await fetch(`${SERVICE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${method}: ${resp.status} ${text}`);
  }
  return resp.json();
}

// --- Connect server-streaming decoder (framed JSON) -----------------------
// Frame format: 1-byte flags, 4-byte big-endian length, N-byte payload.
// Flags bit 1 (value 2) signals the end-of-stream envelope carrying the
// stream trailer (an object with optional "error").
async function* streamCall(method, msg) {
  // Connect streaming: request body is itself a single envelope
  // [flags=0 | len big-endian u32 | JSON payload].
  const payload = new TextEncoder().encode(JSON.stringify(msg));
  const body = new Uint8Array(5 + payload.length);
  body[0] = 0;
  body[1] = (payload.length >>> 24) & 0xff;
  body[2] = (payload.length >>> 16) & 0xff;
  body[3] = (payload.length >>> 8) & 0xff;
  body[4] = payload.length & 0xff;
  body.set(payload, 5);

  const resp = await fetch(`${SERVICE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/connect+json" },
    body,
  });
  if (!resp.ok) throw new Error(`${method}: ${resp.status} ${await resp.text()}`);
  const reader = resp.body.getReader();
  let buf = new Uint8Array();
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf); merged.set(value, buf.length);
      buf = merged;
    }
    while (buf.length >= 5) {
      const flags = buf[0];
      const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
      if (buf.length < 5 + len) break;
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      const text = new TextDecoder().decode(payload);
      if ((flags & 2) !== 0) {
        const trailer = JSON.parse(text || "{}");
        if (trailer.error) throw new Error(trailer.error.message || JSON.stringify(trailer.error));
        return;
      }
      yield JSON.parse(text);
    }
    if (done) return;
  }
}

// --- shared column model (fetched from commander-web /columns.json) -------
let COLUMNS = [
  { id: "icon",  title: "",         minWidth: 24,  weight: 0, align: "center", sortable: false },
  { id: "name",  title: "Name",     minWidth: 140, weight: 3, align: "left",   sortable: true  },
  { id: "size",  title: "Size",     minWidth: 90,  weight: 1, align: "right",  sortable: true  },
  { id: "mtime", title: "Modified", minWidth: 150, weight: 1, align: "left",   sortable: true  },
];
function currentSort(paneId) {
  const t = activeTab(paneId);
  const col = (t && t.sortColumn) || "name";
  const dir = (t && t.sortDirection) || "asc";
  return { col, dir };
}

function sortIndicator(paneId, colId) {
  const { col, dir } = currentSort(paneId);
  if (col !== colId) return "";
  return dir === "asc" ? " ▲" : " ▼";
}

async function cycleSort(paneId, colId) {
  const t = activeTab(paneId);
  if (!t) return;
  const { col, dir } = currentSort(paneId);
  const nextDir = (col === colId && dir === "asc") ? "desc" : "asc";
  try {
    await callUnary("SetTabSort", {
      paneId, tabId: t.tabId, sortColumn: colId, sortDirection: nextDir,
    });
  } catch (err) { console.debug("SetTabSort:", err.message); }
}

function entrySortKey(e, colId) {
  switch (colId) {
    case "name":  return (e.name || "").toLocaleLowerCase();
    case "size":  return e.isDir ? -1 : parseInt(e.size || "0", 10);
    case "mtime": return e.modTime || "";
    default:      return "";
  }
}

function sortEntries(paneId) {
  const { col, dir } = currentSort(paneId);
  const mult = dir === "asc" ? 1 : -1;
  // Preserve ".." at index 0 if present.
  const list = entries[paneId];
  if (!list) return;
  const first = list[0];
  const rest = first && first.__parent ? list.slice(1) : list.slice();
  rest.sort((a, b) => {
    // Directories always group above files regardless of direction.
    if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
    const ka = entrySortKey(a, col), kb = entrySortKey(b, col);
    if (ka < kb) return -1 * mult;
    if (ka > kb) return  1 * mult;
    // Tiebreak by name so ordering is stable across renders.
    return (a.name || "").localeCompare(b.name || "");
  });
  entries[paneId] = first && first.__parent ? [first, ...rest] : rest;
}
async function loadColumns() {
  try {
    const res = await fetch("/columns.json");
    if (res.ok) COLUMNS = await res.json();
  } catch (e) { /* keep defaults */ }
}

// loadIconSprite pulls the SVG sprite built from the shared Go icons package
// and injects it into the DOM so `<use href="#icon-...">` resolves. Fyne uses
// the same icons.<Name> values directly, giving both renderers identical glyphs.
async function loadIconSprite() {
  try {
    const res = await fetch("/icons.sprite.svg");
    if (!res.ok) return;
    const holder = document.getElementById("icon-sprite");
    if (holder) holder.innerHTML = await res.text();
  } catch (e) { console.debug("loadIconSprite:", e.message); }
}

function gridTemplate() {
  return COLUMNS.map(c =>
    c.weight > 0 ? `minmax(${c.minWidth}px, ${c.weight}fr)` : `${c.minWidth}px`
  ).join(" ");
}

function renderColumnHeader(paneId) {
  const hdr = document.getElementById(`cols-${paneId}`);
  hdr.style.gridTemplateColumns = gridTemplate();
  hdr.replaceChildren(...COLUMNS.map(c => {
    const d = document.createElement("div");
    d.className = "cell align-" + c.align + (c.sortable ? " sortable" : "");
    d.textContent = c.title + sortIndicator(paneId, c.id);
    if (c.sortable) {
      d.title = `Sort by ${c.title}`;
      d.onclick = () => cycleSort(paneId, c.id);
    }
    return d;
  }));
}

// computedDirSizes caches human-readable folder sizes the user has requested
// via the Space key. Keyed by VPath string ("scheme:path").
const computedDirSizes = new Map();

function computedKey(vp) {
  return (vp && vp.scheme || "") + ":" + (vp && vp.path || "");
}

function formatSize(entry) {
  if (entry.isDir) {
    const cached = computedDirSizes.get(computedKey(entry.path));
    return cached || "<DIR>";
  }
  const n = parseInt(entry.size || "0", 10);
  return humanSize(n);
}

async function computeDirSize(entry) {
  if (!entry || !entry.isDir || entry.__parent) return;
  const key = computedKey(entry.path);
  computedDirSizes.set(key, "computing…");
  render();
  try {
    const res = await callUnary("ComputeSize", { path: entry.path });
    const b = parseInt(res.bytes || "0", 10);
    computedDirSizes.set(key, humanSize(b));
  } catch (err) {
    computedDirSizes.delete(key);
    console.debug("ComputeSize:", err.message);
  }
  render();
}

function formatMtime(entry) {
  // entry.modTime arrives as an ISO-8601 string in UTC (e.g. "2026-04-19T21:28:00Z").
  // `new Date(iso)` parses it as an absolute instant; the getFullYear/Month/…
  // accessors then project it into the browser's local timezone for display.
  return formatIsoTime(entry && entry.modTime);
}

function formatCtime(entry) {
  return formatIsoTime(entry && entry.createTime);
}

function formatIsoTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- state mirror ---------------------------------------------------------
const state = {
  panes: { left: { tabs: [], activeTabId: "" }, right: { tabs: [], activeTabId: "" } },
  ops: {},
  bookmarks: [],
};

function isBookmarked(cwd) {
  if (!cwd) return false;
  return (state.bookmarks || []).some(b =>
    b.path && b.path.scheme === cwd.scheme && b.path.path === cwd.path);
}

// --- context menu ---------------------------------------------------------
const ctxMenu    = document.getElementById("ctx-menu");
const ctxSubmenu = document.getElementById("ctx-submenu");
function hideCtxMenu() {
  ctxMenu.style.display    = "none";
  ctxSubmenu.style.display = "none";
}
function hideCtxSubmenu() { ctxSubmenu.style.display = "none"; }
document.addEventListener("click", hideCtxMenu);
document.addEventListener("contextmenu", (ev) => {
  // Text inputs keep the native menu (for copy/paste/spellcheck);
  // everywhere else commander owns right-click, so suppress the
  // browser default and close any open commander menu.
  const ed = ev.target.closest("input, textarea");
  if (!ed) ev.preventDefault();
  if (!ev.target.closest(".tab") && !ev.target.closest(".row") && !ev.target.closest(".pane-header") && !ev.target.closest(".term-wrap") && !ev.target.closest(".nav") && !ev.target.closest(".new-tab-btn") && !ev.target.closest(".list")) hideCtxMenu();
});
window.addEventListener("blur", hideCtxMenu);

function buildCtxItem(it, anyIcon) {
  if (it.separator) {
    const s = document.createElement("div");
    s.className = "ctx-sep";
    return s;
  }
  const d = document.createElement("div");
  const hasChildren = Array.isArray(it.children) && it.children.length > 0;
  // Normalize single rightAction into the rightActions array so the
  // render loop handles one or many the same way.
  const rightActions = Array.isArray(it.rightActions)
    ? it.rightActions
    : (it.rightAction ? [it.rightAction] : []);
  const hasRightAction = rightActions.length > 0;
  d.className = "item" + (it.disabled ? " disabled" : "") + (hasChildren ? " has-children" : "") + (hasRightAction ? " has-right-action" : "") + (it.inert ? " inert" : "");
  if (it.iconId) {
    d.innerHTML = `<svg class="glyph"><use href="#${it.iconId}"/></svg>`;
  } else if (it.emoji) {
    // Emoji slot occupies the same width as the sprite icon so rows
    // with mixed icon styles still line up vertically.
    const e = document.createElement("span");
    e.className = "glyph-emoji";
    e.textContent = it.emoji;
    d.appendChild(e);
  } else if (anyIcon) {
    d.innerHTML = `<span class="glyph-placeholder"></span>`;
  }
  const lbl = document.createElement("span");
  lbl.textContent = it.label;
  d.appendChild(lbl);
  if (!it.disabled && !it.inert && !hasChildren) {
    d.onclick = (ev) => {
      ev.stopPropagation();
      hideCtxMenu();
      it.onClick();
    };
  }
  if (hasChildren) {
    const caret = document.createElement("span");
    caret.className = "submenu-caret";
    caret.innerHTML = `<svg><use href="#icon-arrow-right"/></svg>`;
    d.appendChild(caret);
    if (!it.disabled) {
      d.addEventListener("mouseenter", () => openSubmenu(d, it.children));
    }
  }
  // rightActions: one or more secondary buttons flush-right on the row.
  // Each can carry an optional text label and an optional color token
  // (currently "green"). Only the first gets the margin-left:auto
  // treatment; subsequent buttons pack to the right of it.
  rightActions.forEach((ra, idx) => {
    const el = document.createElement("span");
    el.className = "ctx-right-action" + (ra.color ? " ctx-right-action-" + ra.color : "") + (idx > 0 ? " ctx-right-action-extra" : "");
    el.title = ra.title || "";
    let inner = "";
    if (ra.iconId) inner += `<svg class="glyph"><use href="#${ra.iconId}"/></svg>`;
    if (ra.label)  inner += `<span class="ctx-ra-label">${ra.label}</span>`;
    el.innerHTML = inner;
    el.onclick = (ev) => {
      ev.stopPropagation();
      hideCtxMenu();
      ra.onClick();
    };
    d.appendChild(el);
  });
  return d;
}

// clampToViewport nudges the (x, y) top-left of a menu element so it stays
// on-screen — needed for menus anchored near the right edge (e.g. the right
// pane's bookmarks button).
function clampToViewport(el, x, y) {
  el.style.left = x + "px";
  el.style.top  = y + "px";
  el.style.display = "block";
  const r = el.getBoundingClientRect();
  const pad = 4;
  let nx = x, ny = y;
  if (r.right > window.innerWidth)   nx = Math.max(pad, window.innerWidth  - r.width  - pad);
  if (r.bottom > window.innerHeight) ny = Math.max(pad, window.innerHeight - r.height - pad);
  if (nx !== x) el.style.left = nx + "px";
  if (ny !== y) el.style.top  = ny + "px";
}

function openSubmenu(anchor, children) {
  const rect = anchor.getBoundingClientRect();
  const anyIcon = children.some(c => c.iconId || c.emoji);
  ctxSubmenu.replaceChildren(...children.map(c => {
    const d = buildCtxItem(c, anyIcon);
    // Submenu clicks must also dismiss the parent.
    if (d.onclick) {
      const orig = d.onclick;
      d.onclick = (ev) => { hideCtxSubmenu(); orig(ev); };
    }
    return d;
  }));
  clampToViewport(ctxSubmenu, rect.right, rect.top);
}

function showCtxMenu(x, y, items) {
  hideCtxSubmenu();
  const anyIcon = items.some(it => it.iconId || it.emoji);
  ctxMenu.replaceChildren(...items.map(it => buildCtxItem(it, anyIcon)));
  // Hide the submenu when hovering a leaf item — stops stale submenus from
  // lingering after the cursor leaves a "has-children" row.
  for (const child of ctxMenu.children) {
    if (!child.classList.contains("has-children")) {
      child.addEventListener("mouseenter", hideCtxSubmenu);
    }
  }
  clampToViewport(ctxMenu, x, y);
}

// archiveFormat infers the container kind from an entry's filename and
// returns one of the ArchiveFormat proto enum strings, or "" when the
// entry isn't a recognized archive. Keep in sync with detectArchiveFormat
// in internal/daemon/server/launch.go.
function archiveFormat(entry) {
  if (!entry || entry.isDir || !entry.name) return "";
  const n = entry.name.toLowerCase();
  if (n.endsWith(".zip"))                          return "ARCHIVE_FORMAT_ZIP";
  if (n.endsWith(".tar.gz") || n.endsWith(".tgz")) return "ARCHIVE_FORMAT_TAR_GZ";
  if (n.endsWith(".tar.xz") || n.endsWith(".txz")) return "ARCHIVE_FORMAT_TAR_XZ";
  return "";
}

function showRowMenu(paneId, entry, x, y) {
  const detected = archiveFormat(entry);
  const packFormat = (label, fmt) => ({
    label,
    // Packing is not useful against archives; disable when we'd be
    // wrapping a zip inside another zip etc.
    disabled: !!detected,
    onClick: async () => {
      try { await callUnary("PackArchive", { source: entry.path, format: fmt }); reloadPane(paneId); }
      catch (e) { showInfo(e.message); }
    },
  });
  const unpackFormat = (label, fmt) => ({
    label,
    // Each unpack sub-item is only enabled for a matching filename; the
    // daemon also infers from extension, but surfacing disabled/enabled
    // state up-front keeps the menu self-documenting.
    disabled: detected !== fmt,
    onClick: async () => {
      try { await callUnary("UnpackArchive", { archive: entry.path, format: fmt }); reloadPane(paneId); }
      catch (e) { showInfo(e.message); }
    },
  });
  const items = [
    {
      label: "open in new tab",
      iconId: "icon-tab-new",
      // Only directories make sense as a tab cwd; files can't be tabs.
      disabled: !entry.isDir,
      onClick: async () => {
        try { await callUnary("OpenTab", { paneId, cwd: entry.path }); }
        catch (e) { showInfo(e.message); }
      },
    },
    {
      label: "open with",
      iconId: "icon-gear",
      disabled: !!entry.isDir,
      children: [
        {
          label: "vscode",
          onClick: async () => {
            try { await callUnary("LaunchEditor", { path: entry.path, editor: "vscode" }); }
            catch (e) { showInfo(e.message); }
          },
        },
        {
          label: "vim",
          onClick: async () => {
            try { await callUnary("LaunchEditor", { path: entry.path, editor: "vim" }); }
            catch (e) { showInfo(e.message); }
          },
        },
      ],
    },
    {
      label: "pack",
      iconId: "icon-pack",
      children: [
        packFormat("zip",    "ARCHIVE_FORMAT_ZIP"),
        packFormat("tar.gz", "ARCHIVE_FORMAT_TAR_GZ"),
        packFormat("tar.xz", "ARCHIVE_FORMAT_TAR_XZ"),
      ],
    },
    {
      label: "unpack",
      iconId: "icon-pack",
      disabled: !detected,
      children: [
        unpackFormat("zip",    "ARCHIVE_FORMAT_ZIP"),
        unpackFormat("tar.gz", "ARCHIVE_FORMAT_TAR_GZ"),
        unpackFormat("tar.xz", "ARCHIVE_FORMAT_TAR_XZ"),
      ],
    },
    { separator: true },
    {
      label: "bookmark",
      iconId: "icon-bookmarks",
      // Bookmarks are folder-only — you navigate into them, not at files.
      disabled: !entry.isDir,
      onClick: async () => {
        try { await callUnary("AddBookmark", { name: entry.name || "", path: entry.path }); }
        catch (e) { showInfo(e.message); }
      },
    },
    {
      label: "stash",
      iconId: "icon-stash",
      onClick: async () => {
        try { await callUnary("AddToStash", { paths: [entry.path] }); }
        catch (e) { showInfo(e.message); }
      },
    },
    { separator: true },
    {
      label: "delete",
      iconId: "icon-trash",
      onClick: async () => {
        if (!(await showConfirm(`delete "${entry.name}"?`))) return;
        try { await callUnary("StartDelete", { targets: [entry.path] }); }
        catch (e) { showInfo(e.message); }
      },
    },
    {
      label: "clone",
      iconId: "icon-clone",
      onClick: async () => {
        try { await callUnary("DuplicateEntry", { path: entry.path }); reloadPane(paneId); }
        catch (e) { showInfo(e.message); }
      },
    },
    {
      label: "symbolic link",
      iconId: "icon-link",
      onClick: async () => {
        try { await callUnary("CreateSymlink", { target: entry.path }); reloadPane(paneId); }
        catch (e) { showInfo(e.message); }
      },
    },
    { separator: true },
    {
      label: "cut",
      iconId: "icon-cut",
      onClick: async () => {
        try { await callUnary("SetClipboard", { clipboard: { mode: "MODE_CUT", paths: [entry.path] } }); }
        catch (e) { showInfo(e.message); }
      },
    },
    {
      label: "copy",
      iconId: "icon-copy",
      onClick: async () => {
        try { await callUnary("SetClipboard", { clipboard: { mode: "MODE_COPY", paths: [entry.path] } }); }
        catch (e) { showInfo(e.message); }
      },
    },
    {
      label: "paste",
      iconId: "icon-paste",
      disabled: !(state.clipboard && state.clipboard.paths && state.clipboard.paths.length),
      onClick: async () => {
        const tab = activeTab(paneId);
        if (!tab) return;
        try { await callUnary("PasteClipboard", { destPaneId: paneId, destTabId: tab.tabId }); }
        catch (e) { showInfo(e.message); }
      },
    },
    { separator: true },
    {
      label: "properties",
      iconId: "icon-info",
      onClick: () => {
        // Select the row first so showProperties picks up just this
        // entry rather than whatever selection existed before.
        setSelection(paneId, []);
        setCursor(paneId, entry.name);
        showProperties(paneId);
      },
    },
  ];
  showCtxMenu(x, y, items);
}

function showTabMenu(paneId, tab, x, y) {
  const isTerm = tab.kind === "TAB_KIND_TERMINAL";
  const bookmarked = !isTerm && isBookmarked(tab.cwd);
  const items = [
    {
      label: "close",
      iconId: "icon-close",
      // Pinned tabs ignore close (matching the close-button behavior on
      // the tab silhouette) — the menu shows it disabled so the user
      // can see why nothing's happening.
      disabled: !!tab.pinned,
      onClick: () => closeTabById(paneId, tab.tabId),
    },
    { separator: true },
    { label: tab.pinned ? "unpin" : "pin", emoji: "📌", onClick: () => togglePin(paneId, tab) },
  ];
  // File tabs (including sftp ones — they're file tabs whose cwd
  // sits inside an sshfs mount): clone via a submenu so the user
  // picks the destination pane explicitly.
  if (!isTerm) {
    const otherPane = paneId === "left" ? "right" : "left";
    items.push({
      label: "clone",
      iconId: "icon-clone",
      children: [
        { label: "tab here",  iconId: "icon-tab-new", onClick: () => duplicateTab(paneId,    tab) },
        { label: "tab there", iconId: "icon-tab-new", onClick: () => duplicateTab(otherPane, tab) },
      ],
    });
    if (!bookmarked) {
      items.push({ label: "bookmark", iconId: "icon-bookmarks", onClick: () => addBookmark(tab) });
    }
  }
  // SSH terminal tabs: "see files" mounts the same host via sshfs and
  // opens a file tab on the OTHER pane at the remote home — lets the
  // user browse remote files without losing their shell.
  if (isTerm && tab.sshAlias) {
    items.push({
      label: "browse files",
      iconId: "icon-sftp",
      onClick: () => seeFilesForSshTab(paneId, tab),
    });
  }
  showCtxMenu(x, y, items);
}

async function seeFilesForSshTab(paneId, tab) {
  const alias = tab.sshAlias;
  if (!alias) return;
  const otherPane = paneId === "left" ? "right" : "left";
  try {
    const res = await callUnary("MountSshHost", { alias });
    const path = (res && (res.cwd || res.mountPath)) || "";
    if (!path) { showInfo("mount failed: empty path"); return; }
    await callUnary("OpenTab", { paneId: otherPane, cwd: { scheme: "file", path } });
  } catch (err) { showInfo(err.message); }
}

async function duplicateTab(paneId, tab) {
  try { await callUnary("OpenTab", { paneId, cwd: tab.cwd }); }
  catch (err) { showInfo(err.message); }
}
async function togglePin(paneId, tab) {
  try { await callUnary("SetTabPinned", { paneId, tabId: tab.tabId, pinned: !tab.pinned }); }
  catch (err) { showInfo(err.message); }
}
async function addBookmark(tab) {
  try { await callUnary("AddBookmark", { name: tab.title || "", path: tab.cwd }); }
  catch (err) { showInfo(err.message); }
}
async function removeBookmark(tab) {
  try { await callUnary("RemoveBookmark", { path: tab.cwd }); }
  catch (err) { showInfo(err.message); }
}

function applyEvent(ev) {
  if (ev.delta) {
    for (const m of ev.delta.mutations || []) {
      if (m.replaceAll) {
        state.panes = m.replaceAll.snapshot.panes || { left: {}, right: {} };
        for (const p of Object.keys(state.panes)) {
          state.panes[p].tabs = state.panes[p].tabs || [];
        }
        state.bookmarks = m.replaceAll.snapshot.bookmarks || [];
        state.activePane = m.replaceAll.snapshot.activePane || "left";
        state.clipboard = m.replaceAll.snapshot.clipboard || null;
        state.theme = m.replaceAll.snapshot.theme || "dark";
        state.stash = (m.replaceAll.snapshot.stash || []).slice();
        state.settings = (m.replaceAll.snapshot.settings && m.replaceAll.snapshot.settings.kv) || {};
      } else if (m.paneTabAdded) {
        const p = state.panes[m.paneTabAdded.paneId] ||= { tabs: [], activeTabId: "" };
        p.tabs.push(m.paneTabAdded.tab);
      } else if (m.paneTabRemoved) {
        const p = state.panes[m.paneTabRemoved.paneId];
        // Pick off the departing tab BEFORE splicing so we know its
        // terminal session id (if any) and can tear down the matching
        // xterm instance — the daemon-side PTY is already gone.
        const leaving = p && p.tabs.find(t => t.tabId === m.paneTabRemoved.tabId);
        if (leaving && leaving.kind === "TAB_KIND_TERMINAL" && leaving.terminalSessionId) {
          disposeTerminalBySession(leaving.terminalSessionId);
        }
        if (p) p.tabs = p.tabs.filter(t => t.tabId !== m.paneTabRemoved.tabId);
      } else if (m.paneActiveTabChanged) {
        const p = state.panes[m.paneActiveTabChanged.paneId];
        if (p) p.activeTabId = m.paneActiveTabChanged.activeTabId;
      } else if (m.paneTabCwdChanged) {
        const p = state.panes[m.paneTabCwdChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabCwdChanged.tabId);
          if (tab) {
            tab.cwd = m.paneTabCwdChanged.cwd;
            tab.title = cwdTitle(tab.cwd);
          }
        }
      } else if (m.paneTabSortChanged) {
        const p = state.panes[m.paneTabSortChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabSortChanged.tabId);
          if (tab) {
            tab.sortColumn = m.paneTabSortChanged.sortColumn;
            tab.sortDirection = m.paneTabSortChanged.sortDirection;
          }
        }
      } else if (m.paneTabCursorChanged) {
        const p = state.panes[m.paneTabCursorChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabCursorChanged.tabId);
          if (tab) tab.cursorName = m.paneTabCursorChanged.cursorName || "";
        }
      } else if (m.paneTabSelectionChanged) {
        const p = state.panes[m.paneTabSelectionChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabSelectionChanged.tabId);
          if (tab) tab.selectedNames = (m.paneTabSelectionChanged.selectedNames || []).slice();
        }
      } else if (m.paneTabPinnedChanged) {
        const p = state.panes[m.paneTabPinnedChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabPinnedChanged.tabId);
          if (tab) tab.pinned = !!m.paneTabPinnedChanged.pinned;
        }
      } else if (m.activePaneChanged) {
        state.activePane = m.activePaneChanged.activePane || "left";
      } else if (m.paneTabShowHiddenFilesChanged) {
        const p = state.panes[m.paneTabShowHiddenFilesChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabShowHiddenFilesChanged.tabId);
          if (tab) tab.showHiddenFiles = !!m.paneTabShowHiddenFilesChanged.value;
        }
      } else if (m.paneTabShowFilterBarChanged) {
        const p = state.panes[m.paneTabShowFilterBarChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabShowFilterBarChanged.tabId);
          if (tab) tab.showFilterBar = !!m.paneTabShowFilterBarChanged.value;
        }
      } else if (m.paneTabShowSearchBarChanged) {
        const p = state.panes[m.paneTabShowSearchBarChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabShowSearchBarChanged.tabId);
          if (tab) tab.showSearchBar = !!m.paneTabShowSearchBarChanged.value;
        }
      } else if (m.paneTabSearchChanged) {
        const p = state.panes[m.paneTabSearchChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabSearchChanged.tabId);
          if (tab) tab.searchQuery = m.paneTabSearchChanged.searchQuery || "";
        }
      } else if (m.paneTabSearchCaseSensitiveChanged) {
        const p = state.panes[m.paneTabSearchCaseSensitiveChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabSearchCaseSensitiveChanged.tabId);
          if (tab) tab.searchCaseSensitive = !!m.paneTabSearchCaseSensitiveChanged.caseSensitive;
        }
      } else if (m.paneTabTitleChanged) {
        const p = state.panes[m.paneTabTitleChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabTitleChanged.tabId);
          if (tab) tab.title = m.paneTabTitleChanged.title || "";
        }
      } else if (m.clipboardChanged) {
        state.clipboard = m.clipboardChanged.clipboard || null;
      } else if (m.themeChanged) {
        state.theme = m.themeChanged.theme || "dark";
      } else if (m.settingsChanged) {
        state.settings = (m.settingsChanged.kv) || {};
        if (typeof applySettingsToDialog === "function") applySettingsToDialog();
      } else if (m.stashChanged) {
        state.stash = (m.stashChanged.items || []).slice();
      } else if (m.paneTabHistoryChanged) {
        const p = state.panes[m.paneTabHistoryChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabHistoryChanged.tabId);
          if (tab) {
            tab.history = m.paneTabHistoryChanged.history || [];
            tab.historyIndex = m.paneTabHistoryChanged.historyIndex || 0;
          }
        }
      } else if (m.paneTabFilterChanged) {
        const p = state.panes[m.paneTabFilterChanged.paneId];
        if (p) {
          const tab = p.tabs.find(t => t.tabId === m.paneTabFilterChanged.tabId);
          if (tab) tab.filterText = m.paneTabFilterChanged.filterText || "";
        }
      } else if (m.paneTabsReordered) {
        const p = state.panes[m.paneTabsReordered.paneId];
        if (p) {
          const byID = new Map((p.tabs || []).map(t => [t.tabId, t]));
          const order = m.paneTabsReordered.tabOrder || [];
          const ordered = [];
          for (const id of order) {
            const t = byID.get(id);
            if (t) { ordered.push(t); byID.delete(id); }
          }
          for (const t of (p.tabs || [])) if (byID.has(t.tabId)) ordered.push(t);
          p.tabs = ordered;
        }
      } else if (m.bookmarkAdded) {
        state.bookmarks = state.bookmarks || [];
        state.bookmarks.push(m.bookmarkAdded.bookmark);
      } else if (m.bookmarkRemoved) {
        const p = m.bookmarkRemoved.path;
        state.bookmarks = (state.bookmarks || []).filter(b =>
          !(b.path && b.path.scheme === p.scheme && b.path.path === p.path));
      } else if (m.opUpsert) {
        const next = m.opUpsert.op;
        const prev = state.ops[next.opId];
        state.ops[next.opId] = next;
        // When an op reaches a terminal phase (DONE/FAILED/CANCELLED) after
        // having been RUNNING, refresh both panes so the file list reflects
        // any copies/moves/deletes that just completed.
        const prevPhase = prev && prev.phase;
        const terminal = next.phase === "OP_PHASE_DONE" ||
                         next.phase === "OP_PHASE_FAILED" ||
                         next.phase === "OP_PHASE_CANCELLED";
        if (terminal && prevPhase !== next.phase) {
          reloadPane("left");
          reloadPane("right");
        }
        if (opsQueueDialog.open) renderOpsQueueBody();
        refreshOpsQButton();
      } else if (m.opRemoved) {
        delete state.ops[m.opRemoved.opId];
        if (opsQueueDialog.open) renderOpsQueueBody();
        refreshOpsQButton();
      }
    }
  }
  if (ev.progress && ev.progressOpId) {
    const op = state.ops[ev.progressOpId];
    if (op) op.progress = ev.progress;
  }
  if (ev.prompt) {
    handlePrompt(ev.prompt);
  }
  scheduleRender();
}

// --- ops prompt handler (overwrite conflicts, etc.) ---------------------
// The daemon's ops engine sends a PromptRequest ServerEvent whenever a
// worker hits an ambiguous condition (currently just file overwrite
// conflicts). Any attached renderer can answer via AnswerPrompt — first
// answer wins. If no renderer answers within 5 min the worker gives up.
const overwriteDialog      = document.getElementById("overwrite-dialog");
const overwriteBody        = document.getElementById("overwrite-body");
const overwriteRenameRow   = document.getElementById("overwrite-rename-row");
const overwriteRenameInput = document.getElementById("overwrite-rename-input");
const overwriteBtns = {
  overwrite:     document.getElementById("overwrite-overwrite"),
  overwriteAll:  document.getElementById("overwrite-overwrite-all"),
  rename:        document.getElementById("overwrite-rename"),
  skip:          document.getElementById("overwrite-skip"),
  skipAll:       document.getElementById("overwrite-skip-all"),
  cancel:        document.getElementById("overwrite-cancel"),
};

// formatPromptTime renders a wire ISO-8601 timestamp as "YYYY-MM-DD
// HH:MM" in the viewer's local timezone. Empty / missing values become
// an em dash so the prompt table stays column-aligned.
function formatPromptTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// pad right-pads s with spaces up to width. Used to align the
// size/created/modified columns in the overwrite prompt body.
function pad(s, width) {
  s = String(s);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function answerPrompt(promptId, kind, renameTo) {
  try {
    await callUnary("AnswerPrompt", {
      promptId,
      answer: kind,
      renameTo: renameTo || "",
    });
  } catch (e) {
    console.debug("AnswerPrompt:", e.message);
  }
}

function handlePrompt(prompt) {
  // Only kind we currently model is the overwrite conflict. Ignore
  // anything else gracefully so future kinds don't blow up the UI.
  if (prompt.kind !== "PROMPT_KIND_OVERWRITE_CONFLICT" || !prompt.overwrite) return;
  const ow = prompt.overwrite;
  const existing = ow.existing || {};
  const incoming = ow.incoming || {};
  const name = existing.name || incoming.name || "";
  // Two aligned columns so the user can compare size / created /
  // modified side-by-side. "—" is shown when a timestamp is missing
  // (e.g. the filesystem doesn't track birth time).
  const rows = [
    ["Size",     humanSize(parseInt(existing.size || "0", 10)), humanSize(parseInt(incoming.size || "0", 10))],
    ["Created",  formatPromptTime(existing.createTime),          formatPromptTime(incoming.createTime)],
    ["Modified", formatPromptTime(existing.modTime),             formatPromptTime(incoming.modTime)],
  ];
  const labelW = 10, colW = 22;
  const header = `"${name}" already exists.\n\n` +
    pad("", labelW) + pad("Existing", colW) + "Incoming\n";
  const table = rows.map(([lbl, a, b]) =>
    pad(lbl + ":", labelW) + pad(a, colW) + b
  ).join("\n");
  overwriteBody.textContent = header + table;
  overwriteRenameRow.style.display = "none";
  overwriteRenameInput.value = name;

  let settled = false;
  const answer = (kind, renameTo) => {
    if (settled) return;
    settled = true;
    Object.values(overwriteBtns).forEach(b => (b.onclick = null));
    overwriteDialog.close();
    answerPrompt(prompt.promptId, kind, renameTo);
  };
  overwriteBtns.overwrite.onclick    = () => answer("PROMPT_ANSWER_OVERWRITE");
  overwriteBtns.overwriteAll.onclick = () => answer("PROMPT_ANSWER_OVERWRITE_ALL");
  overwriteBtns.skip.onclick         = () => answer("PROMPT_ANSWER_SKIP");
  overwriteBtns.skipAll.onclick      = () => answer("PROMPT_ANSWER_SKIP_ALL");
  overwriteBtns.cancel.onclick       = () => answer("PROMPT_ANSWER_CANCEL");
  overwriteBtns.rename.onclick = () => {
    // Two-stage: first click reveals the rename input; second click
    // submits the typed value. Cancel / other answers dismiss normally.
    if (overwriteRenameRow.style.display === "none") {
      overwriteRenameRow.style.display = "block";
      overwriteRenameInput.focus();
      overwriteRenameInput.select();
      return;
    }
    const name = overwriteRenameInput.value.trim();
    if (!name) return;
    answer("PROMPT_ANSWER_RENAME", name);
  };
  overwriteDialog.addEventListener("cancel", (ev) => {
    // Esc on a <dialog> normally closes it; treat that as SKIP so the
    // worker doesn't block waiting for a real answer.
    ev.preventDefault();
    answer("PROMPT_ANSWER_SKIP");
  }, { once: true });

  overwriteDialog.showModal();
  setTimeout(() => overwriteBtns.overwrite.focus(), 0);
}

// --- UI -------------------------------------------------------------------
// activePane is derived from shared state; mutations go through setActivePane
// which RPCs the daemon. Never assign to this — use setActivePane(id).
Object.defineProperty(window, "activePane", {
  get() { return state.activePane || "left"; },
});

async function setActivePane(paneId) {
  if (paneId !== "left" && paneId !== "right") return;
  if ((state.activePane || "left") === paneId) return;
  try { await callUnary("SetActivePane", { activePane: paneId }); }
  catch (err) { console.debug("SetActivePane:", err.message); }
}

const entries = { left: [], right: [] };

// Returns the index of the currently-cursored row for a pane. Falls back to 0
// when no cursor is set (or the cursored entry no longer exists in the list).
function cursorIndex(paneId) {
  const t = activeTab(paneId);
  const name = t && t.cursorName;
  if (!name) return 0;
  const idx = entries[paneId].findIndex(e => e.name === name);
  return idx < 0 ? 0 : idx;
}

async function setCursor(paneId, name) {
  const t = activeTab(paneId);
  if (!t) return;
  if (t.cursorName === name) return;
  try {
    await callUnary("SetTabCursor", { paneId, tabId: t.tabId, cursorName: name });
  } catch (err) { console.debug("SetTabCursor:", err.message); }
}

// --- multi-selection ------------------------------------------------------
function currentSelection(paneId) {
  const t = activeTab(paneId);
  const names = (t && t.selectedNames) || [];
  return { set: new Set(names), list: names };
}

async function setSelection(paneId, names) {
  const t = activeTab(paneId);
  if (!t) return;
  try {
    await callUnary("SetTabSelection", { paneId, tabId: t.tabId, selectedNames: names });
  } catch (err) { console.debug("SetTabSelection:", err.message); }
}

function toggleSelection(paneId, name) {
  const { set } = currentSelection(paneId);
  if (set.has(name)) set.delete(name); else set.add(name);
  // Preserve on-screen order.
  const out = entries[paneId].filter(e => set.has(e.name) && !e.__parent).map(e => e.name);
  setSelection(paneId, out);
}

const shiftAnchor = { left: "", right: "" };

function extendSelection(paneId, name) {
  if (!shiftAnchor[paneId]) shiftAnchor[paneId] = name;
  const anchor = shiftAnchor[paneId];
  const list = entries[paneId];
  const a = list.findIndex(e => e.name === anchor);
  const b = list.findIndex(e => e.name === name);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const out = [];
  for (let i = lo; i <= hi; i++) if (!list[i].__parent) out.push(list[i].name);
  setSelection(paneId, out);
}

function moveCursor(paneId, delta) {
  const list = entries[paneId];
  if (!list.length) return;
  let next = cursorIndex(paneId) + delta;
  if (next < 0) next = 0;
  if (next >= list.length) next = list.length - 1;
  setCursor(paneId, list[next].name);
}

function activeTab(paneId) {
  const p = state.panes[paneId];
  if (!p) return null;
  return (p.tabs || []).find(t => t.tabId === p.activeTabId) || null;
}

function cwdTitle(cwd) {
  if (!cwd || !cwd.path) return "";
  const p = cwd.path;
  // Trim trailing slashes except root.
  let end = p.length;
  while (end > 1 && p[end - 1] === "/") end--;
  const i = p.lastIndexOf("/", end - 1);
  if (i < 0) return p.slice(0, end);
  if (i === end - 1) return p.slice(0, end);
  return p.slice(i + 1, end);
}

function canAscend(cwdPath) {
  if (!cwdPath) return false;
  if (cwdPath === "/") return false;
  // Windows drive root: "/C:" or "/C:/"
  if (/^\/[A-Za-z]:\/?$/.test(cwdPath)) return false;
  return true;
}

// relativeUnder returns entryPath expressed relative to rootPath, using
// POSIX separators. When entryPath doesn't live under rootPath the
// absolute path is returned unchanged (shouldn't happen with
// SearchEntries output, but keeps the UI honest if it does).
function relativeUnder(rootPath, entryPath) {
  if (!rootPath || !entryPath) return entryPath || "";
  let r = rootPath;
  if (!r.endsWith("/")) r += "/";
  if (entryPath === rootPath) return "";
  if (entryPath.startsWith(r)) return entryPath.slice(r.length);
  return entryPath;
}

// --- xterm.js integration -------------------------------------------------
//
// Every terminal tab in any pane gets its own xterm instance, keyed by
// the session id. The pane's .term-host holds an absolute-positioned
// .term-wrap per session; only the wrap matching the pane's active
// terminal tab carries the `active` class and becomes visible. This
// way multiple terminal tabs in the same pane stay alive side by side
// and switching between them is free.
const terms = Object.create(null); // sessionId -> { paneId, wrap, term, fit, banner, ws, backoff, closed, activity }

function syncTerminal(paneId, tab) {
  const host = document.getElementById(`term-${paneId}`);
  if (!host) return;
  const wantedSid = tab ? tab.terminalSessionId : null;

  // Flip the `active` class on every wrap that belongs to this pane
  // so only the one matching the active tab is visible. Only the
  // TRANSITION to active triggers the heavy fit/refresh/focus path —
  // re-running it on every render (which fires 3× per click when
  // setSelection / setCursor / setActivePane round-trip back) was
  // the main cause of slow row-clicks while a terminal was open.
  for (const sid in terms) {
    const e = terms[sid];
    if (e.paneId !== paneId) continue;
    const isActive = sid === wantedSid;
    const wasActive = e.wrap.classList.contains("active");
    e.wrap.classList.toggle("active", isActive);
    if (isActive) {
      e.activity = 0; // reading the buffer = marking as read
      if (!wasActive) fitTerminalEntry(e);
    }
  }
  if (!wantedSid) return;
  // Already have an instance for this session — nothing to build.
  if (terms[wantedSid]) return;

  // Fresh per-session xterm instance. Each session lives in its own
  // absolutely-positioned wrap inside the pane's host; the banner
  // overlays the xterm for session-died / reconnecting messages.
  // WebGL addon intentionally NOT used: xterm's WebGL renderer does
  // not multiplex cleanly across tabs — creating a second WebGL
  // terminal evicts the first context, and both break silently. The
  // default canvas renderer handles multi-instance and tab-switches
  // reliably; clearTextureAtlas() on reveal still avoids the stale-
  // atlas bug there.
  const Term           = window.Terminal;
  const FitAddon       = (window.FitAddon       && window.FitAddon.FitAddon)             || null;
  const Unicode11Addon = (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) || null;
  const WebLinksAddon  = (window.WebLinksAddon  && window.WebLinksAddon.WebLinksAddon)   || null;
  if (!Term) { console.error("xterm.js missing"); return; }
  const wrap = document.createElement("div");
  wrap.className = "term-wrap active";
  wrap.dataset.sessionId = wantedSid;
  const termDiv = document.createElement("div");
  termDiv.className = "term-canvas";
  const banner = document.createElement("div");
  banner.className = "term-banner";
  banner.hidden = true;
  wrap.appendChild(termDiv);
  wrap.appendChild(banner);
  host.appendChild(wrap);

  const term = new Term({
    fontFamily: '"Mononoki", ui-monospace, monospace',
    fontSize: 13,
    theme: { background: "#000000" },
    cursorBlink: true,
    scrollback: 2000,
    allowProposedApi: true,
  });
  const fit = FitAddon ? new FitAddon() : null;
  if (fit) term.loadAddon(fit);
  // Unicode11 corrects the width of emoji / CJK characters so the
  // cursor tracks with the shell's measurements. Loaded before open
  // because xterm caches the width-resolver on first draw.
  if (Unicode11Addon) {
    try {
      term.loadAddon(new Unicode11Addon());
      if (term.unicode && term.unicode.activeVersion !== "11") {
        term.unicode.activeVersion = "11";
      }
    } catch (e) { console.debug("unicode11 addon:", e && e.message); }
  }
  // WebLinks makes URLs in the buffer clickable (opens a new tab).
  if (WebLinksAddon) {
    try { term.loadAddon(new WebLinksAddon()); }
    catch (e) { console.debug("web-links addon:", e && e.message); }
  }
  term.open(termDiv);
  if (fit) { try { fit.fit(); } catch {} }

  const entry = {
    sessionId: wantedSid,
    paneId,
    wrap, term, fit, banner,
    ws: null,
    backoff: 500,          // ms; doubles on each reconnect up to 10s
    closed: false,         // true once the daemon told us the session is dead
    activity: 0,           // unread-output counter for the bell/activity indicator
  };
  terms[wantedSid] = entry;

  connectTerminalWS(entry);
  // Clicking anywhere in the terminal also sets this pane as active
  // so the keymap routes subsequent keystrokes to xterm — without
  // this the user has to click the tab button (or press Tab) after
  // coming back from the other pane's file list.
  wrap.addEventListener("mousedown", () => setActivePane(entry.paneId));

  // Terminal-scope shortcuts. ONLY our own shortcut branches call
  // stopPropagation; anything else falls through so xterm's own
  // textarea listeners still receive the keystroke (capture-phase
  // stopPropagation would skip the target phase and break Backspace,
  // Enter, arrow keys, etc.). Commander's document-level handler
  // bails on TEXTAREA targets, so there's no leak either way.
  termDiv.addEventListener("keydown", (ev) => {
    if (!termDiv.contains(document.activeElement)) return;
    // Copy: Ctrl+Shift+C — selection → commander clipboard (text)
    // AND the native OS clipboard. Commander's Clipboard now carries
    // a text field so terminal selections travel with the same
    // mechanism used for file copy/cut.
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === "C" || ev.key === "c")) {
      const sel = term.getSelection();
      if (sel) {
        ev.preventDefault();
        ev.stopPropagation();
        callUnary("SetClipboard", { clipboard: { mode: "MODE_COPY", text: sel } })
          .catch(() => {});
        if (navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {});
      }
      return;
    }
    // Paste: Ctrl+Shift+V — prefer commander clipboard text, fall
    // back to the OS clipboard. Bytes are forwarded to the PTY.
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === "V" || ev.key === "v")) {
      ev.preventDefault();
      ev.stopPropagation();
      pasteIntoTerminal(entry);
      return;
    }
    // All other keys: DO NOT stop propagation — xterm's own textarea
    // listeners still need to see them. Commander's document handler
    // bails on TEXTAREA, and the text-input guard blurs this textarea
    // when the active pane is a file pane, so nothing else fights us.
  }, true);
  // Any key after the session died dismisses the banner (closes tab).
  termDiv.addEventListener("keydown", (ev) => {
    if (!entry.closed) return;
    ev.preventDefault();
    ev.stopPropagation();
    closeTerminalTab(entry.sessionId);
  });

  // Drag-and-drop integration: rows in the file list set
  // `application/x-commander-paths` on their drag data (JSON-encoded
  // VPath array). When the drop lands on a terminal wrap we paste
  // shell-quoted paths separated by spaces, so the user can drag a
  // file from the pane into their shell prompt.
  wrap.addEventListener("dragover", (ev) => {
    if (ev.dataTransfer && ev.dataTransfer.types.includes("application/x-commander-paths")) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    }
  });
  wrap.addEventListener("drop", (ev) => {
    const raw = ev.dataTransfer && ev.dataTransfer.getData("application/x-commander-paths");
    if (!raw) return;
    ev.preventDefault();
    let paths = [];
    try { paths = JSON.parse(raw); } catch { return; }
    if (!paths.length) return;
    // Prompt at the drop point: either just paste the (local) path as
    // text, or have the daemon transfer the file (scp for SSH, no-op
    // for local) and paste the result. Never auto-transfer — the
    // user may not want to push bytes over the wire implicitly.
    const pasteFullPath = () => {
      const text = paths.map(p => shellQuote((p && p.path) || "")).filter(Boolean).join(" ");
      if (text && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(text + " ");
      }
    };
    const pasteNameOnly = () => {
      const text = paths.map(p => {
        const full = (p && p.path) || "";
        const slash = full.lastIndexOf("/");
        return shellQuote(slash >= 0 ? full.slice(slash + 1) : full);
      }).filter(Boolean).join(" ");
      if (text && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(text + " ");
      }
    };
    const copyAndPaste = async () => {
      // Modal progress dialog — the banner was half-clipped at the
      // bottom of the terminal, easy to miss and impossible to see
      // if the terminal was in alt-screen mode. A real dialog sits
      // above everything with a clear spinner + file list.
      const dlg      = document.getElementById("upload-dialog");
      const msgEl    = document.getElementById("upload-dialog-msg");
      const filesEl  = document.getElementById("upload-dialog-files");
      if (dlg && filesEl) {
        filesEl.replaceChildren(...paths.map(p => {
          const li = document.createElement("li");
          li.textContent = (p && p.path) || "";
          return li;
        }));
        msgEl.textContent = `Transferring ${paths.length} file${paths.length === 1 ? "" : "s"}…`;
        if (typeof dlg.showModal === "function") dlg.showModal();
        else dlg.open = true;
      }
      try {
        // Fire-and-verify upload. Intentionally don't paste the
        // remote name into the shell — the user can tab-complete on
        // their own and we avoid injecting unexpected bytes into a
        // running command.
        await callUnary("UploadToTerminal", {
          sessionId: entry.sessionId,
          localPaths: paths,
        });
      } catch (err) {
        showInfo("upload failed: " + err.message);
      } finally {
        if (dlg && dlg.open) dlg.close();
      }
    };
    showCtxMenu(ev.clientX, ev.clientY, [
      { label: "paste name only", iconId: "icon-paste",    onClick: pasteNameOnly },
      { label: "paste full path", iconId: "icon-paste",    onClick: pasteFullPath },
      { label: "upload file",     iconId: "icon-arrow-up", onClick: copyAndPaste  },
    ]);
  });

  // Right-click inside the terminal pops commander's own context
  // menu with the usual terminal actions. Capture phase so xterm's
  // internal textarea target doesn't get the default browser menu.
  wrap.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const hasSelection = !!term.getSelection();
    showCtxMenu(ev.clientX, ev.clientY, [
      {
        label: "copy",
        iconId: "icon-copy",
        disabled: !hasSelection,
        onClick: () => {
          const sel = term.getSelection();
          if (!sel) return;
          callUnary("SetClipboard", { clipboard: { mode: "MODE_COPY", text: sel } })
            .catch(() => {});
          if (navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {});
        },
      },
      {
        label: "paste",
        iconId: "icon-paste",
        onClick: () => pasteIntoTerminal(entry),
      },
      { separator: true },
      {
        label: "clear scrollback",
        iconId: "icon-trash",
        onClick: () => { try { term.clear(); } catch {} },
      },
      {
        label: "close terminal",
        iconId: "icon-close",
        onClick: () => closeTerminalTab(entry.sessionId),
      },
    ]);
  }, true);

  term.onData((d) => {
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) entry.ws.send(d);
  });
  term.onResize(({ cols, rows }) => { debouncedResize(entry, cols, rows); });
  // Activity indicator: mark the owning tab unread whenever output
  // arrives while the tab is in the background. Flipping 0 → 1 once
  // is enough — additional chunks don't re-render the tab bar.
  const markUnread = () => {
    if (entry.wrap.classList.contains("active")) return;
    if (entry.activity === 0) {
      entry.activity = 1;
      render();
    }
  };
  if (typeof term.onWriteParsed === "function") term.onWriteParsed(markUnread);
  if (typeof term.onBell === "function")        term.onBell(markUnread);
  // OSC 0 / OSC 2 "set window title" — shells emit these for the
  // current command or host; propagate to the shared tab title so
  // every renderer sees the live name.
  term.onTitleChange((t) => {
    if (!t) return;
    callUnary("SetTabTitle", { paneId: entry.paneId, tabId: tabIdForSession(entry.sessionId), title: t })
      .catch(() => {});
  });

  // Kick an initial fit once the wrap has its final box size.
  setTimeout(() => fitTerminalEntry(entry), 0);
}

// Debounce resize-RPCs: xterm fires onResize per-column while the user
// drags the window; we coalesce to one RPC ~100ms after the last
// change so the daemon doesn't get hammered with SIGWINCHes.
const _resizeTimers = Object.create(null);
function debouncedResize(entry, cols, rows) {
  clearTimeout(_resizeTimers[entry.sessionId]);
  _resizeTimers[entry.sessionId] = setTimeout(() => {
    callUnary("ResizeTerminal", { sessionId: entry.sessionId, cols, rows })
      .catch(() => {});
  }, 100);
}

// connectTerminalWS opens (or re-opens) the WebSocket bound to the
// session and wires it to the entry's xterm. On abnormal close we
// back off and retry; on normal close with a code message we show
// the session-died banner.
function connectTerminalWS(entry) {
  if (entry.closed) return;
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  // Subprotocols: "commander.terminal.v1" is echoed by the daemon to
  // complete the handshake. Auth is via the Authorization header
  // injected server-side by commander-web's proxy.
  const ws = new WebSocket(
    `${wsProto}://${location.host}/ws/terminal/${entry.sessionId}`,
    ["commander.terminal.v1"],
  );
  ws.binaryType = "arraybuffer";
  entry.ws = ws;
  if (entry.banner) entry.banner.hidden = true;

  ws.onopen = () => {
    entry.backoff = 500; // reset backoff on success
    // Force a resize so the PTY has the same dimensions the xterm
    // thinks it's showing — useful after a reconnect where cols/rows
    // may be out of sync.
    if (entry.term && entry.term.cols && entry.term.rows) {
      callUnary("ResizeTerminal", {
        sessionId: entry.sessionId,
        cols: entry.term.cols,
        rows: entry.term.rows,
      }).catch(() => {});
    }
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") entry.term.write(ev.data);
    else entry.term.write(new Uint8Array(ev.data));
  };
  ws.onclose = (ev) => {
    // CloseNormalClosure (1000) carrying a "exited with code N"
    // reason = the daemon says the PTY child exited. Don't reconnect;
    // show the banner and wait for the user to dismiss it.
    if (ev.code === 1000) {
      const reason = ev.reason || "session closed";
      showSessionEnded(entry, reason);
      return;
    }
    // 1005 (no status) and 1006 (abnormal) = network or daemon blip.
    // Back off and retry up to ~10s cap.
    if (entry.closed) return;
    const delay = Math.min(entry.backoff, 10_000);
    entry.backoff = Math.min(entry.backoff * 2, 10_000);
    showReconnecting(entry, delay);
    setTimeout(() => connectTerminalWS(entry), delay);
  };
  ws.onerror = () => { /* onclose handles the follow-up */ };
}

function showSessionEnded(entry, reason) {
  entry.closed = true;
  if (!entry.banner) return;
  entry.banner.textContent = `[${reason}] — press any key to close`;
  entry.banner.hidden = false;
}

function showReconnecting(entry, delayMs) {
  if (!entry.banner) return;
  entry.banner.textContent = `connection lost — reconnecting in ${Math.round(delayMs / 1000)}s`;
  entry.banner.hidden = false;
}

// Cached user home for tilde expansion. Populated lazily on first
// use (and retried on failure) so we don't block renderer startup.
let _homePathCache = null;
async function userHomePath() {
  if (_homePathCache) return _homePathCache;
  try {
    const res = await callUnary("GetUserHome", {});
    _homePathCache = (res && res.home && res.home.path) || "";
  } catch { _homePathCache = ""; }
  return _homePathCache;
}

// expandUserPath replaces a leading "~" or "~/" with the user's home
// directory. Anything else passes through unchanged. Used by the
// "CD into" prompt so shell-style paths work without users having
// to type their full home path.
async function expandUserPath(p) {
  if (!p) return p;
  if (p === "~")        return (await userHomePath()) || p;
  if (p.startsWith("~/")) {
    const home = await userHomePath();
    return home ? home + p.slice(1) : p;
  }
  return p;
}

// shellQuote wraps a string in POSIX-shell single quotes, escaping any
// embedded single quotes. Paths with spaces, parens, or shell glob
// chars survive the paste into the terminal without surprising the
// shell's tokenizer.
function shellQuote(s) {
  if (!s) return "";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s; // no quoting needed
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// pasteIntoTerminal injects text from the commander clipboard (or the
// browser's native clipboard as a fallback) into the given entry's
// PTY. Used by both the Ctrl+Shift+V shortcut and the right-click
// context-menu "paste" action.
async function pasteIntoTerminal(entry) {
  let text = (state.clipboard && state.clipboard.text) || "";
  if (!text && navigator.clipboard) {
    try { text = await navigator.clipboard.readText(); } catch {}
  }
  if (text && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(text);
  }
}

// tabIdForSession returns the commander tab_id whose terminal session
// matches. Needed by SetTabTitle since OSC title events only know
// about the PTY side, not the tab.
function tabIdForSession(sessionId) {
  const t = terms[sessionId];
  if (!t) return "";
  const pane = state.panes[t.paneId];
  if (!pane) return "";
  const tab = (pane.tabs || []).find(x => x.terminalSessionId === sessionId);
  return tab ? tab.tabId : "";
}

async function closeTerminalTab(sessionId) {
  const t = terms[sessionId];
  if (!t) return;
  // Find the tab id for this session and close it; the daemon tear-
  // down will fire PaneTabRemoved → disposeTerminalBySession.
  const pane = state.panes[t.paneId];
  if (!pane) return;
  const tab = (pane.tabs || []).find(x => x.terminalSessionId === sessionId);
  if (!tab) return;
  try { await callUnary("CloseTab", { paneId: t.paneId, tabId: tab.tabId }); }
  catch (e) { console.debug("CloseTab:", e.message); }
}

function fitTerminalEntry(t) {
  if (!t || !t.fit) return;
  // Two rAFs: the first so the revealed host has laid out (fit reads
  // getBoundingClientRect and would see 0s too early); the second so
  // any resize triggered by fit has flushed before we repaint.
  requestAnimationFrame(() => {
    try { t.fit.fit(); } catch {}
    requestAnimationFrame(() => {
      // clearTextureAtlas forces the renderer to re-rasterize glyphs
      // from the buffer on next paint. Essential under the WebGL
      // addon: the atlas can retain stale pixels while the canvas
      // sits under visibility:hidden, and a plain refresh() won't
      // invalidate them — the visible "garbage on reveal" bug.
      try { t.term.clearTextureAtlas && t.term.clearTextureAtlas(); } catch {}
      try { t.term.refresh(0, t.term.rows - 1); } catch {}
      try { t.term.focus(); } catch {}
      // Force a PTY resize signal even when cols/rows are unchanged —
      // apps in the alt-screen buffer (htop, vim, less) redraw on
      // SIGWINCH, which is the most reliable way to recover from a
      // stale canvas without app-specific repaint keystrokes.
      if (t.sessionId && t.term && t.term.cols && t.term.rows) {
        debouncedResize(t, t.term.cols, t.term.rows);
      }
    });
  });
}

// Called when the daemon tells us a terminal tab went away (PTY
// exited, tab explicitly closed). O(1) on the sessionId map.
function disposeTerminalBySession(sessionId) {
  const t = terms[sessionId];
  if (!t) return;
  t.closed = true;
  try { t.ws && t.ws.close(); } catch {}
  try { t.term && t.term.dispose(); } catch {}
  if (t.wrap && t.wrap.parentNode) t.wrap.parentNode.removeChild(t.wrap);
  delete terms[sessionId];
  clearTimeout(_resizeTimers[sessionId]);
  delete _resizeTimers[sessionId];
}

// Re-fit every live terminal on window resize.
window.addEventListener("resize", () => {
  for (const sid in terms) fitTerminalEntry(terms[sid]);
});

async function reloadPane(paneId) {
  const tab = activeTab(paneId);
  if (!tab) { entries[paneId] = []; render(); return; }
  // Terminal tabs don't have a cwd to list — the xterm instance is
  // wired separately via syncTerminal. Skip straight to render().
  if (tab.kind === "TAB_KIND_TERMINAL") { entries[paneId] = []; render(); return; }
  // Search bar active + non-empty query → recursive walk on the daemon.
  // The filter bar and search bar are mutually exclusive (the daemon
  // enforces this), so we don't need to stack filter-text on top.
  if (tab.showSearchBar && (tab.searchQuery || "").length > 0) {
    try {
      const res = await callUnary("SearchEntries", {
        root:          tab.cwd,
        query:         tab.searchQuery,
        caseSensitive: !!tab.searchCaseSensitive,
        includeHidden: !!tab.showHiddenFiles,
        maxResults:    1000,
      });
      const list = (res.entries || []).map(e => {
        // __searchRelPath becomes the visible text in the Name column so
        // the user can see WHERE each hit came from (subdir/file.txt).
        // name stays untouched so cursor/selection and sort-by-name work
        // against the raw filename.
        const rel = relativeUnder(tab.cwd.path, e.path && e.path.path);
        return { ...e, __searchRelPath: rel };
      });
      entries[paneId] = list;
      sortEntries(paneId);
      render();
    } catch (e) {
      console.error("SearchEntries", e);
    }
    return;
  }
  try {
    const res = await callUnary("ListDir", { path: tab.cwd });
    let list = (res.entries || []).slice();
    if (!tab.showHiddenFiles) {
      list = list.filter(e => !e.name.startsWith("."));
    }
    if (tab.showFilterBar) {
      const q = (tab.filterText || "").toLowerCase();
      if (q) list = list.filter(e => e.name.toLowerCase().includes(q));
    }
    entries[paneId] = list;
    sortEntries(paneId);
    if (canAscend(tab.cwd.path)) {
      entries[paneId].unshift({ name: "..", isDir: true, size: "0", path: tab.cwd, __parent: true });
    }
    render();
  } catch (e) {
    console.error("ListDir", e);
  }
}

// --- path row nav buttons (back / forward / up) --------------------------
async function navBack(paneId) {
  const tab = activeTab(paneId);
  if (!tab) return;
  try { await callUnary("NavigateBack", { paneId, tabId: tab.tabId }); }
  catch (e) { console.debug("NavigateBack:", e.message); }
}
async function navForward(paneId) {
  const tab = activeTab(paneId);
  if (!tab) return;
  try { await callUnary("NavigateForward", { paneId, tabId: tab.tabId }); }
  catch (e) { console.debug("NavigateForward:", e.message); }
}

// attachHistoryLongPress wires pointer-down / pointer-up on a nav
// button so that holding for 400ms pops the pane's cwd history menu
// (back direction shows entries prior to current, forward shows the
// ones after). Picking an entry calls NavigateHistory which truncates
// the history to that level — no stale forward stack left over.
function attachHistoryLongPress(btn, paneId, direction) {
  const LONG_MS = 400;
  let timer = null;
  let longFired = false;
  btn.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return; // only the primary button
    longFired = false;
    timer = setTimeout(() => {
      longFired = true;
      timer = null;
      openHistoryMenu(btn, paneId, direction);
    }, LONG_MS);
  });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  btn.addEventListener("pointerup",    cancel);
  btn.addEventListener("pointerleave", cancel);
  btn.addEventListener("pointercancel", cancel);
  // Suppress the plain-click onclick if the long-press already fired.
  btn.addEventListener("click", (ev) => { if (longFired) { ev.preventDefault(); ev.stopImmediatePropagation(); longFired = false; } }, true);
  // Right-click on a nav button also opens the menu — a faster path
  // for desktop users who don't want to hold.
  btn.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openHistoryMenu(btn, paneId, direction);
  });
}

function openHistoryMenu(anchor, paneId, direction) {
  const tab = activeTab(paneId);
  if (!tab) return;
  const hist = tab.history || [];
  const idx  = tab.historyIndex || 0;
  // back-direction: [0..idx-1] reversed so most-recent-previous is at
  // the top. forward-direction: [idx+1..end] in chronological order.
  const items = [];
  if (direction === "back") {
    for (let i = idx - 1; i >= 0; i--) {
      items.push(historyMenuItem(paneId, tab.tabId, i, hist[i]));
    }
  } else {
    for (let i = idx + 1; i < hist.length; i++) {
      items.push(historyMenuItem(paneId, tab.tabId, i, hist[i]));
    }
  }
  if (items.length === 0) items.push({ label: "(no entries)", disabled: true, onClick: () => {} });
  const r = anchor.getBoundingClientRect();
  showCtxMenu(r.left, r.bottom, items);
}

function historyMenuItem(paneId, tabId, index, vpath) {
  const p = (vpath && vpath.path) || "";
  return {
    label: p || "(unknown)",
    iconId: "icon-folder",
    onClick: async () => {
      try { await callUnary("NavigateHistory", { paneId, tabId, index }); }
      catch (e) { showInfo(e.message); }
    },
  };
}

function syncNavButtons(paneId) {
  const tab = activeTab(paneId);
  const idx = tab && typeof tab.historyIndex === "number" ? tab.historyIndex : 0;
  const len = tab && tab.history ? tab.history.length : 0;
  const back = document.getElementById(`nav-back-${paneId}`);
  const fwd  = document.getElementById(`nav-forward-${paneId}`);
  const up   = document.getElementById(`nav-up-${paneId}`);
  // Use a class instead of the `disabled` attribute: disabled buttons
  // don't dispatch pointerdown/contextmenu, which breaks the long-
  // press history menu. The class handles the visual dim while click
  // handlers below gate navigation on the same flag.
  if (back) back.classList.toggle("nav-inactive", idx <= 0);
  if (fwd)  fwd.classList.toggle("nav-inactive", idx >= len - 1);
  if (up)   up.classList.toggle("nav-inactive",  !(tab && canAscend(tab.cwd?.path || "")));
}

for (const paneId of ["left", "right"]) {
  const backBtn = document.getElementById(`nav-back-${paneId}`);
  const fwdBtn  = document.getElementById(`nav-forward-${paneId}`);
  const upBtn   = document.getElementById(`nav-up-${paneId}`);
  const gateClick = (btn, fn) => { btn.onclick = () => { if (!btn.classList.contains("nav-inactive")) fn(); }; };
  gateClick(backBtn, () => navBack(paneId));
  gateClick(fwdBtn,  () => navForward(paneId));
  gateClick(upBtn,   () => ascend(paneId));
  attachHistoryLongPress(backBtn, paneId, "back");
  attachHistoryLongPress(fwdBtn,  paneId, "forward");
  document.getElementById(`nav-refresh-${paneId}`).onclick = () => reloadPane(paneId);
  // Right-click on the full-path header: quick actions for the cwd —
  // copy-to-clipboard or jump into an arbitrary path via prompt.
  const hdr = document.getElementById(`hdr-${paneId}`);
  if (hdr) hdr.oncontextmenu = (ev) => {
    ev.preventDefault();
    setActivePane(paneId);
    const tab = activeTab(paneId);
    const curPath = (tab && tab.cwd && tab.cwd.path) || "";
    const items = [
      {
        label: "copy",
        iconId: "icon-copy",
        disabled: !curPath,
        onClick: async () => {
          try { await navigator.clipboard.writeText(curPath); }
          catch (e) { showInfo("copy failed: " + e.message); }
        },
      },
      {
        label: "CD into…",
        iconId: "icon-folder",
        onClick: async () => {
          const t = activeTab(paneId);
          if (!t) return;
          const target = await promptName("CD into folder", (t.cwd && t.cwd.path) || "");
          if (!target) return;
          try {
            await callUnary("Navigate", { paneId, tabId: t.tabId, cwd: { scheme: "file", path: await expandUserPath(target) } });
            reloadPane(paneId);
          } catch (e) { showInfo(e.message); }
        },
      },
    ];
    showCtxMenu(ev.clientX, ev.clientY, items);
  };
}

// --- per-pane toolbar ------------------------------------------------------
function iconBtn(iconId, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tool";
  b.title = title;
  b.innerHTML = `<svg><use href="#${iconId}"/></svg>`;
  return b;
}

function syncPaneToolbar(paneId) {
  const tab = activeTab(paneId);
  const bar = document.getElementById(`toolbar-${paneId}`);
  if (!bar) return;
  const pasteable = !!(state.clipboard && state.clipboard.paths && state.clipboard.paths.length);
  const hiddenOn = !!(tab && tab.showHiddenFiles);
  const filterOn = !!(tab && tab.showFilterBar);
  const searchOn = !!(tab && tab.showSearchBar);

  const hidden = iconBtn(hiddenOn ? "icon-eye" : "icon-eye-off", "Hidden Files");
  hidden.classList.toggle("active", hiddenOn);
  hidden.onclick = async () => {
    if (!tab) return;
    try { await callUnary("SetTabShowHiddenFiles", { paneId, tabId: tab.tabId, value: !hiddenOn }); }
    catch (e) { console.debug(e.message); }
  };

  const filter = iconBtn("icon-funnel", "Filter Bar");
  filter.classList.toggle("active", filterOn);
  filter.onclick = async () => {
    if (!tab) return;
    try { await callUnary("SetTabShowFilterBar", { paneId, tabId: tab.tabId, value: !filterOn }); }
    catch (e) { console.debug(e.message); }
  };

  const search = iconBtn("icon-search", "Search Bar");
  search.classList.toggle("active", searchOn);
  search.onclick = async () => {
    if (!tab) return;
    try { await callUnary("SetTabShowSearchBar", { paneId, tabId: tab.tabId, value: !searchOn }); }
    catch (e) { console.debug(e.message); }
  };

  const home  = iconBtn("icon-home",       "Home");
  home.onclick = async () => {
    if (!tab) return;
    try {
      const res = await callUnary("GetUserHome", {});
      if (!res.home) return;
      await callUnary("Navigate", { paneId, tabId: tab.tabId, cwd: res.home });
      reloadPane(paneId);
    } catch (e) { showInfo(e.message); }
  };
  const info  = iconBtn("icon-info",       "Properties");
  info.onclick = () => showProperties(paneId);
  const mkdir = iconBtn("icon-folder-new", "Create folder");
  mkdir.onclick = async () => { setActivePane(paneId); await mkdirPrompt(paneId); };
  const mkfile = iconBtn("icon-file-new",  "Create file");
  mkfile.onclick = async () => { await mkfilePrompt(paneId); };
  const del   = iconBtn("icon-trash",      "Delete");
  del.onclick = async () => { setActivePane(paneId); fileOp("delete"); };
  const symlink = iconBtn("icon-link",     "Symbolic Link");
  symlink.onclick = async () => {
    const items = targetsFor(paneId);
    if (items.length === 0) return;
    for (const e of items) {
      try { await callUnary("CreateSymlink", { target: e.path }); }
      catch (err) { showInfo(err.message); return; }
    }
    reloadPane(paneId);
  };
  const dup   = iconBtn("icon-clone",  "Clone");
  dup.onclick = () => doDuplicate(paneId);
  const cut   = iconBtn("icon-cut",        "Cut");
  cut.onclick = () => doClipboard(paneId, "MODE_CUT");
  const copy  = iconBtn("icon-copy",       "Copy");
  copy.onclick = () => doClipboard(paneId, "MODE_COPY");
  const paste = iconBtn("icon-paste",      "Paste");
  if (!pasteable) paste.disabled = true;
  paste.onclick = () => doPaste(paneId);

  const sep = () => { const s = document.createElement("span"); s.className = "sep"; return s; };
  const spacer = () => { const s = document.createElement("span"); s.className = "spacer"; return s; };

  const term = iconBtn("icon-terminal", "Open in Terminal");
  term.onclick = async () => {
    if (!tab) return;
    try { await callUnary("LaunchTerminal", { cwd: tab.cwd }); }
    catch (e) { showInfo(e.message); }
  };

  bar.replaceChildren(
    home, info,
    sep(), mkdir, mkfile,
    sep(), del, dup, symlink,
    sep(), cut, copy, paste,
    spacer(),
    filter, hidden, search, term,
  );
}

function syncFilterRow(paneId) {
  const tab = activeTab(paneId);
  const fInput = document.getElementById(`filter-${paneId}`);
  if (fInput) {
    fInput.hidden = !(tab && tab.showFilterBar);
    const desired = (tab && tab.filterText) || "";
    if (fInput.value !== desired) fInput.value = desired;
  }
  const sRow = document.getElementById(`search-row-${paneId}`);
  const sInput = document.getElementById(`search-${paneId}`);
  const sCase  = document.getElementById(`search-case-${paneId}`);
  if (sRow)   sRow.hidden = !(tab && tab.showSearchBar);
  if (sInput) {
    // Committed query is authoritative, but we mustn't overwrite a query
    // the user is actively typing (Enter hasn't been pressed yet).
    const desired = (tab && tab.searchQuery) || "";
    if (sInput.value !== desired && document.activeElement !== sInput) {
      sInput.value = desired;
    }
  }
  if (sCase) sCase.classList.toggle("active", !!(tab && tab.searchCaseSensitive));
}

// --- toolbar action helpers ----------------------------------------------
async function mkdirPrompt(paneId) {
  const tab = activeTab(paneId);
  if (!tab) return;
  const name = await promptName("New folder name");
  if (!name) return;
  try {
    await callUnary("Mkdir", { parent: tab.cwd, name });
    await reloadPane(paneId);
    setCursor(paneId, name);
  } catch (e) { showInfo(e.message); }
}

async function mkfilePrompt(paneId) {
  const tab = activeTab(paneId);
  if (!tab) return;
  const name = await promptName("New file name");
  if (!name) return;
  try {
    await callUnary("CreateFile", { parent: tab.cwd, name });
    await reloadPane(paneId);
    setCursor(paneId, name);
  } catch (e) { showInfo(e.message); }
}

function targetsFor(paneId) {
  const { list: selNames } = currentSelection(paneId);
  const byName = new Map(entries[paneId].filter(e => !e.__parent).map(e => [e.name, e]));
  if (selNames.length > 0) {
    return selNames.map(n => byName.get(n)).filter(Boolean);
  }
  const cur = entries[paneId][cursorIndex(paneId)];
  if (!cur || cur.__parent) return [];
  return [cur];
}

async function doDuplicate(paneId) {
  const items = targetsFor(paneId);
  if (!items.length) return;
  for (const e of items) {
    try { await callUnary("DuplicateEntry", { path: e.path }); }
    catch (err) { showInfo(err.message); }
  }
}

async function doClipboard(paneId, mode) {
  const items = targetsFor(paneId);
  if (!items.length) return;
  try {
    await callUnary("SetClipboard", {
      clipboard: { mode, paths: items.map(e => e.path) },
    });
  } catch (e) { showInfo(e.message); }
}

async function doPaste(paneId) {
  const tab = activeTab(paneId);
  if (!tab) return;
  try {
    await callUnary("PasteClipboard", { destPaneId: paneId, destTabId: tab.tabId });
  } catch (e) { showInfo(e.message); }
}

// --- in-app info / confirm dialogs ---------------------------------------
const infoDialog = document.getElementById("info-dialog");
const infoBody   = document.getElementById("info-body");
document.getElementById("info-close").onclick = () => infoDialog.close();

// Every dialog wired with the shared .dlg-header chrome gets a close-X
// in its header. Rather than binding a click listener per dialog, a
// single delegated handler finds the enclosing <dialog> and dismisses
// it — same effect as pressing Esc.
document.addEventListener("click", (ev) => {
  const x = ev.target.closest(".dlg-x");
  if (!x) return;
  const dlg = x.closest("dialog");
  if (dlg) dlg.close();
});

function showInfo(message) {
  infoBody.textContent = message;
  infoDialog.showModal();
}

// promptDropOp asks the user how to handle a drop onto a pane list. Resolves
// to one of "copy", "move", "queue-copy", "queue-move", or null (cancel).
// queue-* variants call EnqueueCopy / EnqueueMove so the op sits in the
// shared ops queue (viewable via F9) until the user starts it.
const dropOpDialog     = document.getElementById("drop-op-dialog");
const dropOpBody       = document.getElementById("drop-op-body");
const dropOpCopy       = document.getElementById("drop-op-copy");
const dropOpMove       = document.getElementById("drop-op-move");
const dropOpQueueCopy  = document.getElementById("drop-op-queue-copy");
const dropOpQueueMove  = document.getElementById("drop-op-queue-move");
const dropOpCancel     = document.getElementById("drop-op-cancel");
function promptDropOp(message) {
  return new Promise((resolve) => {
    dropOpBody.textContent = message;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      dropOpCopy.removeEventListener("click", onCopy);
      dropOpMove.removeEventListener("click", onMove);
      dropOpQueueCopy.removeEventListener("click", onQC);
      dropOpQueueMove.removeEventListener("click", onQM);
      dropOpCancel.removeEventListener("click", onCancel);
      dropOpDialog.removeEventListener("cancel", onCancel);
      dropOpDialog.close();
      resolve(v);
    };
    const onCopy   = () => finish("copy");
    const onMove   = () => finish("move");
    const onQC     = () => finish("queue-copy");
    const onQM     = () => finish("queue-move");
    const onCancel = (ev) => { if (ev) ev.preventDefault(); finish(null); };
    dropOpCopy.addEventListener("click", onCopy);
    dropOpMove.addEventListener("click", onMove);
    dropOpQueueCopy.addEventListener("click", onQC);
    dropOpQueueMove.addEventListener("click", onQM);
    dropOpCancel.addEventListener("click", onCancel);
    dropOpDialog.addEventListener("cancel", onCancel);
    dropOpDialog.showModal();
    setTimeout(() => dropOpCopy.focus(), 0);
  });
}

// promptOpConfirm is the F5/F6 copy/move prompt. Three outcomes: "do"
// (primary button — StartCopy/StartMove), "queue" (EnqueueCopy/
// EnqueueMove), or null (cancel). Verb ("copy"/"move") drives both the
// title text and the primary button label.
const opConfirmDialog = document.getElementById("op-confirm-dialog");
const opConfirmBody   = document.getElementById("op-confirm-body");
const opConfirmDo     = document.getElementById("op-confirm-do");
const opConfirmQueue  = document.getElementById("op-confirm-queue");
const opConfirmCancel = document.getElementById("op-confirm-cancel");
function promptOpConfirm(verb, label, destPath) {
  return new Promise((resolve) => {
    const verbCap = verb.charAt(0).toUpperCase() + verb.slice(1);
    opConfirmBody.textContent = destPath
      ? `${verbCap} ${label} to ${destPath}?`
      : `${verbCap} ${label}?`;
    opConfirmDo.textContent    = verbCap;          // "Copy" / "Move"
    opConfirmQueue.textContent = verbCap + " Q";   // "Copy Q" / "Move Q"
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      opConfirmDo.removeEventListener("click", onDo);
      opConfirmQueue.removeEventListener("click", onQueue);
      opConfirmCancel.removeEventListener("click", onCancel);
      opConfirmDialog.removeEventListener("cancel", onCancel);
      opConfirmDialog.close();
      resolve(v);
    };
    const onDo     = () => finish("do");
    const onQueue  = () => finish("queue");
    const onCancel = (ev) => { if (ev) ev.preventDefault(); finish(null); };
    opConfirmDo.addEventListener("click", onDo);
    opConfirmQueue.addEventListener("click", onQueue);
    opConfirmCancel.addEventListener("click", onCancel);
    opConfirmDialog.addEventListener("cancel", onCancel);
    opConfirmDialog.showModal();
    setTimeout(() => opConfirmDo.focus(), 0);
  });
}

const confirmDialog = document.getElementById("confirm-dialog");
const confirmBody   = document.getElementById("confirm-body");
const confirmOk     = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");

function showConfirm(message) {
  return new Promise((resolve) => {
    confirmBody.textContent = message;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
      confirmDialog.removeEventListener("cancel", onCancel);
      confirmDialog.close();
      resolve(v);
    };
    const onOk     = () => finish(true);
    const onCancel = (ev) => { if (ev) ev.preventDefault(); finish(false); };
    confirmOk.addEventListener("click", onOk);
    confirmCancel.addEventListener("click", onCancel);
    confirmDialog.addEventListener("cancel", onCancel);
    confirmDialog.showModal();
    setTimeout(() => confirmOk.focus(), 0);
  });
}

// --- in-app name prompt dialog -------------------------------------------
const inputDialog = document.getElementById("input-dialog");
const inputForm   = document.getElementById("input-form");
const inputTitle  = document.getElementById("input-title");
const inputField  = document.getElementById("input-field");
const inputCancel = document.getElementById("input-cancel");

// promptName opens a modal text input. Resolves to the trimmed value or null.
function promptName(title, initial = "") {
  return new Promise((resolve) => {
    inputTitle.textContent = title;
    inputField.value = initial;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      inputForm.removeEventListener("submit", onSubmit);
      inputCancel.removeEventListener("click", onCancel);
      inputDialog.removeEventListener("cancel", onCancel);
      inputDialog.close();
      resolve(v);
    };
    const onSubmit = (ev) => {
      ev.preventDefault();
      finish(inputField.value.trim() || null);
    };
    const onCancel = (ev) => {
      if (ev) ev.preventDefault();
      finish(null);
    };
    inputForm.addEventListener("submit", onSubmit);
    inputCancel.addEventListener("click", onCancel);
    inputDialog.addEventListener("cancel", onCancel);
    inputDialog.showModal();
    setTimeout(() => { inputField.focus(); inputField.select(); }, 0);
  });
}

const propsDialog = document.getElementById("props-dialog");
const propsBody   = document.getElementById("props-body");
document.getElementById("props-close").onclick = () => propsDialog.close();

function renderPropsBody(items, sizeMap) {
  return items.map(e => {
    const kind = e.isDir ? "Directory" : "File";
    const sizeLine = e.isDir
      ? (sizeMap.get(e.path?.path) || "computing…")
      : formatSize(e);
    const created = formatCtime(e);
    return `Name:     ${e.name}
Path:     ${e.path?.path || ""}
Kind:     ${kind}
Size:     ${sizeLine}
Created:  ${created || "—"}
Modified: ${formatMtime(e)}
Mode:     ${(e.mode || 0).toString(8)}`;
  }).join("\n\n——\n\n");
}

function showProperties(paneId) {
  let items = targetsFor(paneId);
  if (items.length === 0) {
    const tab = activeTab(paneId);
    if (!tab) return;
    items = [{ name: tab.cwd.path.split("/").filter(Boolean).pop() || "/", path: tab.cwd, isDir: true }];
  }
  const sizeMap = new Map();
  const update = () => { propsBody.textContent = renderPropsBody(items, sizeMap); };
  update();
  propsDialog.showModal();
  // Fire ComputeSize for every directory entry and update when each returns.
  for (const e of items) {
    if (!e.isDir) continue;
    (async () => {
      try {
        const res = await callUnary("ComputeSize", { path: e.path });
        const b = parseInt(res.bytes || "0", 10);
        const f = parseInt(res.files || "0", 10);
        const d = parseInt(res.dirs  || "0", 10);
        sizeMap.set(e.path?.path, `${humanSize(b)}  (${f} file(s), ${d} dir(s))`);
      } catch (err) {
        sizeMap.set(e.path?.path, `(error: ${err.message})`);
      }
      if (propsDialog.open) update();
    })();
  }
}

for (const paneId of ["left", "right"]) {
  const fInput = document.getElementById(`filter-${paneId}`);
  fInput.oninput = async () => {
    const tab = activeTab(paneId);
    if (!tab) return;
    try { await callUnary("SetTabFilter", { paneId, tabId: tab.tabId, filterText: fInput.value }); }
    catch (e) { console.debug("SetTabFilter:", e.message); }
  };
  // Search input only applies on Enter or when the Go button is clicked —
  // typing doesn't thrash the daemon with a recursive walk per keystroke.
  const sInput = document.getElementById(`search-${paneId}`);
  const applySearch = async () => {
    const tab = activeTab(paneId);
    if (!tab) return;
    try { await callUnary("SetTabSearch", { paneId, tabId: tab.tabId, searchQuery: sInput.value }); }
    catch (e) { console.debug("SetTabSearch:", e.message); }
  };
  sInput.onkeydown = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); applySearch(); }
    else if (ev.key === "Escape") { ev.preventDefault(); sInput.blur(); }
  };
  const sGo = document.getElementById(`search-go-${paneId}`);
  if (sGo) sGo.onclick = applySearch;
  const sCase = document.getElementById(`search-case-${paneId}`);
  if (sCase) sCase.onclick = async () => {
    const tab = activeTab(paneId);
    if (!tab) return;
    const next = !tab.searchCaseSensitive;
    try { await callUnary("SetTabSearchCaseSensitive", { paneId, tabId: tab.tabId, caseSensitive: next }); }
    catch (e) { console.debug("SetTabSearchCaseSensitive:", e.message); }
  };
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  queueMicrotask(() => { renderScheduled = false; render(); });
}

// Incremental DOM updaters for cursor / selection / active-pane
// changes — flip classes on the affected rows instead of calling
// render() (which replaceChildren()'s the whole list). On a folder
// with ~2k entries the full rebuild was burning ~7k DOM creations
// per cursor move; these helpers are O(1) or O(N) classList flips.

function renderCursorOnly(paneId) {
  const listEl = document.getElementById(`list-${paneId}`);
  if (!listEl) return;
  const tab = activeTab(paneId);
  const cursorName = (tab && tab.cursorName) || "";
  const prev = listEl.querySelector(".row.cursor");
  if (prev) prev.classList.remove("cursor");
  if (!cursorName) return;
  const next = listEl.querySelector(`.row[data-name="${CSS.escape(cursorName)}"]`);
  if (next) {
    next.classList.add("cursor");
    next.scrollIntoView({ block: "nearest" });
  }
}

function renderSelectionOnly(paneId) {
  const listEl = document.getElementById(`list-${paneId}`);
  if (!listEl) return;
  const tab = activeTab(paneId);
  const selected = new Set((tab && tab.selectedNames) || []);
  for (const row of listEl.querySelectorAll(".row")) {
    row.classList.toggle("multi-selected", selected.has(row.dataset.name));
  }
}

// updateTabsOverflowBtn hides the ▤ "all tabs" button on a pane when
// every tab fits in the strip (no horizontal overflow). Compares
// scrollWidth vs clientWidth — a 1px slack absorbs sub-pixel rounding
// from xforms / fractional layout.
function updateTabsOverflowBtn(paneId) {
  const strip = document.getElementById(`tabs-${paneId}`);
  const btn   = document.getElementById(`tabs-overflow-${paneId}`);
  if (!strip || !btn) return;
  btn.hidden = strip.scrollWidth - strip.clientWidth <= 1;
}

// Re-check overflow visibility on pane resize too — chrome below the
// tab-row can grow / shrink (filter / search inputs toggle), and the
// pane itself resizes when the user drags between panes.
for (const paneId of ["left", "right"]) {
  const strip = document.getElementById(`tabs-${paneId}`);
  if (!strip || !window.ResizeObserver) continue;
  new ResizeObserver(() => updateTabsOverflowBtn(paneId)).observe(strip);
}

function renderActivePaneOnly() {
  for (const paneId of ["left", "right"]) {
    const pane = document.querySelector(`.pane[data-pane="${paneId}"]`);
    if (pane) pane.classList.toggle("active", activePane === paneId);
  }
}

function render() {
  for (const paneId of ["left", "right"]) {
    const pane = document.querySelector(`.pane[data-pane="${paneId}"]`);
    pane.classList.toggle("active", activePane === paneId);

    const tab = activeTab(paneId);
    const isTerm = !!(tab && tab.kind === "TAB_KIND_TERMINAL");
    // Toggle terminal host vs. file-list view: when the active tab is
    // a terminal, the pane shows the xterm host and hides list/cols;
    // otherwise the usual file-list chrome.
    const termHost  = document.getElementById(`term-${paneId}`);
    const pathRow   = document.getElementById(`path-row-${paneId}`);
    const toolbar   = document.getElementById(`toolbar-${paneId}`);
    // term-host uses an `active` class (not the hidden attribute) so
    // display:none never touches it — xterm's renderer stays consistent
    // across tab switches. The overlay sits above the file chrome and
    // is only pointer-events: auto when active.
    if (termHost) termHost.classList.toggle("active", isTerm);
    // Terminal tabs: hide the path-row (nav buttons + cwd header) and
    // the pane-toolbar (file ops) — none of it applies to a shell.
    // Filter / search inputs also hide for the same reason. Chrome
    // returns when the active tab is a file tab again.
    if (pathRow) pathRow.hidden = isTerm;
    if (toolbar) toolbar.hidden = isTerm;
    if (isTerm) {
      const f = document.getElementById(`filter-${paneId}`);
      const s = document.getElementById(`search-row-${paneId}`);
      if (f) f.hidden = true;
      if (s) s.hidden = true;
    }
    // Activate / deactivate the xterm instance bound to this pane.
    syncTerminal(paneId, isTerm ? tab : null);
    // Header line: show cwd for file tabs, the terminal title otherwise.
    const hdr = document.getElementById(`hdr-${paneId}`);
    if (isTerm)        hdr.textContent = tab.title || "terminal";
    else if (tab)      hdr.textContent = (tab.cwd && tab.cwd.path) || "—";
    else               hdr.textContent = "—";
    hdr.scrollLeft = hdr.scrollWidth;

    const tabsEl = document.getElementById(`tabs-${paneId}`);
    const tabs = state.panes[paneId]?.tabs || [];
    let activeTabEl = null;
    tabsEl.replaceChildren(...tabs.map(t => {
      const d = document.createElement("div");
      const isActive = t.tabId === state.panes[paneId].activeTabId;
      d.className = "tab" +
        (isActive ? " active" : "") +
        (t.pinned ? " pinned" : "");
      if (isActive) activeTabEl = d;
      // Pinned indicator FIRST — leftmost element so a cluster of
      // pinned tabs reads as a visually coherent group. Shown only when
      // the tab is pinned; not interactive (toggling via context menu).
      // 📌 emoji keeps its system color for the familiar yellow pin.
      if (t.pinned) {
        const pinInd = document.createElement("span");
        pinInd.className = "pin-ind";
        pinInd.title = "Pinned";
        pinInd.textContent = "📌";
        d.appendChild(pinInd);
      }

      // Site/folder icon — terminal tabs use the terminal glyph;
      // otherwise sftp when the cwd sits inside an sshfs mount,
      // folder for plain local paths.
      const tabIcon = document.createElement("span");
      tabIcon.className = "tab-icon";
      let iconId;
      if (t.kind === "TAB_KIND_TERMINAL")    iconId = "icon-terminal";
      else if (isSftpTabCwd(t.cwd))          iconId = "icon-sftp";
      else                                   iconId = "icon-folder";
      tabIcon.innerHTML = `<svg class="glyph"><use href="#${iconId}"/></svg>`;
      d.appendChild(tabIcon);

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = t.title || (t.cwd && t.cwd.path) || "(tab)";
      d.appendChild(label);
      // Activity dot: terminal tab with pending output that the user
      // hasn't seen yet (background tab in its pane).
      const entry = t.kind === "TAB_KIND_TERMINAL" ? terms[t.terminalSessionId] : null;
      const isActiveTab = t.tabId === state.panes[paneId].activeTabId;
      if (entry && entry.activity > 0 && !isActiveTab) {
        const dot = document.createElement("span");
        dot.className = "tab-unread";
        dot.title = "Output available";
        d.appendChild(dot);
      }
      // Clicking a tab always takes its pane as the active pane.
      // Without this, the keymap routes keys based on the previous
      // activePane's tab kind (file vs terminal), so a terminal tab
      // clicked on an inactive pane can't receive keystrokes until
      // focus is shuffled with Tab.
      d.onclick = () => { setActivePane(paneId); setActiveTab(paneId, t.tabId); };
      d.oncontextmenu = (ev) => {
        ev.preventDefault();
        showTabMenu(paneId, t, ev.clientX, ev.clientY);
      };
      // Close — not rendered for pinned tabs (unpin first). Hidden at
      // rest, revealed on tab hover.
      if (!t.pinned) {
        const x = document.createElement("span");
        x.className = "close";
        x.innerHTML = `<svg class="glyph"><use href="#icon-close"/></svg>`;
        x.title = "Close tab";
        x.onclick = async (ev) => {
          ev.stopPropagation();
          try { await callUnary("CloseTab", { paneId, tabId: t.tabId }); }
          catch (err) { console.debug("CloseTab:", err.message); }
        };
        d.appendChild(x);
      }
      return d;
    }));
    // Bring the active tab into view if it's currently outside the
    // scroll viewport (e.g. just opened past the right edge or
    // switched-to via the overflow menu / Ctrl+Tab). inline:
    // "nearest" only scrolls the strip when needed — no jump when
    // the tab is already visible.
    if (activeTabEl) activeTabEl.scrollIntoView({ inline: "nearest", block: "nearest" });
    // Hide the "all tabs" overflow button when every tab fits in the
    // strip (no horizontal overflow). Re-evaluated on every render
    // and on resize via the ResizeObserver below.
    updateTabsOverflowBtn(paneId);

    const listEl = document.getElementById(`list-${paneId}`);
    const cursorIdx = cursorIndex(paneId);
    const { set: selSet } = currentSelection(paneId);
    let cursorEl = null;
    listEl.replaceChildren(...entries[paneId].map((e, i) => {
      const row = document.createElement("div");
      const isCursor = i === cursorIdx;
      const isSelected = selSet.has(e.name);
      row.className = "row" + (e.isDir ? " dir" : "") + (isCursor ? " cursor" : "") + (isSelected ? " multi-selected" : "");
      // data-name lets the cheap cursor/selection updaters find the
      // affected row via querySelector instead of rebuilding the
      // whole list on every cursor move (pane with ~2k rows was
      // spending 7k+ DOM creations per keystroke otherwise).
      row.dataset.name = e.name;
      row.style.gridTemplateColumns = gridTemplate();
      for (const c of COLUMNS) {
        const cell = document.createElement("div");
        cell.className = "cell " + c.id + " align-" + c.align;
        switch (c.id) {
          case "icon":  cell.innerHTML = `<svg class="glyph"><use href="#${e.isDir ? "icon-folder" : "icon-file"}"/></svg>`; break;
          case "name":
            // In search mode the name cell shows the relative path under
            // tab.cwd so hits from different subdirs are distinguishable.
            if (e.__searchRelPath) {
              cell.classList.add("search-relpath");
              cell.textContent = e.__searchRelPath;
              cell.title = e.__searchRelPath;
            } else {
              cell.textContent = e.name;
            }
            break;
          case "size":  cell.textContent = formatSize(e); break;
          case "mtime": cell.textContent = formatMtime(e); break;
        }
        row.appendChild(cell);
      }
      row.onclick = (ev) => {
        setActivePane(paneId);
        if (e.__parent) {
          setCursor(paneId, e.name);
          return;
        }
        if (ev.ctrlKey || ev.metaKey) {
          toggleSelection(paneId, e.name);
          shiftAnchor[paneId] = e.name;
        } else if (ev.shiftKey) {
          extendSelection(paneId, e.name);
        } else {
          setSelection(paneId, []);
          shiftAnchor[paneId] = e.name;
        }
        setCursor(paneId, e.name);
      };
      row.ondblclick = () => {
        setActivePane(paneId);
        setCursor(paneId, e.name);
        descend(paneId, e);
      };
      row.oncontextmenu = (ev) => {
        if (e.__parent) return;
        ev.preventDefault();
        setActivePane(paneId);
        setCursor(paneId, e.name);
        showRowMenu(paneId, e, ev.clientX, ev.clientY);
      };
      if (!e.__parent) {
        row.draggable = true;
        row.addEventListener("dragstart", (ev) => {
          // If the row is part of the current selection, drag everything that's
          // selected. Otherwise drag just the dragged row.
          const { set: selSet2 } = currentSelection(paneId);
          const paths = selSet2.has(e.name)
            ? entries[paneId].filter(x => !x.__parent && selSet2.has(x.name)).map(x => x.path)
            : [e.path];
          ev.dataTransfer.setData("application/x-commander-paths", JSON.stringify(paths));
          ev.dataTransfer.setData("application/x-commander-source", "list");
          ev.dataTransfer.effectAllowed = "copyMove";
        });
      }
      if (isCursor) cursorEl = row;
      return row;
    }));
    if (cursorEl) cursorEl.scrollIntoView({ block: "nearest" });
  }

  const activeOps = Object.values(state.ops).filter(o =>
    o.phase === "OP_PHASE_RUNNING" || o.phase === "OP_PHASE_WAITING_PROMPT");
  const opsEl = document.getElementById("ops-progress");
  if (activeOps.length > 0) {
    const op = activeOps[0];
    const p = op.progress || {};
    const done = parseInt(p.bytesDone || "0", 10);
    const total = parseInt(p.bytesTotal || "0", 10);
    const pct = total ? Math.round(100 * done / total) : 0;
    const text = ` ${humanSize(done)}/${humanSize(total)} (${pct}%) files ${p.filesDone || 0}/${p.filesTotal || 0}`;
    opsEl.innerHTML = `<svg class="glyph"><use href="#${opKindIconId(op.kind)}"/></svg>${text}`;
  } else {
    opsEl.textContent = "";
  }
}

// Last daemon address received from /api/daemon. Updated on boot and after a
// successful retarget; consulted by the status-dot tooltip + the click-to-
// reconnect dialog.
let currentDaemonAddr = "";

async function fetchDaemonAddr() {
  try {
    const r = await fetch("/api/daemon");
    if (!r.ok) return "";
    const j = await r.json();
    currentDaemonAddr = j.addr || "";
    return currentDaemonAddr;
  } catch { return ""; }
}

async function setDaemonAddr(addr) {
  const r = await fetch("/api/daemon", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addr }),
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  currentDaemonAddr = j.addr || addr;
  return currentDaemonAddr;
}

function setConnectionStatus(state, message) {
  const dot = document.getElementById("status-dot");
  if (!dot) return;
  dot.dataset.state = state;
  dot.title = message;
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ["K", "M", "G", "T"];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(1)} ${units[u]}B`;
}

// --- actions --------------------------------------------------------------
async function setActiveTab(paneId, tabId) {
  const tab = state.panes[paneId].tabs.find(t => t.tabId === tabId);
  if (!tab) return;
  await callUnary("Navigate", { paneId, tabId, cwd: tab.cwd });
  reloadPane(paneId);
}

async function descend(paneId, entry) {
  // Prefer an explicit entry (double-click passes the clicked row) —
  // setCursor is async, so relying on cursorIndex after a click
  // races with the mutation round-trip and picks up the previous
  // cursor on the first double-click.
  const e = entry || entries[paneId][cursorIndex(paneId)];
  if (!e) return;
  if (e.__parent) { await ascend(paneId); return; }
  const tab = activeTab(paneId);
  if (!tab) return;
  // In search mode, double-clicking always CDs: into the dir itself for
  // directory hits, into the file's parent for file hits. That way the
  // search list behaves like a jump-to-folder tool instead of a dead-end.
  const inSearch = !!e.__searchRelPath;
  let target;
  if (e.isDir) {
    target = (e.path && e.path.path)
      ? { scheme: e.path.scheme || "file", path: e.path.path }
      : { scheme: "file", path: joinPath(tab.cwd.path, e.name) };
  } else if (inSearch && e.path && e.path.path) {
    const parent = e.path.path.replace(/\/+[^\/]*$/, "") || "/";
    target = { scheme: e.path.scheme || "file", path: parent };
  } else {
    // Plain-listing file double-click. Opt-in behavior: only fires
    // OpenFile when the user has enabled "double-click opens file"
    // in the Settings dialog. Default-off so a stray double-click
    // doesn't launch random applications.
    const optIn = (state.settings && state.settings["settings/double_click_opens_file"]) === "true";
    if (optIn && e.path && e.path.path) {
      try { await callUnary("OpenFile", { path: e.path }); }
      catch (err) { showInfo(err.message); }
    }
    return;
  }
  await callUnary("Navigate", { paneId, tabId: tab.tabId, cwd: target });
  reloadPane(paneId);
}

async function ascend(paneId) {
  const tab = activeTab(paneId);
  if (!tab) return;
  const cur = tab.cwd.path;
  const parent = cur.replace(/\/+[^\/]*$/, "") || "/";
  if (parent === cur) return;
  // Remember the child we're leaving so the parent listing cursors on it,
  // matching Total Commander / Dolphin "go up" behavior.
  const leaving = basename(cur);
  await callUnary("Navigate", { paneId, tabId: tab.tabId, cwd: { scheme: "file", path: parent } });
  if (leaving && leaving !== "/" && leaving !== ".") {
    try { await callUnary("SetTabCursor", { paneId, tabId: tab.tabId, cursorName: leaving }); }
    catch (e) { console.debug("SetTabCursor:", e.message); }
  }
  reloadPane(paneId);
}

function joinPath(a, b) {
  if (a.endsWith("/")) return a + b;
  return a + "/" + b;
}

async function fileOp(kind) {
  const { list: selNames } = currentSelection(activePane);
  const byName = new Map(entries[activePane].filter(e => !e.__parent).map(e => [e.name, e]));
  let targets;
  if (selNames.length > 0) {
    targets = selNames.map(n => byName.get(n)).filter(Boolean);
  } else {
    const cur = entries[activePane][cursorIndex(activePane)];
    if (!cur || cur.__parent) return;
    targets = [cur];
  }
  if (targets.length === 0) return;
  const other = activePane === "left" ? "right" : "left";
  const dest = activeTab(other)?.cwd;
  if (!dest && kind !== "delete") return;
  const label = targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} items`;
  const paths = targets.map(t => t.path);
  const action = await promptOpConfirm(kind, label, (kind !== "delete" && dest) ? dest.path : "");
  if (!action) return;
  try {
    if (kind === "copy") {
      if (action === "queue") await callUnary("EnqueueCopy", { sources: paths, dest });
      else                    await callUnary("StartCopy",   { sources: paths, dest });
    } else if (kind === "move") {
      if (action === "queue") await callUnary("EnqueueMove", { sources: paths, dest });
      else                    await callUnary("StartMove",   { sources: paths, dest });
    } else if (kind === "delete") {
      if (action === "queue") await callUnary("EnqueueDelete", { targets: paths });
      else                    await callUnary("StartDelete",   { targets: paths });
    }
  } catch (err) {
    showInfo(err.message);
  }
  reloadPane(activePane);
  reloadPane(other);
}

async function renameSel() {
  const e = entries[activePane][cursorIndex(activePane)];
  if (!e || e.__parent) return;
  const name = await promptName(`Rename "${e.name}"`, e.name);
  if (!name || name === e.name) return;
  try {
    await callUnary("RenameEntry", { from: e.path, newName: name });
    reloadPane(activePane);
  } catch (err) { showInfo(err.message); }
}

async function newTab(paneId) {
  paneId = paneId || activePane;
  const cwd = activeTab(paneId)?.cwd || { scheme: "file", path: "/" };
  try {
    await callUnary("OpenTab", { paneId, cwd });
  } catch (err) { showInfo(err.message); }
}

async function closeTabById(paneId, tabId) {
  try { await callUnary("CloseTab", { paneId, tabId }); }
  catch (err) { console.debug("CloseTab:", err.message); }
}
async function closeTab() {
  const tab = activeTab(activePane);
  if (!tab) return;
  try {
    await callUnary("CloseTab", { paneId: activePane, tabId: tab.tabId });
  } catch (err) {
    // Daemon rejects closing the last tab with FailedPrecondition — silent
    // no-op is fine for MVP.
    console.debug("CloseTab:", err.message);
  }
}

// --- stash area -----------------------------------------------------------
const stashChips = document.getElementById("stash-chips");

function renderStash() {
  const items = state.stash || [];
  if (items.length === 0) {
    stashChips.replaceChildren(Object.assign(document.createElement("span"), {
      className: "empty", textContent: "drop files/folders here…",
    }));
    return;
  }
  stashChips.replaceChildren(...items.map(it => {
    const p = it.path;
    const chip = document.createElement("span");
    chip.className = "chip" + (it.isDir ? " dir" : "");
    chip.draggable = true;
    chip.title = p.path;
    const iconId = it.isDir ? "icon-folder" : "icon-file";
    const iconSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    iconSvg.setAttribute("class", "glyph");
    const useEl = document.createElementNS("http://www.w3.org/2000/svg", "use");
    useEl.setAttribute("href", `#${iconId}`);
    iconSvg.appendChild(useEl);
    chip.appendChild(iconSvg);
    const nameSpan = document.createElement("span");
    nameSpan.textContent = basename(p.path);
    chip.appendChild(nameSpan);
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "Remove from stash";
    x.onclick = async (ev) => {
      ev.stopPropagation();
      try { await callUnary("RemoveFromStash", { paths: [p] }); }
      catch (e) { console.debug("RemoveFromStash:", e.message); }
    };
    chip.appendChild(x);
    chip.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("application/x-commander-paths", JSON.stringify([p]));
      ev.dataTransfer.setData("application/x-commander-source", "stash");
      ev.dataTransfer.effectAllowed = "copyMove";
    });
    return chip;
  }));
}

function basename(path) {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

// isSftpTabCwd reports whether a tab's cwd lives inside the daemon's
// sshfs mount dir. Those are plain file:// paths at the VFS layer (we
// shell out to sshfs, which produces a local mountpoint) — the only
// way to distinguish them from a regular folder is the path shape.
// Keep the substring in sync with the mount path the daemon picks
// (internal/daemon/server/ssh_config.go: ~/.cache/commander/sshfs/...).
function isSftpTabCwd(cwd) {
  if (!cwd || !cwd.path) return false;
  return cwd.path.includes("/.cache/commander/sshfs/");
}

function parentDir(path) {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return "";
  return idx === 0 ? "/" : trimmed.slice(0, idx);
}

// Stash area as drop target: accept rows dropped in, issue AddToStash.
// Rows dragged out of the stash are accepted by pane .list drop targets below.
stashChips.addEventListener("dragover", (ev) => {
  if (!ev.dataTransfer.types.includes("application/x-commander-paths")) return;
  const src = (ev.dataTransfer.getData("application/x-commander-source") || "").toLowerCase();
  if (src === "stash") return; // chips don't drop back onto themselves
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
  stashChips.classList.add("drop-hover");
});
stashChips.addEventListener("dragleave", () => stashChips.classList.remove("drop-hover"));
stashChips.addEventListener("drop", async (ev) => {
  stashChips.classList.remove("drop-hover");
  const raw = ev.dataTransfer.getData("application/x-commander-paths");
  const src = (ev.dataTransfer.getData("application/x-commander-source") || "").toLowerCase();
  if (!raw || src === "stash") return;
  ev.preventDefault();
  try {
    const paths = JSON.parse(raw);
    await callUnary("AddToStash", { paths });
  } catch (e) { console.debug("AddToStash:", e.message); }
});

// Pane lists as drop targets: a drop into pane X's list issues a StartCopy
// (or StartMove if the Shift key is held at drop time) of the dragged paths
// into pane X's active tab cwd. Same-pane drops onto their own pane are a
// no-op (dest == source). Types accepted:
//   "application/x-commander-paths"   — JSON array of VPath
//   "application/x-commander-source"  — "list" or "stash"
for (const paneId of ["left", "right"]) {
  const listEl = document.getElementById(`list-${paneId}`);
  // Clicking empty space below the last row activates the pane so
  // keyboard shortcuts (Ctrl+V etc.) land in the right pane without
  // requiring a row click first.
  listEl.addEventListener("click", (ev) => {
    if (ev.target.closest(".row")) return;
    setActivePane(paneId);
  });
  // Right-click on the empty list area (not on a row) → folder-level
  // context menu: paste / mkdir / mkfile / open-in-terminal / refresh.
  // Works whether the list has entries or is entirely empty; rows keep
  // their own row-level menu.
  listEl.addEventListener("contextmenu", (ev) => {
    if (ev.target.closest(".row")) return;
    ev.preventDefault();
    setActivePane(paneId);
    const tab = activeTab(paneId);
    if (!tab || !tab.cwd) return;
    const pasteable = !!(state.clipboard && state.clipboard.paths && state.clipboard.paths.length);
    const items = [
      {
        label: "paste",
        iconId: "icon-paste",
        disabled: !pasteable,
        onClick: () => doPaste(paneId),
      },
      { separator: true },
      { label: "new folder",   iconId: "icon-folder-new", onClick: () => mkdirPrompt(paneId) },
      { label: "new file",     iconId: "icon-file-new",   onClick: () => mkfilePrompt(paneId) },
      { separator: true },
      {
        label: "open in terminal",
        iconId: "icon-terminal",
        onClick: async () => {
          try { await callUnary("LaunchTerminal", { cwd: tab.cwd }); }
          catch (e) { showInfo(e.message); }
        },
      },
      { label: "refresh",      iconId: "icon-refresh",    onClick: () => reloadPane(paneId) },
    ];
    showCtxMenu(ev.clientX, ev.clientY, items);
  });
  listEl.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer.types.includes("application/x-commander-paths")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    listEl.classList.add("drop-hover");
  });
  listEl.addEventListener("dragleave", (ev) => {
    if (ev.currentTarget.contains(ev.relatedTarget)) return;
    listEl.classList.remove("drop-hover");
  });
  listEl.addEventListener("drop", async (ev) => {
    listEl.classList.remove("drop-hover");
    const raw = ev.dataTransfer.getData("application/x-commander-paths");
    if (!raw) return;
    ev.preventDefault();
    const tab = activeTab(paneId);
    if (!tab) return;
    let paths;
    try { paths = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(paths) || paths.length === 0) return;
    // No-op when every source already lives directly in the drop target —
    // copy/move into the same dir would be either redundant or surprising.
    const destPath = tab.cwd.path;
    const destScheme = tab.cwd.scheme || "file";
    const allSameDest = paths.every(p =>
      (p.scheme || "file") === destScheme && parentDir(p.path) === destPath);
    if (allSameDest) return;
    const label = paths.length === 1 ? `"${basename(paths[0].path)}"` : `${paths.length} items`;
    const op = await promptDropOp(`${label} → ${tab.cwd.path}`);
    if (!op) return;
    try {
      if (op === "move")             await callUnary("StartMove",   { sources: paths, dest: tab.cwd });
      else if (op === "copy")        await callUnary("StartCopy",   { sources: paths, dest: tab.cwd });
      else if (op === "queue-move")  await callUnary("EnqueueMove", { sources: paths, dest: tab.cwd });
      else if (op === "queue-copy")  await callUnary("EnqueueCopy", { sources: paths, dest: tab.cwd });
    } catch (e) { showInfo(e.message); }
  });
}

// --- static + / ★ buttons per pane ----------------------------------------
for (const paneId of ["left", "right"]) {
  // Wheel-scroll the tab strip horizontally — vertical wheel deltas
  // are the natural input for "scroll through hidden tabs". The tabs
  // container already has overflow-x: clip / scroll; here we just
  // translate vertical wheels into scrollLeft.
  const tabsStrip = document.getElementById(`tabs-${paneId}`);
  if (tabsStrip) {
    tabsStrip.addEventListener("wheel", (ev) => {
      // Only act on vertical wheels; trackpad horizontal scrolls are
      // already routed by the browser to scrollLeft.
      if (Math.abs(ev.deltaY) < Math.abs(ev.deltaX)) return;
      tabsStrip.scrollLeft += ev.deltaY;
      ev.preventDefault();
    }, { passive: false });
  }

  // ▾ overflow button — lists every tab in this pane as a menu;
  // clicking jumps to that tab. Easier than wheel-scrolling when
  // there are dozens.
  const overflowBtn = document.getElementById(`tabs-overflow-${paneId}`);
  if (overflowBtn) overflowBtn.onclick = (ev) => {
    ev.stopPropagation();
    const tabs = (state.panes[paneId] && state.panes[paneId].tabs) || [];
    const items = tabs.map(t => {
      let iconId;
      if (t.kind === "TAB_KIND_TERMINAL") iconId = "icon-terminal";
      else if (isSftpTabCwd(t.cwd))       iconId = "icon-sftp";
      else                                iconId = "icon-folder";
      const title = t.title || (t.cwd && t.cwd.path) || "(tab)";
      return {
        label: title,
        iconId,
        onClick: () => { setActivePane(paneId); setActiveTab(paneId, t.tabId); },
      };
    });
    if (!items.length) items.push({ label: "(no tabs)", disabled: true, onClick: () => {} });
    const r = overflowBtn.getBoundingClientRect();
    showCtxMenu(r.left, r.bottom, items);
  };

  const newTabBtn = document.getElementById(`new-tab-${paneId}`);
  newTabBtn.onclick = () => {
    setActivePane(paneId);
    newTab(paneId);
  };
  // Right-click on "+" offers a picker so the user doesn't have to
  // walk through Connections Manager for a local shell.
  newTabBtn.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setActivePane(paneId);
    const rect = newTabBtn.getBoundingClientRect();
    showCtxMenu(rect.left, rect.bottom, [
      {
        label: "file tab",
        iconId: "icon-folder",
        onClick: () => newTab(paneId),
      },
      {
        label: "terminal tab",
        iconId: "icon-terminal",
        onClick: async () => {
          try { await callUnary("OpenLocalTerminalTab", { paneId, cols: 80, rows: 24 }); }
          catch (e) { showInfo(e.message); }
        },
      },
    ]);
  };
  document.getElementById(`bookmarks-${paneId}`).onclick = (ev) => {
    ev.stopPropagation();
    setActivePane(paneId);
    showBookmarksMenu(paneId, ev.target);
  };
}

function showBookmarksMenu(paneId, anchor) {
  const rect = anchor.getBoundingClientRect();
  const tab  = activeTab(paneId);
  const cwd  = tab && tab.cwd;
  const here = !!(cwd && isBookmarked(cwd));
  const bms  = state.bookmarks || [];
  const items = [
    {
      label: "add",
      iconId: "icon-folder-new",
      disabled: !cwd || here,
      onClick: async () => {
        if (!cwd) return;
        try { await callUnary("AddBookmark", { name: (tab && tab.title) || "", path: cwd }); }
        catch (err) { showInfo(err.message); }
      },
    },
    {
      label: "remove",
      iconId: "icon-trash",
      disabled: !cwd || !here,
      onClick: async () => {
        if (!cwd) return;
        try { await callUnary("RemoveBookmark", { path: cwd }); }
        catch (err) { showInfo(err.message); }
      },
    },
    { separator: true },
  ];
  if (bms.length === 0) {
    items.push({ label: "(no bookmarks)", disabled: true, onClick: () => {} });
  } else {
    for (const b of bms) {
      const scheme = b.path && b.path.scheme;
      items.push({
        label: (b.name && b.name !== b.path?.path) ? `${b.name} — ${b.path?.path}` : b.path?.path,
        iconId: scheme === "file" ? "icon-folder" : "icon-globe",
        onClick: async () => {
          try { await callUnary("OpenTab", { paneId, cwd: b.path }); }
          catch (err) { showInfo(err.message); }
        },
        rightAction: {
          iconId: "icon-close",
          title: "Remove bookmark",
          onClick: async () => {
            try { await callUnary("RemoveBookmark", { path: b.path }); }
            catch (err) { showInfo(err.message); }
          },
        },
      });
    }
  }
  showCtxMenu(rect.left, rect.bottom, items);
}

// --- footer shortcut buttons ----------------------------------------------
const SHORTCUTS = [
  ["F1",  "Props",      () => showProperties(activePane)],
  ["F2",  "Rename",     () => renameSel()],
  ["F3",  "View",       () => viewFile(activePane)],
  ["F4",  "Edit",       () => editFile(activePane)],
  ["F5",  "Copy",       () => fileOp("copy")],
  ["F6",  "Move",       () => fileOp("move")],
  ["F7",  "MkDir",      () => mkdirPrompt(activePane)],
  ["F8",  "Delete",     () => fileOp("delete")],
  ["F9",  "Ops Q",      () => showOpsQueue()],
];

function viewFile(paneId) {
  const e = entries[paneId][cursorIndex(paneId)];
  if (!e || e.__parent || e.isDir) return;
  const kv = state.settings || {};
  const viewer = kv["settings/viewer"] || "vim";
  const list = parseList(kv["settings/viewer_list"], DEFAULT_VIEWERS);
  const entry = list.find(it => it.name === viewer) || { name: viewer, terminal: viewer === "vim" };
  callUnary("LaunchEditor", { path: e.path, editor: entry.name, runInTerminal: entry.terminal })
    .catch(err => showInfo(err.message));
}

// --- operations queue dialog ---------------------------------------------
const opsQueueDialog  = document.getElementById("ops-queue-dialog");
const opsQueueBody    = document.getElementById("ops-queue-body");
const opsQueueClose   = document.getElementById("ops-queue-close");
const opsQueueRunAll  = document.getElementById("ops-queue-run-all");
opsQueueClose.onclick = () => opsQueueDialog.close();
opsQueueRunAll.onclick = async () => {
  for (const op of queuedOps()) {
    try { await callUnary("StartQueuedOp", { opId: op.opId }); }
    catch (e) { console.debug("StartQueuedOp:", e.message); }
  }
};

// queuedOps pulls the queued / running / waiting / failed ops out of
// state.ops. An op sticks around in the Ops Q list until it either
// finishes successfully (DONE) or the user explicitly removes it.
// Sort oldest-first so Run-all executes them in creation order.
const OPS_Q_PHASES = new Set([
  "OP_PHASE_QUEUED",
  "OP_PHASE_RUNNING",
  "OP_PHASE_WAITING_PROMPT",
  "OP_PHASE_FAILED",
]);
function queuedOps() {
  return Object.values(state.ops || {})
    .filter(o => OPS_Q_PHASES.has(o.phase))
    .sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
}

function opKindLabel(k) {
  if (k === "OP_KIND_COPY")   return "copy";
  if (k === "OP_KIND_MOVE")   return "move";
  if (k === "OP_KIND_DELETE") return "delete";
  return k || "op";
}

// opKindIconId returns the sprite id for an op kind. Copy/move reuse the
// toolbar copy/cut glyphs; delete uses the trash glyph.
function opKindIconId(k) {
  switch (k) {
    case "OP_KIND_COPY":   return "icon-copy";
    case "OP_KIND_MOVE":   return "icon-cut";
    case "OP_KIND_DELETE": return "icon-trash";
  }
  return "icon-file";
}

function renderOpsQueueBody() {
  const ops = queuedOps();
  const anyRunnable = ops.some(o => o.phase === "OP_PHASE_QUEUED");
  opsQueueRunAll.disabled = !anyRunnable;
  if (ops.length === 0) {
    opsQueueBody.innerHTML =
      `<div style="color:var(--fg-dim);font-size:12px;padding:12px;text-align:center">(no queued operations)</div>`;
    return;
  }
  opsQueueBody.replaceChildren(...ops.map(op => {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:24px 1fr 70px auto auto;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border-subtle);font-size:12px;align-items:center";
    const kind = document.createElement("span");
    kind.title = opKindLabel(op.kind);
    kind.innerHTML = `<svg class="glyph"><use href="#${opKindIconId(op.kind)}"/></svg>`;
    kind.style.cssText = "color:var(--accent);display:inline-flex;align-items:center;justify-content:center";
    const body = document.createElement("span");
    body.style.cssText = "display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden";
    const srcs = (op.sources || []).map(s => basename(s.path)).join(", ");
    const srcEl = document.createElement("span");
    srcEl.textContent = srcs;
    srcEl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    body.appendChild(srcEl);
    if (op.kind === "OP_KIND_DELETE") {
      const skull = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      skull.setAttribute("class", "glyph");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "#icon-skull");
      skull.appendChild(use);
      body.appendChild(skull);
      body.title = srcs;
    } else {
      const destPath = (op.dest && op.dest.path) || "";
      const rest = document.createElement("span");
      rest.textContent = " → " + destPath;
      rest.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      body.appendChild(rest);
      body.title = srcs + " → " + destPath;
    }
    const phase = document.createElement("span");
    phase.textContent = opPhaseLabel(op.phase);
    phase.style.cssText = "color:var(--fg-dim);font-size:10px;text-transform:uppercase;letter-spacing:0.5px";
    const run = document.createElement("button");
    run.className = "icon-btn";
    run.title = "Run";
    run.innerHTML = `<svg class="glyph"><use href="#icon-play"/></svg>`;
    run.disabled = op.phase !== "OP_PHASE_QUEUED";
    run.onclick = async () => {
      try { await callUnary("StartQueuedOp", { opId: op.opId }); }
      catch (e) { showInfo(e.message); }
    };
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.title = "Remove";
    del.innerHTML = `<svg class="glyph"><use href="#icon-trash"/></svg>`;
    del.onclick = async () => {
      try {
        await callUnary("ControlOp", { opId: op.opId, action: "OP_CONTROL_CANCEL" });
      } catch (e) { showInfo(e.message); }
    };
    row.append(kind, body, phase, run, del);
    return row;
  }));
}

function opPhaseLabel(p) {
  switch (p) {
    case "OP_PHASE_QUEUED":         return "queued";
    case "OP_PHASE_RUNNING":        return "running";
    case "OP_PHASE_WAITING_PROMPT": return "prompt";
    case "OP_PHASE_FAILED":         return "failed";
    case "OP_PHASE_DONE":           return "done";
    case "OP_PHASE_CANCELLED":      return "cancelled";
  }
  return "";
}

function showOpsQueue() {
  renderOpsQueueBody();
  opsQueueDialog.showModal();
}

function editFile(paneId) {
  const e = entries[paneId][cursorIndex(paneId)];
  if (!e || e.__parent || e.isDir) return;
  const kv = state.settings || {};
  const editor = kv["settings/editor"] || "vim";
  const list = parseList(kv["settings/editor_list"], DEFAULT_EDITORS);
  const entry = list.find(it => it.name === editor) || { name: editor, terminal: editor === "vim" };
  callUnary("LaunchEditor", { path: e.path, editor: entry.name, runInTerminal: entry.terminal })
    .catch(err => showInfo(err.message));
}
(function buildShortcutBar() {
  // F-keys split across two slots: F1–F8 go into #shortcut-bar on the
  // left, F9 (Ops Q) into #shortcut-bar-right on the far right of the
  // footer, past the ops-progress readout.
  const left  = document.getElementById("shortcut-bar");
  const right = document.getElementById("shortcut-bar-right");
  const leftBtns  = [];
  const rightBtns = [];
  for (const [key, label, handler] of SHORTCUTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.key = key;
    const k = document.createElement("b");
    k.textContent = key;
    btn.appendChild(k);
    const lbl = document.createElement("span");
    lbl.className = "sc-label";
    lbl.textContent = label;
    btn.appendChild(lbl);
    btn.title = `${key} — ${label}`;
    btn.onclick = () => handler();
    (key === "F9" ? rightBtns : leftBtns).push(btn);
  }
  left.replaceChildren(...leftBtns);
  right.replaceChildren(...rightBtns);
})();

// refreshOpsQButton updates the F9 shortcut's label with the queued-op
// count in parens when there are pending queued ops: "Ops Q (3)".
function refreshOpsQButton() {
  // F9 lives in the right-side shortcut slot now, not #shortcut-bar.
  const btn = document.querySelector('[data-key="F9"]');
  if (!btn) return;
  const n = Object.values(state.ops || {}).filter(o => o.phase === "OP_PHASE_QUEUED").length;
  const lbl = btn.querySelector(".sc-label");
  if (!lbl) return;
  lbl.textContent = n > 0 ? `Ops Q (${n})` : "Ops Q";
}

// --- theme ----------------------------------------------------------------
const themeSelect = document.getElementById("theme-select");
function applyTheme() {
  const t = state.theme || "dark";
  document.body.dataset.theme = t;
  if (themeSelect && themeSelect.value !== t) themeSelect.value = t;
}
themeSelect.addEventListener("change", async () => {
  try { await callUnary("SetTheme", { theme: themeSelect.value }); }
  catch (err) { console.debug("SetTheme:", err.message); }
});

// Settings / Connections manager — placeholder handlers. The full Settings
// panel and Connections dialog are tracked as follow-up features.
// Settings dialog: shared-state-backed preferences. Theme round-trips
// through SetTheme (its own RPC); every other key goes through
// SetSetting(key, value), which writes to the daemon's Settings.kv map
// and persists to state.json. That makes these choices visible to
// Fyne + every other attached web renderer — the "TMUX-for-commander"
// invariant.
const settingsDialog = document.getElementById("settings-dialog");
document.getElementById("settings-btn").onclick = () => {
  applySettingsToDialog();
  settingsDialog.showModal();
};
document.getElementById("settings-close").onclick = () => settingsDialog.close();
const settingsViewer    = document.getElementById("settings-viewer");
const settingsEditor    = document.getElementById("settings-editor");
const settingsDblOpen   = document.getElementById("settings-dblclick-open");

// Default viewer/editor lists — used when the shared Settings.kv map
// has no entry yet. Stored as a JSON array of {name, terminal} so
// each entry can remember whether it needs a TTY (vim = yes, code =
// no). A legacy comma-separated value is accepted as a fallback for
// older settings; it's rewritten on the next save.
const DEFAULT_VIEWERS = [{ name: "vim", terminal: true }, { name: "vscode", terminal: false }];
const DEFAULT_EDITORS = [{ name: "vim", terminal: true }, { name: "vscode", terminal: false }];

function parseList(raw, fallback) {
  if (!raw) return fallback.slice();
  // Prefer JSON. Fall back to legacy CSV where no entry carries a
  // terminal flag (defaults to false unless the name is "vim").
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const out = arr
        .map(it => typeof it === "string"
          ? { name: it, terminal: it === "vim" }
          : { name: String(it && it.name || "").trim(), terminal: !!(it && it.terminal) })
        .filter(it => it.name);
      return out.length ? out : fallback.slice();
    }
  } catch {}
  const out = raw.split(",").map(s => s.trim()).filter(Boolean)
    .map(n => ({ name: n, terminal: n === "vim" }));
  return out.length ? out : fallback.slice();
}

function encodeList(list) { return JSON.stringify(list); }

function fillSelect(sel, list, current) {
  sel.replaceChildren(...list.map(it => {
    const opt = document.createElement("option");
    opt.value = it.name;
    opt.textContent = it.terminal ? `${it.name}  (terminal)` : it.name;
    return opt;
  }));
  const names = list.map(it => it.name);
  if (current && names.includes(current)) sel.value = current;
}

// applySettingsToDialog hydrates the viewer/editor selects + toggles
// from the shared Settings.kv map. Called when the dialog opens and
// on every settingsChanged mutation so a change made in Fyne or
// another browser tab reflects here immediately.
function applySettingsToDialog() {
  const kv = state.settings || {};
  const viewers = parseList(kv["settings/viewer_list"], DEFAULT_VIEWERS);
  const editors = parseList(kv["settings/editor_list"], DEFAULT_EDITORS);
  fillSelect(settingsViewer, viewers, kv["settings/viewer"] || viewers[0]);
  fillSelect(settingsEditor, editors, kv["settings/editor"] || editors[0]);
  if (settingsDblOpen) settingsDblOpen.checked = kv["settings/double_click_opens_file"] === "true";
}

settingsViewer.addEventListener("change", () => {
  callUnary("SetSetting", { key: "settings/viewer", value: settingsViewer.value })
    .catch(err => console.debug("SetSetting:", err.message));
});
settingsEditor.addEventListener("change", () => {
  callUnary("SetSetting", { key: "settings/editor", value: settingsEditor.value })
    .catch(err => console.debug("SetSetting:", err.message));
});
if (settingsDblOpen) settingsDblOpen.addEventListener("change", () => {
  callUnary("SetSetting", {
    key: "settings/double_click_opens_file",
    value: settingsDblOpen.checked ? "true" : "false",
  }).catch(err => console.debug("SetSetting:", err.message));
});

// Add / remove helpers for the viewer / editor lists. Entries are
// stored as a JSON array of {name, terminal} under settings/*_list.
async function addListEntry(listKey, selectedKey, sel, defaults) {
  const { name, terminal } = await promptEditorEntry();
  if (!name) return;
  const kv = state.settings || {};
  const current = parseList(kv[listKey], defaults);
  if (current.some(it => it.name === name)) return; // no duplicates
  current.push({ name, terminal });
  try {
    await callUnary("SetSetting", { key: listKey, value: encodeList(current) });
    await callUnary("SetSetting", { key: selectedKey, value: name });
  } catch (e) { showInfo(e.message); }
}

async function removeListEntry(listKey, selectedKey, sel, defaults) {
  const kv = state.settings || {};
  const current = parseList(kv[listKey], defaults);
  const victim = sel.value;
  if (!victim) return;
  const next = current.filter(it => it.name !== victim);
  const replacementName = (next[0] && next[0].name) || (defaults[0] && defaults[0].name) || "";
  try {
    await callUnary("SetSetting", { key: listKey, value: encodeList(next) });
    if (!next.some(it => it.name === (kv[selectedKey] || ""))) {
      await callUnary("SetSetting", { key: selectedKey, value: replacementName });
    }
  } catch (e) { showInfo(e.message); }
}

// promptEditorEntry pops the same input dialog used for Mkdir/rename
// but with a "Run in terminal" checkbox exposed via a temporary
// sibling node. Returns { name, terminal } — empty name cancels.
function promptEditorEntry() {
  return new Promise(async (resolve) => {
    // Inject a transient terminal-toggle into the input dialog; its
    // scope is this single prompt session so we remove it after.
    const field = document.getElementById("input-field");
    const wrap  = field.parentElement;
    const row   = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;margin-top:8px;cursor:pointer";
    const cb    = document.createElement("input");
    cb.type     = "checkbox";
    cb.id       = "input-terminal-toggle";
    cb.style.margin = "0";
    const span  = document.createElement("span");
    span.textContent = "Run in terminal";
    row.appendChild(cb);
    row.appendChild(span);
    wrap.appendChild(row);
    const cleanup = () => { if (row.parentNode) row.parentNode.removeChild(row); };
    const name = await promptName("Add entry (command or binary)", "");
    const terminal = cb.checked;
    cleanup();
    resolve({ name: (name || "").trim(), terminal });
  });
}

const settingsViewerAdd = document.getElementById("settings-viewer-add");
const settingsViewerDel = document.getElementById("settings-viewer-del");
const settingsEditorAdd = document.getElementById("settings-editor-add");
const settingsEditorDel = document.getElementById("settings-editor-del");
if (settingsViewerAdd) settingsViewerAdd.onclick = () => addListEntry("settings/viewer_list", "settings/viewer", settingsViewer, DEFAULT_VIEWERS);
if (settingsViewerDel) settingsViewerDel.onclick = () => removeListEntry("settings/viewer_list", "settings/viewer", settingsViewer, DEFAULT_VIEWERS);
if (settingsEditorAdd) settingsEditorAdd.onclick = () => addListEntry("settings/editor_list", "settings/editor", settingsEditor, DEFAULT_EDITORS);
if (settingsEditorDel) settingsEditorDel.onclick = () => removeListEntry("settings/editor_list", "settings/editor", settingsEditor, DEFAULT_EDITORS);
for (const paneId of ["left", "right"]) {
  const btn = document.getElementById(`connections-${paneId}`);
  if (btn) btn.onclick = (ev) => {
    ev.stopPropagation();
    setActivePane(paneId);
    showConnectionsMenu(paneId, btn);
  };
}

// showConnectionsMenu opens a dropdown anchored under the connections
// button. Hosts from ~/.ssh/config are grouped into two submenus:
//
//   SFTP → clicking a host sshfs-mounts (if needed) and opens the mount
//          path as a new tab in the target pane. Mounted hosts show a ×
//          rightAction to unmount.
//   SSH  → clicking a host spawns a detached terminal running
//          `ssh <alias>`, so the same ~/.ssh/config entry can either be
//          browsed as files or driven as a shell.
//
// Per-entry icons are omitted inside each group so only the parent
// group item carries the mode's glyph.
async function showConnectionsMenu(paneId, anchor) {
  let hosts = [];
  try {
    const res = await callUnary("ListSshHosts", {});
    hosts = res.hosts || [];
  } catch (e) {
    showInfo(e.message);
    return;
  }

  const sftpChildren = [];
  const sshChildren  = [];
  if (hosts.length === 0) {
    const empty = { label: "(no hosts in ~/.ssh/config)", disabled: true, onClick: () => {} };
    sftpChildren.push(empty);
    sshChildren.push({ ...empty });
  } else {
    for (const h of hosts) {
      const mounted = !!h.mountPath;
      const sftpItem = {
        label: mounted ? `● ${h.alias}` : h.alias,
        onClick: async () => {
          try {
            // MountSshHost returns both mount_path (root of the sshfs
            // mount) and cwd (the configured User's home if present).
            // Prefer cwd so the new tab lands in $HOME on the remote.
            const res = await callUnary("MountSshHost", { alias: h.alias });
            const path = res.cwd || res.mountPath;
            await callUnary("OpenTab", { paneId, cwd: { scheme: "file", path } });
          } catch (err) { showInfo(err.message); }
        },
      };
      if (mounted) {
        sftpItem.rightAction = {
          iconId: "icon-close",
          title: "Disconnect",
          onClick: async () => {
            try { await callUnary("UnmountSshHost", { alias: h.alias }); }
            catch (err) { showInfo(err.message); }
          },
        };
      }
      sftpChildren.push(sftpItem);
      const launchInternal = async () => {
        // Internal = open a terminal tab in-process (xterm.js in the web
        // renderer, backed by a daemon PTY running `ssh <alias>`).
        try {
          await callUnary("OpenTerminalTab", {
            paneId, sshAlias: h.alias, cols: 80, rows: 24,
          });
        } catch (err) { showInfo(err.message); }
      };
      const launchExternal = async () => {
        // External = spawn a detached terminal emulator on the desktop.
        try { await callUnary("LaunchTerminal", { sshAlias: h.alias }); }
        catch (err) { showInfo(err.message); }
      };
      sshChildren.push({
        label: h.alias,
        // Label is informational; the action fires from the trailing
        // ▶ buttons only, so accidental label clicks don't spawn a shell.
        inert: true,
        rightActions: [
          { iconId: "icon-play", label: "int", color: "green", title: "Open in internal terminal (new tab)", onClick: launchInternal },
          { iconId: "icon-play", label: "ext", color: "green", title: "Open in external terminal (detached)", onClick: launchExternal },
        ],
      });
    }
  }

  const launchLocal = async () => {
    try {
      await callUnary("OpenLocalTerminalTab", { paneId, cols: 80, rows: 24 });
    } catch (err) { showInfo(err.message); }
  };

  const items = [
    { label: "SFTP", iconId: "icon-sftp", children: sftpChildren },
    { label: "SSH",  iconId: "icon-ssh",  children: sshChildren  },
    // Local terminal: flat top-level entry (no submenu) — one click
    // spawns the user's login shell in the active pane.
    { label: "Local Term", iconId: "icon-terminal", onClick: launchLocal },
  ];
  const rect = anchor.getBoundingClientRect();
  showCtxMenu(rect.left, rect.bottom, items);
}

// --- keyboard capture toggle ----------------------------------------------
// Icon button in the header. When active (default), keydown events are
// swallowed and dispatched as commander shortcuts; when off, they pass
// through to the browser. State persists via localStorage.
const captureKeysBtn = document.getElementById("capture-keys-btn");
let captureKeysOn = localStorage.getItem("captureKeys") !== "false";
function applyCaptureKeysBtn() {
  captureKeysBtn.classList.toggle("active", captureKeysOn);
}
applyCaptureKeysBtn();
captureKeysBtn.addEventListener("click", () => {
  captureKeysOn = !captureKeysOn;
  localStorage.setItem("captureKeys", String(captureKeysOn));
  applyCaptureKeysBtn();
});

// --- keybindings ----------------------------------------------------------
// Capture-phase listener so we see events before any bubble-phase handlers,
// and so nothing else on the page gets them when capture is on.
// When capture is on we always call preventDefault + stopPropagation. The
// browser still intercepts a handful of chrome-level shortcuts (Ctrl+T,
// Ctrl+W, Ctrl+Tab, etc.) before this fires — those can't be suppressed
// from a page context; install as a PWA/app window for full control.
document.addEventListener("keydown", (ev) => {
  if (!captureKeysOn) return;
  // If any modal dialog is open, hands off entirely — native <dialog>
  // handles Esc (cancel event → close) and inputs inside the dialog
  // handle typing / Enter. Without this guard, the commander keymap's
  // unconditional preventDefault() below would swallow Esc and break
  // dialog dismissal for every prompt.
  if (document.querySelector("dialog[open]")) return;
  const tgt = ev.target;
  const isInput = tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA";
  if (isInput) {
    // Ordinary input fields (filter / search / rename prompts) keep
    // their native behavior.
    if (!tgt.closest(".term-wrap")) return;
    // Target IS the terminal's hidden textarea. If the active pane's
    // tab is also a terminal, the user is driving the shell — hands
    // off. Otherwise the user's intent is a commander op on the
    // active (file) pane, so steal focus away from the terminal and
    // let the keymap below handle the event.
    const at = activeTab(activePane);
    if (at && at.kind === "TAB_KIND_TERMINAL") return;
    try { tgt.blur(); } catch {}
  }

  ev.preventDefault();
  ev.stopPropagation();

  const ctrlOnly  = ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
  const ctrlShift = ev.ctrlKey && !ev.metaKey &&  ev.shiftKey && !ev.altKey;
  const k = (ev.key || "").toLowerCase();
  if (ctrlOnly && k === "t") { newTab(); return; }
  if (ctrlOnly && k === "w") { closeTab(); return; }
  // File-list clipboard shortcuts: same effect as the toolbar
  // Cut / Copy / Paste buttons and the row context-menu entries.
  // Ctrl+A selects every non-parent row in the active pane.
  if (ctrlOnly && k === "a") {
    const names = (entries[activePane] || [])
      .filter(e => !e.__parent)
      .map(e => e.name);
    setSelection(activePane, names);
    return;
  }
  if (ctrlOnly && k === "c") { doClipboard(activePane, "MODE_COPY"); return; }
  if (ctrlOnly && k === "x") { doClipboard(activePane, "MODE_CUT");  return; }
  if (ctrlOnly && k === "v") { doPaste(activePane);                   return; }
  // Ctrl+Shift+T — open a local shell tab in the active pane. Most
  // browsers reserve Ctrl+Shift+T for "reopen closed tab" at the
  // chrome level and we can't suppress it from a page context; users
  // who want the shortcut should run commander as a PWA / app window.
  if (ctrlShift && k === "t") {
    callUnary("OpenLocalTerminalTab", { paneId: activePane, cols: 80, rows: 24 })
      .catch(e => showInfo(e.message));
    return;
  }

  // Alt+Arrow for browser-style nav.
  if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
    if (ev.key === "ArrowLeft")  { ev.preventDefault(); navBack(activePane);    return; }
    if (ev.key === "ArrowRight") { ev.preventDefault(); navForward(activePane); return; }
    if (ev.key === "ArrowUp")    { ev.preventDefault(); ascend(activePane);     return; }
  }

  switch (ev.key) {
    case "Tab":
      setActivePane(activePane === "left" ? "right" : "left");
      break;
    case "Enter":       descend(activePane); break;
    case "Backspace":   ascend(activePane); break;
    case "F1":          showProperties(activePane); break;
    case "F2":          renameSel(); break;
    case "F3":          viewFile(activePane); break;
    case "F4":          editFile(activePane); break;
    case "F5":          fileOp("copy"); break;
    case "F6":          fileOp("move"); break;
    case "F7":          mkdirPrompt(activePane); break;
    case "F8":
    case "Delete":      fileOp("delete"); break;
    case "F9":          showOpsQueue(); break;
    case " ":
      computeDirSize(entries[activePane][cursorIndex(activePane)]);
      break;
    case "ArrowDown":    moveCursor(activePane,  1); break;
    case "ArrowUp":      moveCursor(activePane, -1); break;
    case "PageDown":     moveCursor(activePane, 10); break;
    case "PageUp":       moveCursor(activePane,-10); break;
    case "Home":
      if (entries[activePane].length) setCursor(activePane, entries[activePane][0].name);
      break;
    case "End":
      if (entries[activePane].length) setCursor(activePane, entries[activePane][entries[activePane].length-1].name);
      break;
  }
}, true);

// --- bootstrap ------------------------------------------------------------
let snapshotDone;
const snapshotReady = new Promise(res => { snapshotDone = res; });

async function bootstrap() {
  await loadIconSprite();
  await loadColumns();
  renderColumnHeader("left");
  renderColumnHeader("right");
  await fetchDaemonAddr();
  wireStatusDot();

  attachLoop();

  // After the initial snapshot, open defaults only if the shared workspace
  // has no tabs yet.
  await snapshotReady;
  applyTheme();
  renderStash();
  refreshOpsQButton();
  for (const pid of ["left", "right"]) {
    syncPaneToolbar(pid);
    syncFilterRow(pid);
    syncNavButtons(pid);
  }
  for (const paneId of ["left", "right"]) {
    if ((state.panes[paneId]?.tabs || []).length === 0) {
      try {
        await callUnary("OpenTab", { paneId, cwd: { scheme: "file", path: "/" } });
      } catch (e) { /* harmless if it raced another renderer */ }
    }
  }
}

function wireStatusDot() {
  const dot = document.getElementById("status-dot");
  if (!dot) return;
  dot.style.cursor = "pointer";
  dot.addEventListener("click", async () => {
    if (dot.dataset.state === "connected") return;
    const next = await promptName("Daemon address (host:port)", currentDaemonAddr || "127.0.0.1:50000");
    if (!next) return;
    try {
      await setDaemonAddr(next);
      setConnectionStatus("disconnected", `Connecting to ${currentDaemonAddr}…`);
      attachLoop();
    } catch (e) {
      showInfo(`Failed to set daemon: ${e.message}`);
    }
  });
}

let attaching = false;
function attachLoop() {
  if (attaching) return;
  attaching = true;
  (async () => {
    try {
      for await (const ev of streamCall("Attach", { rendererName: "web", rendererVersion: "0.1.0" })) {
        applyEvent(ev);
        if (ev.delta) {
          for (const m of ev.delta.mutations || []) {
            if (m.replaceAll) {
              reloadPane("left");
              reloadPane("right");
              setConnectionStatus("connected", `Connected to ${currentDaemonAddr}`);
              snapshotDone();
            }
            if (m.paneTabAdded) {
              syncPaneToolbar(m.paneTabAdded.paneId);
              syncFilterRow(m.paneTabAdded.paneId);
              reloadPane(m.paneTabAdded.paneId);
            }
            if (m.paneTabCwdChanged) reloadPane(m.paneTabCwdChanged.paneId);
            if (m.paneActiveTabChanged) {
              reloadPane(m.paneActiveTabChanged.paneId);
              renderColumnHeader(m.paneActiveTabChanged.paneId);
            }
            if (m.paneTabSortChanged) {
              // Re-sort without re-fetching.
              sortEntries(m.paneTabSortChanged.paneId);
              renderColumnHeader(m.paneTabSortChanged.paneId);
              render();
            }
            if (m.paneTabCursorChanged)    renderCursorOnly(m.paneTabCursorChanged.paneId);
            if (m.paneTabSelectionChanged) renderSelectionOnly(m.paneTabSelectionChanged.paneId);
            if (m.paneTabPinnedChanged) render();
            if (m.paneTabsReordered) render();
            if (m.activePaneChanged) renderActivePaneOnly();
            if (m.paneTabShowHiddenFilesChanged) {
              syncPaneToolbar(m.paneTabShowHiddenFilesChanged.paneId);
              reloadPane(m.paneTabShowHiddenFilesChanged.paneId);
            }
            if (m.paneTabShowFilterBarChanged) {
              syncPaneToolbar(m.paneTabShowFilterBarChanged.paneId);
              syncFilterRow(m.paneTabShowFilterBarChanged.paneId);
              reloadPane(m.paneTabShowFilterBarChanged.paneId);
            }
            if (m.paneTabShowSearchBarChanged) {
              syncPaneToolbar(m.paneTabShowSearchBarChanged.paneId);
              syncFilterRow(m.paneTabShowSearchBarChanged.paneId);
              reloadPane(m.paneTabShowSearchBarChanged.paneId);
            }
            if (m.paneTabFilterChanged) {
              syncFilterRow(m.paneTabFilterChanged.paneId);
              reloadPane(m.paneTabFilterChanged.paneId);
            }
            if (m.paneTabSearchChanged) {
              syncFilterRow(m.paneTabSearchChanged.paneId);
              reloadPane(m.paneTabSearchChanged.paneId);
            }
            if (m.paneTabSearchCaseSensitiveChanged) {
              syncFilterRow(m.paneTabSearchCaseSensitiveChanged.paneId);
              reloadPane(m.paneTabSearchCaseSensitiveChanged.paneId);
            }
            if (m.paneTabTitleChanged) render();
            if (m.clipboardChanged) {
              syncPaneToolbar("left");
              syncPaneToolbar("right");
            }
            if (m.stashChanged) renderStash();
            if (m.replaceAll)     renderStash();
            if (m.themeChanged) applyTheme();
            if (m.paneActiveTabChanged) {
              syncPaneToolbar(m.paneActiveTabChanged.paneId);
              syncFilterRow(m.paneActiveTabChanged.paneId);
              syncNavButtons(m.paneActiveTabChanged.paneId);
            }
            if (m.paneTabCwdChanged) syncNavButtons(m.paneTabCwdChanged.paneId);
            if (m.paneTabHistoryChanged) syncNavButtons(m.paneTabHistoryChanged.paneId);
            if (m.bookmarkAdded || m.bookmarkRemoved) render();
          }
        }
      }
    } catch (e) {
      setConnectionStatus("disconnected", `stream: ${e.message} (${currentDaemonAddr})`);
    } finally {
      attaching = false;
    }
  })();
}

bootstrap();
