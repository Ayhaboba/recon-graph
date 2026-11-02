/* search.js — stage 8 search UI (spec §6, §7).
 *
 * Classic script, no modules, no dependencies. Exposes window.__search.
 *
 * The server streams search results in two frames:
 *   {t:"search",      seq, count, mode}       — honest total
 *   {t:"searchChunk", seq, ids:[…], done}     — id chunks
 *
 * recon.js ignores those frames, so this file taps the WebSocket message
 * stream (onmessage assignment is wrapped before recon.js creates its socket).
 * The result list is virtualized: only the visible window is rendered, the
 * total height lives in a spacer, and updates are coalesced per animation
 * frame. No markup is ever built from wire data; rows use textContent only.
 */
(function () {
  "use strict";

  if (window.__search) return;

  var ROW_HEIGHT = 22;
  var OVERSCAN = 10;
  var MAX_RENDERED = 40;
  var DEBOUNCE_MS = 200;
  var SEARCH_INPUT_SELECTOR = "#search";

  var state = {
    q: "",
    mode: "fts",
    seq: 0,
    count: 0,
    items: [],
    seen: Object.create(null),
    done: false,
    keyById: Object.create(null)
  };

  var els = {
    input: null,
    mode: null,
    panel: null,
    badge: null,
    results: null,
    spacer: null,
    rows: null
  };

  var debounceTimer = null;
  var renderScheduled = false;
  var styleInstalled = false;

  // -------------------------------------------------------------------------
  // WebSocket tap
  // -------------------------------------------------------------------------

  function parseWire(event) {
    if (!event || typeof event.data !== "string") return;
    var msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_err) {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    onWireMessage(msg);
  }

  function rememberNodes(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i += 1) {
      var node = list[i];
      if (!node || node.id === undefined || node.id === null) continue;
      if (node.key === undefined || node.key === null) continue;
      state.keyById[String(node.id)] = String(node.key);
    }
  }

  function onWireMessage(msg) {
    if (msg.t === "snapshot" || msg.t === "delta") {
      rememberNodes(msg.nodes);
      return;
    }
    if (msg.t === "node" && msg.node) {
      if (msg.id !== undefined && msg.id !== null && msg.node.key !== undefined && msg.node.key !== null) {
        state.keyById[String(msg.id)] = String(msg.node.key);
      }
      return;
    }

    var seq = msg.seq === undefined || msg.seq === null ? null : Number(msg.seq);

    if (msg.t === "search") {
      if (seq !== null && seq !== state.seq) return;
      if (msg.count === undefined || msg.count === null) return;
      state.count = Math.max(0, Number(msg.count) || 0);
      state.items = [];
      state.seen = Object.create(null);
      state.done = false;
      updateBadge();
      ensurePanelVisible();
      if (els.results) els.results.scrollTop = 0;
      if (Array.isArray(msg.ids)) appendIds(msg.ids, msg.done === true);
      if (Array.isArray(msg.hits)) appendHits(msg.hits, msg.done === true);
      scheduleRender();
      return;
    }

    if (msg.t === "searchChunk") {
      if (seq !== null && seq !== state.seq) return;
      if (Array.isArray(msg.ids)) appendIds(msg.ids, msg.done === true);
      else if (Array.isArray(msg.nodeIds)) appendIds(msg.nodeIds, msg.done === true);
      else if (Array.isArray(msg.hits)) appendHits(msg.hits, msg.done === true);
      else if (msg.done === true) finishSearch();
    }
  }

  function installMessageTap() {
    var proto = window.WebSocket && window.WebSocket.prototype;
    if (!proto || proto.__searchTapped) return;
    proto.__searchTapped = true;

    try {
      var descriptor = Object.getOwnPropertyDescriptor(proto, "onmessage");
      if (descriptor && typeof descriptor.set === "function") {
        Object.defineProperty(proto, "onmessage", {
          configurable: true,
          enumerable: descriptor.enumerable === true,
          get: function () {
            return descriptor.get ? descriptor.get.call(this) : null;
          },
          set: function (handler) {
            var wrapped =
              typeof handler === "function"
                ? function (event) {
                    parseWire(event);
                    return handler.call(this, event);
                  }
                : handler;
            descriptor.set.call(this, wrapped);
          }
        });
      }
    } catch (_err) {
      /* tap is best effort; the UI still works if the socket API changes */
    }

    try {
      var originalAdd = proto.addEventListener;
      if (typeof originalAdd === "function") {
        var wrappers = new WeakMap();
        proto.addEventListener = function (type, listener, options) {
          if (type === "message" && typeof listener === "function") {
            var wrapped = wrappers.get(listener);
            if (!wrapped) {
              wrapped = function (event) {
                parseWire(event);
                return listener.call(this, event);
              };
              wrappers.set(listener, wrapped);
            }
            return originalAdd.call(this, type, wrapped, options);
          }
          return originalAdd.call(this, type, listener, options);
        };
      }
    } catch (_err2) {
      /* best effort */
    }
  }

  // -------------------------------------------------------------------------
  // result buffer
  // -------------------------------------------------------------------------

  function idOf(entry) {
    if (entry === undefined || entry === null) return 0;
    if (typeof entry === "object") {
      if (entry.key !== undefined && entry.key !== null && entry.nodeId !== undefined) {
        state.keyById[String(entry.nodeId)] = String(entry.key);
      }
      entry = entry.nodeId !== undefined ? entry.nodeId : entry.id;
    }
    var id = Number(entry);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  function appendIds(ids, done) {
    for (var i = 0; i < ids.length; i += 1) {
      var id = idOf(ids[i]);
      if (!id) continue;
      var key = String(id);
      if (state.seen[key]) continue;
      state.seen[key] = true;
      state.items.push(id);
    }
    updateBadge();
    scheduleRender();
    if (done) finishSearch();
  }

  function appendHits(hits, done) {
    var ids = [];
    for (var i = 0; i < hits.length; i += 1) {
      var hit = hits[i];
      if (hit && typeof hit === "object") {
        if (hit.nodeId !== undefined && hit.nodeId !== null && hit.key !== undefined && hit.key !== null) {
          state.keyById[String(hit.nodeId)] = String(hit.key);
        }
        ids.push(hit.nodeId !== undefined ? hit.nodeId : hit.id);
      } else {
        ids.push(hit);
      }
    }
    appendIds(ids, done);
  }

  function finishSearch() {
    state.done = true;
    updateBadge();
    applyEmphasis();
  }

  function updateBadge() {
    if (!els.badge) return;
    var suffix = state.done ? "" : " \u00b7 searching\u2026";
    els.badge.textContent = state.count + " matches" + suffix;
  }

  // -------------------------------------------------------------------------
  // virtualized rendering
  // -------------------------------------------------------------------------

  function ensureStyle() {
    if (styleInstalled) return;
    styleInstalled = true;
    var style = document.createElement("style");
    style.id = "search-style";
    style.textContent = [
      "#search-panel{position:fixed;top:var(--topbar-height,44px);right:0;width:420px;height:320px;z-index:9000;display:none;flex-direction:column;background:var(--background-secondary,#1e1e24);border:1px solid var(--background-modifier-border,#333);border-top:none;border-radius:0 0 4px 4px;box-shadow:0 8px 20px rgba(0,0,0,.45);overflow:hidden}",
      "#search-panel.visible{display:flex}",
      "#search-badge{flex:0 0 auto;height:24px;line-height:24px;padding:0 8px;font-family:var(--font-mono,monospace);font-size:11px;color:var(--text-muted,#aaa);background:var(--background-primary,#18181d);border-bottom:1px solid var(--background-modifier-border,#333);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#search-results{position:relative;flex:1 1 auto;overflow-y:auto;overflow-x:hidden;min-height:0;overscroll-behavior:contain}",
      "#search-spacer{position:absolute;left:0;top:0;width:1px;pointer-events:none}",
      "#search-rows{position:absolute;left:0;top:0;right:0}",
      "#search-rows .search-result-row{position:absolute;left:0;right:0;height:22px;line-height:22px;padding:0 8px;font-family:var(--font-mono,monospace);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;color:var(--text-normal,#ddd);border-bottom:1px solid rgba(255,255,255,.04);box-sizing:border-box}",
      "#search-rows .search-result-row:hover{background:var(--background-primary,#18181d)}",
      "#search-mode{height:26px;padding:0 4px;color:var(--text-normal);background:var(--background-primary);border:1px solid var(--color-base-30,#333);border-radius:4px;font:inherit;font-size:12px;outline:none}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function buildDom() {
    els.input = document.querySelector(SEARCH_INPUT_SELECTOR);

    if (els.input) {
      els.mode = document.getElementById("search-mode");
      if (!els.mode) {
        els.mode = document.createElement("select");
        els.mode.id = "search-mode";
        els.mode.title = "search mode";
        var fts = document.createElement("option");
        fts.value = "fts";
        fts.textContent = "fts";
        var regex = document.createElement("option");
        regex.value = "regex";
        regex.textContent = "regex";
        els.mode.appendChild(fts);
        els.mode.appendChild(regex);
        els.input.parentNode.insertBefore(els.mode, els.input.nextSibling);
      }
    }

    els.panel = document.getElementById("search-panel");
    if (!els.panel) {
      els.panel = document.createElement("section");
      els.panel.id = "search-panel";
      var host = document.getElementById("topbar") || document.body;
      host.appendChild(els.panel);
    }

    els.badge = document.getElementById("search-badge");
    if (!els.badge) {
      els.badge = document.createElement("div");
      els.badge.id = "search-badge";
      els.badge.textContent = "0 matches";
      els.panel.appendChild(els.badge);
    }

    els.results = document.getElementById("search-results");
    if (!els.results) {
      els.results = document.createElement("div");
      els.results.id = "search-results";
      els.panel.appendChild(els.results);
    }

    els.spacer = document.getElementById("search-spacer");
    if (!els.spacer) {
      els.spacer = document.createElement("div");
      els.spacer.id = "search-spacer";
      els.results.appendChild(els.spacer);
    }

    els.rows = document.getElementById("search-rows");
    if (!els.rows) {
      els.rows = document.createElement("div");
      els.rows.id = "search-rows";
      els.results.appendChild(els.rows);
    }

    ensureStyle();
    updateBadge();
  }

  function ensurePanelVisible() {
    if (els.panel) els.panel.classList.add("visible");
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(renderWindow);
  }

  function renderWindow() {
    renderScheduled = false;
    if (!els.results || !els.rows || !els.spacer) return;

    var total = Math.max(state.count, state.items.length);
    els.spacer.style.height = String(total * ROW_HEIGHT) + "px";

    var viewport = els.results.clientHeight || 300;
    var top = els.results.scrollTop || 0;
    var start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    var end = Math.min(
      state.items.length,
      Math.ceil((top + viewport) / ROW_HEIGHT) + OVERSCAN
    );
    if (end - start > MAX_RENDERED) end = start + MAX_RENDERED;
    if (end < start) end = start;

    var fragment = document.createDocumentFragment();
    for (var index = start; index < end; index += 1) {
      var id = state.items[index];
      var row = document.createElement("div");
      row.className = "search-result-row";
      row.setAttribute("role", "option");
      row.dataset.index = String(index);
      row.dataset.id = String(id);
      row.style.top = String(index * ROW_HEIGHT) + "px";
      var knownKey = state.keyById[String(id)];
      row.textContent = "#" + id + (knownKey ? "  " + knownKey : "");
      row.title = knownKey || String(id);
      fragment.appendChild(row);
    }

    while (els.rows.firstChild) els.rows.removeChild(els.rows.firstChild);
    els.rows.appendChild(fragment);
  }

  // -------------------------------------------------------------------------
  // emphasis + row click
  // -------------------------------------------------------------------------

  function rendererSetEmphasis(ids) {
    var recon = window.__recon;
    var renderer = recon && recon.renderer;
    if (!renderer || typeof renderer.setEmphasis !== "function") return false;
    try {
      renderer.setEmphasis(ids);
      return true;
    } catch (_err) {
      return false;
    }
  }

  function applyEmphasis() {
    var keys = [];
    for (var i = 0; i < state.items.length; i += 1) {
      var id = state.items[i];
      var key = state.keyById[String(id)];
      keys.push(key !== undefined ? key : id);
    }
    return rendererSetEmphasis(keys);
  }

  function onRowClick(event) {
    var target = event.target;
    while (target && target !== els.rows && !target.classList?.contains("search-result-row")) {
      target = target.parentNode;
    }
    if (!target || target === els.rows) return;

    var index = Number(target.dataset.index);
    var id = state.items[index];
    if (!id) return;

    var recon = window.__recon;
    if (recon && typeof recon.requestNode === "function") recon.requestNode(id);
    applyEmphasis();
    if (window.__inspector && typeof window.__inspector.select === "function") {
      window.__inspector.select(id);
    }
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  function currentMode() {
    if (els.mode && els.mode.value === "regex") return "regex";
    return "fts";
  }

  function resetList() {
    state.items = [];
    state.seen = Object.create(null);
    state.done = false;
    if (els.results) els.results.scrollTop = 0;
    scheduleRender();
  }

  function run(q, mode) {
    var query = q === undefined || q === null ? "" : String(q);
    var chosen = mode === "regex" ? "regex" : mode === "fts" ? "fts" : currentMode();

    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (query.trim() === "") {
      clear();
      return 0;
    }

    state.q = query;
    state.mode = chosen;
    state.seq += 1;
    state.count = 0;
    resetList();
    updateBadge();
    ensurePanelVisible();

    var recon = window.__recon;
    var scanId = Number(recon && recon.currentScanId);
    if (!recon || typeof recon.send !== "function" || !isFinite(scanId) || scanId <= 0) {
      return state.seq;
    }

    recon.send({
      t: "search",
      scanId: scanId,
      seq: state.seq,
      q: query,
      mode: chosen
    });
    return state.seq;
  }

  function clear() {
    state.seq += 1;
    state.q = "";
    state.count = 0;
    state.items = [];
    state.seen = Object.create(null);
    state.done = false;
    state.keyById = Object.create(null);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (els.input && els.input.value !== "") els.input.value = "";
    if (els.panel) els.panel.classList.remove("visible");
    updateBadge();
    scheduleRender();
    rendererSetEmphasis([]);
  }

  function results() {
    return state.items;
  }

  function count() {
    return state.count;
  }

  function bindInput() {
    if (!els.input) return;

    els.input.addEventListener("input", function () {
      var query = els.input.value;
      if (query.trim() === "") {
        clear();
        return;
      }
      ensurePanelVisible();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        run(query, currentMode());
      }, DEBOUNCE_MS);
    });

    els.input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        run(els.input.value, currentMode());
      } else if (event.key === "Escape") {
        clear();
      }
    });

    if (els.mode) {
      els.mode.value = "fts";
      els.mode.addEventListener("change", function () {
        if (!els.input) return;
        if (els.input.value.trim() === "") return;
        run(els.input.value, currentMode());
      });
    }

    if (els.results) {
      els.results.addEventListener("scroll", scheduleRender, { passive: true });
    }
    if (els.rows) {
      els.rows.addEventListener("click", onRowClick);
    }
  }

  // recon.js runs before this file and creates its WebSocket synchronously, so
  // the prototype tap alone would miss the first socket. Attach to it directly;
  // reconnects are covered by the prototype wrapper installed above.
  function attachToLiveSocket() {
    var recon = window.__recon;
    var socket = recon && typeof recon.socket === "function" ? recon.socket() : null;
    if (!socket || socket.__searchAttached) return;
    socket.__searchAttached = true;
    socket.addEventListener("message", parseWire);
  }

  function boot() {
    installMessageTap();
    attachToLiveSocket();
    buildDom();
    bindInput();
    window.__search = {
      run: run,
      results: results,
      count: count,
      clear: clear,
      elements: els,
      mode: currentMode
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
