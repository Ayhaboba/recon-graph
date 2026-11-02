/* inspector.js — stage 7 node inspector for the recon graph.
 *
 * Classic script, no modules, no dependencies. Renders into #panel:
 * tabs (Inspector / Settings placeholder), node header, actions, curl output,
 * headers table, findings list and a text-only body preview.
 *
 * All server data is written with textContent; the inspector never builds
 * markup from wire values.
 */
(function () {
  "use strict";

  if (window.__inspector) return;

  var MAX_PREVIEW = 200 * 1024;
  var MAX_FULL = 5 * 1024 * 1024;
  var TOAST_MS = 2500;

  var panel = null;
  var ui = null;
  var toastEl = null;
  var toastTimer = null;

  var state = {
    activeTab: "inspector",
    selectedId: null,
    nodeId: null,
    node: null,
    headers: null,
    findings: [],
    body: null,
    fullBody: null,
    loading: false,
    error: null,
    refetching: false,
    prevRev: null,
    bodyRequested: false,
    curlText: null
  };

  var elements = {};

  // -------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setText(node, text) {
    if (!node) return;
    node.textContent = text === undefined || text === null ? "" : String(text);
  }

  function setShown(node, shown) {
    if (!node) return;
    node.style.display = shown ? "" : "none";
  }

  function asString(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i += 1) parts.push(asString(value[i]));
      return parts.join(", ");
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (_err) {
        return String(value);
      }
    }
    return String(value);
  }

  function fmtBytes(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return "\u2014";
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var index = -1;
    do {
      n /= 1024;
      index += 1;
    } while (n >= 1024 && index < units.length - 1);
    var shown = n >= 10 ? n.toFixed(0) : n.toFixed(1);
    return shown + " " + units[index];
  }

  function clampText(text, limit) {
    var out = String(text);
    if (out.length > limit) {
      out = out.slice(0, limit) + "\n\n\u2026 truncated (" + out.length + " chars)";
    }
    return out;
  }

  function urlFromKey(key) {
    var match = /^([A-Z]+)\s+(.+)$/.exec(String(key === undefined || key === null ? "" : key));
    return match ? match[2] : "";
  }

  function methodOf(node) {
    if (node && node.method) return String(node.method);
    var match = /^([A-Z]+)\s+/.exec(String((node && node.key) || ""));
    return match ? match[1] : "";
  }

  function urlOf(node) {
    if (node && node.url !== undefined && node.url !== null && node.url !== "") {
      return String(node.url);
    }
    return urlFromKey(node && node.key);
  }

  function sizeOf(node, body) {
    if (node && node.size !== undefined && node.size !== null) return fmtBytes(node.size);
    if (node && node.bytes !== undefined && node.bytes !== null) return fmtBytes(node.bytes);
    if (body && body.size !== undefined && body.size !== null) return fmtBytes(body.size);
    return "\u2014";
  }

  function revOf(node) {
    var rev = Number(node && node.rev);
    return isFinite(rev) ? rev : null;
  }

  function send(message) {
    var recon = window.__recon;
    if (!recon || typeof recon.send !== "function") return;
    recon.send(message);
  }

  function toast(message) {
    if (!toastEl || !toastEl.parentNode) {
      toastEl = document.getElementById("toast");
      if (!toastEl) {
        toastEl = make("div", "");
        toastEl.id = "toast";
        document.body.appendChild(toastEl);
      }
    }
    toastEl.textContent = String(message);
    toastEl.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (toastEl) toastEl.style.display = "none";
    }, TOAST_MS);
  }

  function copyText(text) {
    var value = String(text === undefined || text === null ? "" : text);
    var done = function (ok) {
      toast(ok ? "copied" : "copy failed");
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        navigator.clipboard.writeText(value).then(
          function () {
            done(true);
          },
          function () {
            done(fallbackCopy(value));
          }
        );
        return;
      } catch (_err) {
        /* fall through */
      }
    }
    done(fallbackCopy(value));
  }

  function fallbackCopy(value) {
    var area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    var ok = false;
    try {
      area.select();
      ok = document.execCommand("copy");
    } catch (_err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  // -------------------------------------------------------------------------
  // styles
  // -------------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById("inspector-style")) return;
    var style = document.createElement("style");
    style.id = "inspector-style";
    style.textContent = [
      "#panel .inspector-tabs{margin:-12px -12px 10px;padding:8px 12px 0;display:flex;gap:4px;border-bottom:1px solid var(--background-modifier-border,#333)}",
      "#panel .inspector-tab{flex:1;height:26px;border:1px solid transparent;border-bottom:none;border-radius:4px 4px 0 0;background:transparent;color:var(--text-muted);font:inherit;font-size:12px;cursor:pointer}",
      "#panel .inspector-tab.active{color:var(--text-normal);background:var(--background-primary);border-color:var(--background-modifier-border,#333)}",
      "#panel .inspector-heading{font-size:13px;font-weight:600;margin:0 0 8px;color:var(--text-normal)}",
      "#panel .inspector-title{font-size:13px;font-weight:600;margin:0 0 8px;color:var(--text-normal);word-break:break-word;user-select:text}",
      "#panel .inspector-empty{color:var(--text-faint);font-style:italic;margin-top:6px}",
      "#panel .inspector-error{color:#ff9b9b;background:rgba(120,20,20,.25);border:1px solid rgba(255,100,100,.35);border-radius:4px;padding:6px;margin:0 0 8px;white-space:pre-wrap;word-break:break-word}",
      "#panel .inspector-badges{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px}",
      "#panel .inspector-type{display:inline-block;padding:1px 6px;border-radius:3px;background:var(--background-primary);border:1px solid var(--color-base-30,#444);font-family:var(--font-mono);font-size:11px;text-transform:uppercase}",
      "#panel .inspector-method{font-family:var(--font-mono);font-size:11px;color:var(--text-muted)}",
      "#panel .inspector-url{font-family:var(--font-mono);font-size:11px;line-height:1.4;word-break:break-all;white-space:pre-wrap;user-select:text;margin:2px 0 6px}",
      "#panel .inspector-meta{display:grid;grid-template-columns:auto 1fr;gap:1px 8px;font-size:11px;margin-bottom:4px}",
      "#panel .inspector-meta-label{color:var(--text-faint);text-transform:uppercase;letter-spacing:.04em;font-size:10px}",
      "#panel .inspector-meta-value{font-family:var(--font-mono);word-break:break-all;user-select:text}",
      "#panel .inspector-actions{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}",
      "#panel .inspector-btn{height:24px;padding:0 8px;border:1px solid var(--color-base-30,#444);border-radius:4px;background:var(--background-primary);color:var(--text-normal);font:inherit;font-size:11px;cursor:pointer}",
      "#panel .inspector-btn:hover:enabled{border-color:var(--color-base-50,#666)}",
      "#panel .inspector-btn:disabled{opacity:.4;cursor:default}",
      "#panel .inspector-curl{margin:4px 0 8px}",
      "#curl-out{font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:30vh;overflow:auto;background:var(--background-primary);border:1px solid var(--color-base-30,#444);border-radius:4px;padding:6px;margin:4px 0}",
      "#panel .inspector-section-title{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint);margin:10px 0 4px}",
      "#panel .headers-table{width:100%;border-collapse:collapse;table-layout:fixed;font-family:var(--font-mono);font-size:11px}",
      "#panel .headers-table td{border-top:1px solid var(--background-modifier-border,#333);padding:2px 4px;vertical-align:top;word-break:break-all;user-select:text}",
      "#panel .headers-table td:first-child{width:38%;color:var(--text-muted)}",
      "#panel .findings-list{list-style:none;margin:0;padding:0}",
      "#panel .finding{padding:4px 2px;border-top:1px solid var(--background-modifier-border,#333);cursor:pointer}",
      "#panel .finding:hover{background:var(--background-primary)}",
      "#panel .finding-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;background:#888}",
      "#panel .finding-dot.sev-high{background:#e5534b}",
      "#panel .finding-dot.sev-medium{background:#d29922}",
      "#panel .finding-dot.sev-low{background:#3fb950}",
      "#panel .finding-dot.sev-info{background:#58a6ff}",
      "#panel .finding-rule{font-weight:600;margin-right:6px;word-break:break-word}",
      "#panel .finding-sev{color:var(--text-muted);font-size:10px;text-transform:uppercase}",
      "#panel .finding-snippet{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);white-space:pre-wrap;word-break:break-all;margin-top:2px}",
      "#panel .inspector-body-head{display:flex;align-items:center;gap:8px;margin:10px 0 4px}",
      "#panel .inspector-body-head .inspector-section-title{margin:0}",
      "#panel .inspector-body-meta{flex:1;min-width:0;color:var(--text-faint);font-family:var(--font-mono);font-size:10px;word-break:break-all}",
      "#body-preview{font-family:var(--font-mono);font-size:11px;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto;background:var(--background-primary);border:1px solid var(--color-base-30,#444);border-radius:4px;padding:6px;margin:4px 0;user-select:text}",
      "#panel .settings-placeholder{color:var(--text-faint);font-style:italic;margin-top:6px}",
      "#toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:10000;max-width:70vw;padding:6px 12px;border-radius:4px;background:rgba(20,20,25,.95);border:1px solid var(--color-base-40,#555);color:var(--text-normal);font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.45);display:none;white-space:pre-wrap;word-break:break-word}",
      "#graph-back{height:26px;padding:0 8px;border:1px solid var(--color-base-30,#444);border-radius:4px;background:var(--background-primary);color:var(--text-normal);font:inherit;font-size:12px;cursor:pointer}",
      "#graph-back:hover{border-color:var(--color-base-50,#666)}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  // -------------------------------------------------------------------------
  // DOM construction
  // -------------------------------------------------------------------------

  function buildUI() {
    while (panel.firstChild) panel.removeChild(panel.firstChild);

    var tabs = make("div", "inspector-tabs");
    var inspectorTab = make("button", "inspector-tab active", "Inspector");
    inspectorTab.type = "button";
    var settingsTab = make("button", "inspector-tab", "Settings");
    settingsTab.type = "button";
    tabs.appendChild(inspectorTab);
    tabs.appendChild(settingsTab);
    panel.appendChild(tabs);

    var inspectorView = make("div", "inspector-view");
    var title = make("div", "inspector-heading", "Inspector");
    var empty = make("div", "inspector-empty", "Select a node in the graph.");
    var error = make("div", "inspector-error");
    error.style.display = "none";

    var details = make("div", "inspector-details");

    var head = make("div", "inspector-head");
    var badges = make("div", "inspector-badges");
    var typeEl = make("span", "inspector-type", "\u2014");
    var methodEl = make("span", "inspector-method", "\u2014");
    badges.appendChild(typeEl);
    badges.appendChild(methodEl);
    head.appendChild(badges);

    var urlEl = make("div", "inspector-url", "\u2014");
    head.appendChild(urlEl);

    var meta = make("div", "inspector-meta");
    var statusValue = appendMeta(meta, "status");
    var sizeValue = appendMeta(meta, "size");
    var depthValue = appendMeta(meta, "depth");
    var originValue = appendMeta(meta, "origin");
    head.appendChild(meta);
    details.appendChild(head);

    var actions = make("div", "inspector-actions");
    var curlBtn = make("button", "inspector-btn", "curl");
    var openBtn = make("button", "inspector-btn", "open");
    var refetchBtn = make("button", "inspector-btn", "refetch");
    var subgraphBtn = make("button", "inspector-btn", "subgraph");
    var copyBtn = make("button", "inspector-btn", "copy URL");
    curlBtn.type = "button";
    openBtn.type = "button";
    refetchBtn.type = "button";
    subgraphBtn.type = "button";
    copyBtn.type = "button";
    actions.appendChild(curlBtn);
    actions.appendChild(openBtn);
    actions.appendChild(refetchBtn);
    actions.appendChild(subgraphBtn);
    actions.appendChild(copyBtn);
    details.appendChild(actions);

    var curlBlock = make("div", "inspector-curl");
    curlBlock.style.display = "none";
    var curlOut = make("pre", "");
    curlOut.id = "curl-out";
    var curlCopy = make("button", "inspector-btn", "copy curl");
    curlCopy.type = "button";
    curlBlock.appendChild(curlOut);
    curlBlock.appendChild(curlCopy);
    details.appendChild(curlBlock);

    details.appendChild(make("div", "inspector-section-title", "Headers"));
    var headersTable = make("table", "headers-table");
    details.appendChild(headersTable);

    details.appendChild(make("div", "inspector-section-title", "Findings"));
    var findingsList = make("ul", "findings-list");
    details.appendChild(findingsList);

    var bodyHead = make("div", "inspector-body-head");
    bodyHead.appendChild(make("div", "inspector-section-title", "Body"));
    var bodyMeta = make("span", "inspector-body-meta", "");
    var loadFullBtn = make("button", "inspector-btn", "load full");
    loadFullBtn.type = "button";
    loadFullBtn.id = "load-full";
    bodyHead.appendChild(bodyMeta);
    bodyHead.appendChild(loadFullBtn);
    details.appendChild(bodyHead);

    var bodyPre = make("pre", "");
    bodyPre.id = "body-preview";
    details.appendChild(bodyPre);

    inspectorView.appendChild(title);
    inspectorView.appendChild(empty);
    inspectorView.appendChild(error);
    inspectorView.appendChild(details);
    panel.appendChild(inspectorView);

    var settingsView = make("div", "inspector-settings-view");
    settingsView.id = "settings-pane";
    if (!window.__panel) settingsView.textContent = "Settings (stage 9)";
    settingsView.style.display = "none";
    panel.appendChild(settingsView);

    elements = {
      url: urlEl,
      status: statusValue,
      type: typeEl,
      size: sizeValue,
      tabs: tabs,
      curl: curlBtn,
      open: openBtn,
      refetch: refetchBtn,
      subgraph: subgraphBtn,
      copy: copyBtn,
      headersTable: headersTable,
      findingsList: findingsList,
      bodyPre: bodyPre,
      loadFull: loadFullBtn,
      title: title,
      method: methodEl,
      depth: depthValue,
      origin: originValue,
      error: error,
      empty: empty,
      curlOut: curlOut,
      curlCopy: curlCopy,
      bodyMeta: bodyMeta
    };

    ui = {
      inspectorTab: inspectorTab,
      settingsTab: settingsTab,
      inspectorView: inspectorView,
      settingsView: settingsView,
      title: title,
      empty: empty,
      error: error,
      details: details,
      curlBlock: curlBlock,
      bodyMeta: bodyMeta
    };

    inspectorTab.addEventListener("click", function () {
      setTab("inspector");
    });
    settingsTab.addEventListener("click", function () {
      setTab("settings");
      if (window.__panel && window.__panel.show) window.__panel.show();
    });
    curlBtn.addEventListener("click", onCurl);
    openBtn.addEventListener("click", onOpen);
    refetchBtn.addEventListener("click", onRefetch);
    subgraphBtn.addEventListener("click", onSubgraph);
    copyBtn.addEventListener("click", onCopyUrl);
    curlCopy.addEventListener("click", function () {
      if (state.curlText !== null) copyText(state.curlText);
    });
    loadFullBtn.addEventListener("click", onLoadFull);
    render();
    if (window.__panel && window.__panel.mount) window.__panel.mount();
  }

  function appendMeta(container, label) {
    container.appendChild(make("span", "inspector-meta-label", label));
    var value = make("span", "inspector-meta-value", "\u2014");
    container.appendChild(value);
    return value;
  }

  // -------------------------------------------------------------------------
  // tabs and state rendering
  // -------------------------------------------------------------------------

  function setTab(tab) {
    state.activeTab = tab === "settings" ? "settings" : "inspector";
    render();
  }

  function renderTabs() {
    if (!ui) return;
    ui.inspectorTab.className =
      "inspector-tab" + (state.activeTab === "inspector" ? " active" : "");
    ui.settingsTab.className =
      "inspector-tab" + (state.activeTab === "settings" ? " active" : "");
    setShown(ui.inspectorView, state.activeTab === "inspector");
    setShown(ui.settingsView, state.activeTab === "settings");
  }

  function render() {
    if (!ui) return;
    renderTabs();
    if (state.activeTab !== "inspector") return;

    var hasNode = !!state.node;
    var active = state.loading || state.error !== null || hasNode;

    if (ui.title.className !== (active ? "inspector-title" : "inspector-heading")) {
      ui.title.className = active ? "inspector-title" : "inspector-heading";
    }

    if (state.loading) {
      setText(ui.title, "loading #" + state.selectedId + "\u2026");
      setShown(ui.empty, false);
      setShown(ui.error, false);
      setShown(ui.details, false);
      return;
    }

    if (state.error !== null) {
      setText(ui.title, "node #" + (state.selectedId === null ? "?" : state.selectedId));
      setText(ui.error, state.error);
      setShown(ui.error, true);
      setShown(ui.empty, false);
      setShown(ui.details, false);
      return;
    }

    if (!hasNode) {
      setText(ui.title, "Inspector");
      setShown(ui.error, false);
      setShown(ui.empty, true);
      setShown(ui.details, false);
      return;
    }

    setShown(ui.empty, false);
    setShown(ui.error, false);
    setShown(ui.details, true);

    renderHeader();
    renderActions();
    renderCurl();
    renderHeaders();
    renderFindings();
    renderBody();
  }

  function renderHeader() {
    var node = state.node || {};
    var url = urlOf(node);
    setText(ui.title, node.key ? String(node.key) : node.label ? String(node.label) : "node #" + state.nodeId);
    setText(elements.type, node.type ? String(node.type) : "\u2014");
    setText(elements.method, methodOf(node) || "\u2014");
    setText(elements.url, url || "\u2014");
    setText(elements.status, node.status === undefined || node.status === null ? "\u2014" : String(node.status));
    setText(elements.size, sizeOf(node, state.body));
    setText(elements.depth, node.depth === undefined || node.depth === null ? "\u2014" : String(node.depth));
    setText(elements.origin, node.origin === undefined || node.origin === null ? "\u2014" : String(node.origin));
  }

  function renderActions() {
    var node = state.node;
    var url = node ? urlOf(node) : "";
    elements.curl.disabled = !node;
    elements.open.disabled = !url;
    if (url) {
      elements.open.setAttribute("data-url", url);
      elements.open.title = url;
    } else {
      elements.open.removeAttribute("data-url");
      elements.open.title = "";
    }
    elements.refetch.disabled = !node || state.refetching;
    elements.refetch.textContent = state.refetching ? "refetching\u2026" : "refetch";
    elements.subgraph.disabled = !(node && node.key !== undefined && node.key !== null);
    elements.copy.disabled = !url;
    elements.loadFull.disabled = !(state.body && state.fullBody === null && !state.bodyRequested);
    elements.loadFull.textContent = state.bodyRequested
      ? "loading\u2026"
      : state.fullBody !== null
        ? "loaded"
        : "load full";
  }

  function renderCurl() {
    if (state.curlText === null) {
      setShown(ui.curlBlock, false);
      setText(elements.curlOut, "");
      return;
    }
    setShown(ui.curlBlock, true);
    setText(elements.curlOut, state.curlText);
  }

  function headerPairs(headers) {
    var out = [];
    if (!headers) return out;

    if (Array.isArray(headers)) {
      for (var i = 0; i < headers.length; i += 1) {
        var item = headers[i];
        if (Array.isArray(item)) {
          out.push([asString(item[0]), asString(item[1])]);
        } else if (item && typeof item === "object") {
          var name = item.name !== undefined ? item.name : item[0];
          var value = item.value !== undefined ? item.value : item[1];
          out.push([asString(name), asString(value)]);
        }
      }
      return out;
    }

    if (typeof headers === "object") {
      var names = Object.keys(headers).sort(function (a, b) {
        return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
      });
      for (var j = 0; j < names.length; j += 1) {
        out.push([asString(names[j]), asString(headers[names[j]])]);
      }
    }
    return out;
  }

  function renderHeaders() {
    var table = elements.headersTable;
    while (table.firstChild) table.removeChild(table.firstChild);
    var pairs = headerPairs(state.headers);

    if (pairs.length === 0) {
      var emptyRow = make("tr", "");
      var emptyCell = make("td", "", "\u2014");
      emptyCell.colSpan = 2;
      emptyRow.appendChild(emptyCell);
      table.appendChild(emptyRow);
      return;
    }

    for (var i = 0; i < pairs.length; i += 1) {
      var row = make("tr", "");
      row.appendChild(make("td", "", pairs[i][0]));
      row.appendChild(make("td", "", pairs[i][1]));
      table.appendChild(row);
    }
  }

  function severityClass(severity) {
    var value = String(severity === undefined || severity === null ? "" : severity).toLowerCase();
    if (value.indexOf("crit") >= 0 || value === "high" || value === "error") return "sev-high";
    if (value.indexOf("med") >= 0 || value === "warn" || value === "warning") return "sev-medium";
    if (value.indexOf("low") >= 0) return "sev-low";
    if (value.indexOf("info") >= 0 || value.indexOf("note") >= 0) return "sev-info";
    return "";
  }

  function makeFindingItem(finding) {
    var item = make("li", "finding");
    var head = make("div", "finding-head");
    var dot = make("span", "finding-dot " + severityClass(finding.severity));
    if (finding.severity !== undefined && finding.severity !== null) {
      dot.title = String(finding.severity);
    }
    head.appendChild(dot);
    head.appendChild(make("span", "finding-rule", finding.rule ? String(finding.rule) : "finding"));
    head.appendChild(
      make(
        "span",
        "finding-sev",
        finding.severity === undefined || finding.severity === null ? "unknown" : String(finding.severity)
      )
    );
    item.appendChild(head);
    if (finding.snippet !== undefined && finding.snippet !== null) {
      item.appendChild(make("div", "finding-snippet", asString(finding.snippet)));
    }

    var offset = finding.offset;
    item.addEventListener("click", function () {
      scrollBodyTo(offset);
    });
    return item;
  }

  function renderFindings() {
    var list = elements.findingsList;
    while (list.firstChild) list.removeChild(list.firstChild);

    var findings = Array.isArray(state.findings) ? state.findings : [];
    if (findings.length === 0) {
      list.appendChild(make("li", "finding", "\u2014"));
      return;
    }
    for (var i = 0; i < findings.length; i += 1) {
      if (findings[i] && typeof findings[i] === "object") {
        list.appendChild(makeFindingItem(findings[i]));
      }
    }
  }

  function scrollBodyTo(offset) {
    var pre = elements.bodyPre;
    var position = Number(offset);
    var length = pre.textContent ? pre.textContent.length : 0;
    if (!isFinite(position) || position < 0 || length <= 0) return;
    var ratio = position / length;
    if (ratio > 1) ratio = 1;
    pre.scrollTop = ratio * pre.scrollHeight;
  }

  function currentBodyText() {
    if (state.fullBody !== null) return clampText(state.fullBody, MAX_FULL);
    if (state.body) {
      if (state.body.text !== undefined && state.body.text !== null) {
        return clampText(String(state.body.text), MAX_FULL);
      }
      if (state.body.preview !== undefined && state.body.preview !== null) {
        return clampText(String(state.body.preview), MAX_PREVIEW);
      }
    }
    return "";
  }

  function renderBody() {
    var text = currentBodyText();
    elements.bodyPre.textContent = text || "\u2014";
    var meta = [];
    if (state.body) {
      if (state.body.mime) meta.push(String(state.body.mime));
      if (state.body.size !== undefined && state.body.size !== null) meta.push(fmtBytes(state.body.size));
    }
    if (state.fullBody !== null) meta.push("full");
    setText(ui.bodyMeta, meta.join(" \u00b7 "));
  }

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------

  function onCurl() {
    if (!state.node) return;
    send({ t: "action", id: state.nodeId, cmd: "curl" });
  }

  function onOpen() {
    var url = urlOf(state.node);
    if (!url) return;
    window.open(url, "_blank", "noopener");
  }

  function onRefetch() {
    if (!state.node || state.refetching) return;
    state.prevRev = revOf(state.node);
    state.refetching = true;
    render();
    send({ t: "action", id: state.nodeId, cmd: "refetch" });
  }

  function onSubgraph() {
    var recon = window.__recon;
    if (!state.node || !recon || typeof recon.setLocalGraph !== "function") return;
    var key = state.node.key !== undefined && state.node.key !== null ? state.node.key : state.nodeId;
    var ok = false;
    try {
      ok = recon.setLocalGraph(key);
    } catch (_err) {
      ok = false;
    }
    toast(ok ? "local graph" : "local graph unavailable");
  }

  function onCopyUrl() {
    var url = urlOf(state.node);
    if (!url) return;
    copyText(url);
  }

  function onLoadFull() {
    if (!state.node || !state.body || state.bodyRequested || state.fullBody !== null) return;
    state.bodyRequested = true;
    render();
    send({ t: "action", id: state.nodeId, cmd: "body" });
  }

  // -------------------------------------------------------------------------
  // wire payloads
  // -------------------------------------------------------------------------

  function select(nodeId) {
    if (nodeId === undefined || nodeId === null || nodeId === "") {
      hide();
      return;
    }
    state.selectedId = String(nodeId);
    state.nodeId = nodeId;
    state.node = null;
    state.headers = null;
    state.findings = [];
    state.body = null;
    state.fullBody = null;
    state.loading = true;
    state.error = null;
    state.refetching = false;
    state.prevRev = null;
    state.bodyRequested = false;
    state.curlText = null;
    state.activeTab = "inspector";
    render();
  }

  function onNodePayload(msg) {
    if (!msg || typeof msg !== "object") return;

    var incoming = msg.id !== undefined && msg.id !== null ? String(msg.id) : null;
    if (
      state.loading &&
      state.selectedId !== null &&
      incoming !== null &&
      incoming !== state.selectedId
    ) {
      return;
    }

    state.loading = false;
    state.error = null;
    if (msg.id !== undefined && msg.id !== null) {
      state.nodeId = msg.id;
      state.selectedId = String(msg.id);
    }

    var bodyOnly =
      msg.full === true ||
      (!msg.node && msg.body && typeof msg.body === "object");
    if (bodyOnly) {
      state.body = msg.body;
      state.fullBody =
        msg.body.text !== undefined && msg.body.text !== null
          ? String(msg.body.text)
          : msg.body.preview !== undefined && msg.body.preview !== null
            ? String(msg.body.preview)
            : "";
      state.bodyRequested = false;
      render();
      toast("body loaded");
      return;
    }

    state.node = msg.node && typeof msg.node === "object" ? msg.node : {};
    state.headers = msg.headers === undefined ? null : msg.headers;
    state.findings = Array.isArray(msg.findings) ? msg.findings : [];
    state.body = msg.body && typeof msg.body === "object" ? msg.body : null;
    state.fullBody =
      state.body && state.body.text !== undefined && state.body.text !== null
        ? String(state.body.text)
        : null;
    state.bodyRequested = false;
    state.curlText = null;

    var wasRefetching = state.refetching;
    var previousRev = state.prevRev;
    state.refetching = false;

    render();

    var newRev = revOf(state.node);
    if (wasRefetching) {
      if (previousRev !== null && newRev !== null) {
        toast("rev " + previousRev + " \u2192 " + newRev);
      } else {
        toast("refetched");
      }
    }
    state.prevRev = newRev;
  }

  function onActionPayload(msg) {
    if (!msg || typeof msg !== "object") return;

    var cmd = msg.cmd === undefined || msg.cmd === null ? "" : String(msg.cmd);
    var matchesSelection =
      msg.id === undefined ||
      msg.id === null ||
      state.selectedId === null ||
      String(msg.id) === state.selectedId;

    if (cmd === "curl") {
      if (!matchesSelection) return;
      var curl = pickString(msg.curl);
      if (curl === null && msg.result && typeof msg.result === "object") {
        curl = pickString(msg.result.curl);
      }
      if (curl === null) curl = pickString(msg.text);
      if (curl === null) {
        toast("curl unavailable");
        return;
      }
      state.curlText = curl;
      render();
      return;
    }

    if (cmd === "body") {
      if (!matchesSelection) return;
      state.bodyRequested = false;
      var text = null;
      if (msg.body && typeof msg.body === "object" && msg.body.text !== undefined && msg.body.text !== null) {
        text = String(msg.body.text);
      } else {
        text = pickString(msg.text);
      }
      if (text === null) {
        toast("body unavailable");
        render();
        return;
      }
      state.fullBody = text;
      if (state.body) state.body.text = text;
      render();
      toast("body loaded");
      return;
    }

    if (cmd === "refetch") {
      if (msg.node && typeof msg.node === "object") {
        onNodePayload({
          t: "node",
          id: msg.id === undefined || msg.id === null ? state.nodeId : msg.id,
          node: msg.node,
          headers: msg.headers === undefined ? state.headers : msg.headers,
          findings: msg.findings === undefined ? state.findings : msg.findings,
          body: msg.body === undefined ? state.body : msg.body
        });
        return;
      }
      if (msg.ok === false || msg.error) {
        state.refetching = false;
        render();
        toast("refetch failed");
      }
    }
  }

  function pickString(value) {
    if (value === undefined || value === null) return null;
    return typeof value === "string" ? value : String(value);
  }

  function onServerError(msg) {
    if (!msg || typeof msg !== "object") return;
    var text =
      msg.message !== undefined && msg.message !== null
        ? String(msg.message)
        : msg.error !== undefined && msg.error !== null
          ? String(msg.error)
          : msg.code !== undefined && msg.code !== null
            ? String(msg.code)
            : "server error";

    var of = msg.of === undefined || msg.of === null ? "" : String(msg.of);

    if (of === "refetch") {
      state.refetching = false;
      render();
      toast("refetch failed: " + text);
      return;
    }
    if (of === "body") {
      state.bodyRequested = false;
      render();
      toast("body failed: " + text);
      return;
    }
    if (of === "curl") {
      toast("curl failed: " + text);
      return;
    }

    if (of === "node" || state.loading) {
      state.loading = false;
      state.error = text;
      render();
    }
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  function show(nodeId) {
    state.activeTab = "inspector";
    if (nodeId !== undefined && nodeId !== null) {
      select(nodeId);
    } else {
      render();
    }
  }

  function hide() {
    state.selectedId = null;
    state.nodeId = null;
    state.node = null;
    state.headers = null;
    state.findings = [];
    state.body = null;
    state.fullBody = null;
    state.loading = false;
    state.error = null;
    state.refetching = false;
    state.prevRev = null;
    state.bodyRequested = false;
    state.curlText = null;
    state.activeTab = "inspector";
    render();
  }

  function current() {
    if (!state.node) return null;
    return {
      nodeId: state.nodeId,
      node: state.node,
      headers: state.headers,
      findings: state.findings,
      body: state.body
    };
  }

  window.__inspector = {
    select: select,
    onNodePayload: onNodePayload,
    onActionPayload: onActionPayload,
    onServerError: onServerError,
    show: show,
    hide: hide,
    current: current,
    elements: elements
  };

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  function boot() {
    panel = document.getElementById("panel");
    if (!panel) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
      } else {
        setTimeout(boot, 50);
      }
      return;
    }
    injectStyle();
    buildUI();
  }

  boot();
})();
