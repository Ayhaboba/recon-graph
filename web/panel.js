/* panel.js — stage 9 recon settings panel.
 *
 * Classic script, no modules, no dependencies. Forked from the clean-room
 * Obsidian settings panel look (src/clean/panel.css + settings.js) but all
 * control logic is recon-specific.
 *
 * Sections: Filters (types / status / origin), Display, Forces, Groups.
 * Exposes window.__panel = {show, hide, state}.
 */
(function () {
  "use strict";

  if (window.__panel) return;

  var STORAGE_KEY = "recon.panel.v1";
  var FORCE_T = 0.01;
  var SAVE_DEBOUNCE_MS = 80;

  var TYPE_GROUPS = ["page", "endpoint", "asset", "artifact", "unresolved", "param"];
  var STATUS_GROUPS = [
    { key: "ok", label: "ok (2xx)" },
    { key: "redirect", label: "redirect (3xx)" },
    { key: "clientErr", label: "clientErr (4xx)" },
    { key: "serverErr", label: "serverErr (5xx)" },
    { key: "unknown", label: "unknown (no status)" }
  ];
  var ORIGIN_GROUPS = [
    { key: "crawl", label: "crawl" },
    { key: "fuzz", label: "fuzz" }
  ];

  var DEFAULT_COLORS = {
    page: "#dadada",
    endpoint: "#e0de71",
    asset: "#44cf6e",
    artifact: "#5aa9ff",
    unresolved: "#777777",
    param: "#e9973f"
  };

  var DEFAULTS = {
    filters: {
      types: allTrue(TYPE_GROUPS),
      status: allTrue(["ok", "redirect", "clientErr", "serverErr", "unknown"]),
      origin: allTrue(["crawl", "fuzz"])
    },
    display: {
      nodeSizeMultiplier: 1,
      lineSizeMultiplier: 1,
      textFadeMultiplier: 0
    },
    forces: {
      center: 0.1,
      repel: 10,
      link: 1,
      distance: 250
    },
    colors: copy(DEFAULT_COLORS)
  };

  var state = loadState();
  var root = null;
  var host = null;
  var countEls = {
    types: {},
    status: {},
    origin: {}
  };
  var typeChecks = {};
  var statusChecks = {};
  var originChecks = {};
  var groupChecks = {};
  var refreshTimer = null;
  var saveTimer = null;

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function allTrue(keys) {
    var out = {};
    for (var i = 0; i < keys.length; i += 1) out[keys[i]] = true;
    return out;
  }

  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function boolOr(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function numberOr(value, fallback, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return clamp(n, min, max);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* Obsidian F2/R2 slider math (src/clean/settings.js:22-28). The UI slider
   * holds the 0..1 position; the renderer gets its R2 image. */
  function R2(value, t) {
    var step = t == null ? FORCE_T : t;
    return 1 - Math.log(value * (1 - step) + step) / Math.log(step);
  }

  function toStored(value) {
    return R2(clamp(value, 0, 1), FORCE_T);
  }

  function normalize(raw) {
    var source = raw && typeof raw === "object" ? raw : {};
    var incomingFilters = source.filters && typeof source.filters === "object" ? source.filters : {};
    var incomingDisplay = source.display && typeof source.display === "object" ? source.display : {};
    var incomingForces = source.forces && typeof source.forces === "object" ? source.forces : {};
    var incomingColors = source.colors && typeof source.colors === "object" ? source.colors : {};

    var filters = {
      types: {},
      status: {},
      origin: {}
    };
    var i;

    for (i = 0; i < TYPE_GROUPS.length; i += 1) {
      var type = TYPE_GROUPS[i];
      filters.types[type] = boolOr(
        incomingFilters.types && incomingFilters.types[type],
        DEFAULTS.filters.types[type]
      );
    }
    for (i = 0; i < STATUS_GROUPS.length; i += 1) {
      var status = STATUS_GROUPS[i].key;
      filters.status[status] = boolOr(
        incomingFilters.status && incomingFilters.status[status],
        DEFAULTS.filters.status[status]
      );
    }
    for (i = 0; i < ORIGIN_GROUPS.length; i += 1) {
      var origin = ORIGIN_GROUPS[i].key;
      filters.origin[origin] = boolOr(
        incomingFilters.origin && incomingFilters.origin[origin],
        DEFAULTS.filters.origin[origin]
      );
    }

    var colors = {};
    for (i = 0; i < TYPE_GROUPS.length; i += 1) {
      var name = TYPE_GROUPS[i];
      var colour = incomingColors[name];
      colors[name] =
        typeof colour === "string" && /^#[0-9a-f]{6}$/i.test(colour)
          ? colour.toLowerCase()
          : DEFAULT_COLORS[name];
    }

    return {
      filters: filters,
      display: {
        nodeSizeMultiplier: numberOr(
          incomingDisplay.nodeSizeMultiplier,
          DEFAULTS.display.nodeSizeMultiplier,
          0.1,
          5
        ),
        lineSizeMultiplier: numberOr(
          incomingDisplay.lineSizeMultiplier,
          DEFAULTS.display.lineSizeMultiplier,
          0.1,
          5
        ),
        textFadeMultiplier: numberOr(
          incomingDisplay.textFadeMultiplier,
          DEFAULTS.display.textFadeMultiplier,
          -3,
          3
        )
      },
      forces: {
        center: numberOr(incomingForces.center, DEFAULTS.forces.center, 0, 1),
        repel: numberOr(incomingForces.repel, DEFAULTS.forces.repel, 0, 20),
        link: numberOr(incomingForces.link, DEFAULTS.forces.link, 0, 1),
        distance: Math.round(
          numberOr(incomingForces.distance, DEFAULTS.forces.distance, 30, 500)
        )
      },
      colors: colors
    };
  }

  function loadState() {
    var parsed = null;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch (_err) {
      parsed = null;
    }
    return normalize(parsed);
  }

  function saveState() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (_err) {
        /* private mode / quota */
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // -------------------------------------------------------------------------
  // engine bridge
  // -------------------------------------------------------------------------

  function recon() {
    return window.__recon && typeof window.__recon === "object" ? window.__recon : null;
  }

  function filterPayload() {
    return copy(state.filters);
  }

  function displayPayload() {
    return {
      nodeSizeMultiplier: state.display.nodeSizeMultiplier,
      lineSizeMultiplier: state.display.lineSizeMultiplier,
      textFadeMultiplier: state.display.textFadeMultiplier
    };
  }

  function forcesPayload() {
    var repel = clamp(state.forces.repel, 0, 20);
    return {
      centerStrength: toStored(state.forces.center),
      linkStrength: toStored(state.forces.link),
      linkDistance: Math.round(clamp(state.forces.distance, 30, 500)),
      /* src/raw-settings.js:627-632 — the slider value is cubed. */
      repelStrength: repel * repel * repel
    };
  }

  function applyFilter() {
    var api = recon();
    if (!api) return;
    if (typeof api.setFilter === "function") api.setFilter(filterPayload());
    refreshCounts();
    saveState();
  }

  function applyDisplay() {
    var api = recon();
    if (api && typeof api.setRenderOptions === "function") {
      api.setRenderOptions(displayPayload());
    }
    saveState();
  }

  function applyForces() {
    var api = recon();
    if (api && typeof api.setForces === "function") {
      api.setForces(forcesPayload());
    }
    saveState();
  }

  function applyColors() {
    var api = recon();
    if (api && typeof api.setGroupColors === "function") {
      api.setGroupColors(copy(state.colors));
    }
    saveState();
  }

  function applyAll() {
    applyFilter();
    applyDisplay();
    applyForces();
    applyColors();
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  function section(title, open) {
    var details = el("details", "gs-section");
    if (open) details.open = true;
    var header = el("summary", "gs-section-header", title);
    details.appendChild(header);
    var body = el("div", "gs-section-body");
    details.appendChild(body);
    return { details: details, body: body };
  }

  function checkboxRow(labelText, checked, onChange) {
    var row = el("label", "gs-setting gs-setting-toggle gs-filter-row");
    var info = el("span", "gs-setting-info");
    var name = el("span", "gs-setting-name", labelText);
    info.appendChild(name);
    var count = el("span", "gs-setting-count", "");
    info.appendChild(count);
    row.appendChild(info);
    var control = el("span", "gs-setting-control");
    var input = el("input", "gs-checkbox");
    input.type = "checkbox";
    input.checked = !!checked;
    input.addEventListener("change", function () {
      onChange(!!input.checked);
    });
    control.appendChild(input);
    row.appendChild(control);
    return { row: row, input: input, count: count };
  }

  function sliderRow(labelText, min, max, step, value, format, onInput) {
    var wrap = el("div", "gs-setting gs-setting-slider");
    var info = el("div", "gs-setting-info");
    var label = el("label", "gs-setting-name", labelText);
    var valueEl = el("span", "gs-setting-value", format(value));
    info.appendChild(label);
    info.appendChild(valueEl);
    wrap.appendChild(info);
    var control = el("div", "gs-setting-control");
    var range = el("input", "gs-range");
    range.type = "range";
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.addEventListener("input", function () {
      var next = clamp(range.value, min, max);
      valueEl.textContent = format(next);
      onInput(next);
    });
    control.appendChild(range);
    wrap.appendChild(control);
    return { row: wrap, input: range, value: valueEl };
  }

  function buttonRow(labelText, onClick) {
    var row = el("div", "gs-setting gs-setting-button");
    var button = el("button", "gs-button", labelText);
    button.type = "button";
    button.addEventListener("click", onClick);
    row.appendChild(button);
    return row;
  }

  function formatNumber(value) {
    var n = Number(value);
    return isFinite(n) ? String(Math.round(n * 100) / 100) : "\u2014";
  }

  function buildFilters(body) {
    body.appendChild(el("div", "gs-subsection-title", "Types"));
    for (var i = 0; i < TYPE_GROUPS.length; i += 1) {
      (function (type) {
        var row = checkboxRow(
          type,
          state.filters.types[type],
          function (checked) {
            state.filters.types[type] = checked;
            if (groupChecks[type]) groupChecks[type].checked = checked;
            applyFilter();
          }
        );
        typeChecks[type] = row.input;
        countEls.types[type] = row.count;
        body.appendChild(row.row);
      })(TYPE_GROUPS[i]);
    }

    body.appendChild(el("div", "gs-subsection-title", "Status"));
    for (var j = 0; j < STATUS_GROUPS.length; j += 1) {
      (function (group) {
        var row = checkboxRow(
          group.label,
          state.filters.status[group.key],
          function (checked) {
            state.filters.status[group.key] = checked;
            applyFilter();
          }
        );
        statusChecks[group.key] = row.input;
        countEls.status[group.key] = row.count;
        body.appendChild(row.row);
      })(STATUS_GROUPS[j]);
    }

    body.appendChild(el("div", "gs-subsection-title", "Origin"));
    for (var k = 0; k < ORIGIN_GROUPS.length; k += 1) {
      (function (group) {
        var row = checkboxRow(
          group.label,
          state.filters.origin[group.key],
          function (checked) {
            state.filters.origin[group.key] = checked;
            applyFilter();
          }
        );
        originChecks[group.key] = row.input;
        countEls.origin[group.key] = row.count;
        body.appendChild(row.row);
      })(ORIGIN_GROUPS[k]);
    }

    body.appendChild(
      buttonRow("reset filters", function () {
        state.filters = copy(DEFAULTS.filters);
        syncFilterControls();
        applyFilter();
      })
    );
  }

  function syncFilterControls() {
    for (var i = 0; i < TYPE_GROUPS.length; i += 1) {
      var type = TYPE_GROUPS[i];
      if (typeChecks[type]) typeChecks[type].checked = state.filters.types[type];
      if (groupChecks[type]) groupChecks[type].checked = state.filters.types[type];
    }
    for (var j = 0; j < STATUS_GROUPS.length; j += 1) {
      var status = STATUS_GROUPS[j].key;
      if (statusChecks[status]) statusChecks[status].checked = state.filters.status[status];
    }
    for (var k = 0; k < ORIGIN_GROUPS.length; k += 1) {
      var origin = ORIGIN_GROUPS[k].key;
      if (originChecks[origin]) originChecks[origin].checked = state.filters.origin[origin];
    }
  }

  function buildDisplay(body) {
    body.appendChild(
      sliderRow(
        "node size",
        0.1,
        5,
        0.1,
        state.display.nodeSizeMultiplier,
        formatNumber,
        function (value) {
          state.display.nodeSizeMultiplier = value;
          applyDisplay();
        }
      ).row
    );
    body.appendChild(
      sliderRow(
        "link thickness",
        0.1,
        5,
        0.1,
        state.display.lineSizeMultiplier,
        formatNumber,
        function (value) {
          state.display.lineSizeMultiplier = value;
          applyDisplay();
        }
      ).row
    );
    body.appendChild(
      sliderRow(
        "text fade threshold",
        -3,
        3,
        0.1,
        state.display.textFadeMultiplier,
        formatNumber,
        function (value) {
          state.display.textFadeMultiplier = value;
          applyDisplay();
        }
      ).row
    );
  }

  function buildForces(body) {
    body.appendChild(
      sliderRow(
        "center force",
        0,
        1,
        0.01,
        state.forces.center,
        formatNumber,
        function (value) {
          state.forces.center = value;
          applyForces();
        }
      ).row
    );
    body.appendChild(
      sliderRow(
        "repel force",
        0,
        20,
        0.1,
        state.forces.repel,
        formatNumber,
        function (value) {
          state.forces.repel = value;
          applyForces();
        }
      ).row
    );
    body.appendChild(
      sliderRow(
        "link force",
        0,
        1,
        0.01,
        state.forces.link,
        formatNumber,
        function (value) {
          state.forces.link = value;
          applyForces();
        }
      ).row
    );
    body.appendChild(
      sliderRow(
        "link distance",
        30,
        500,
        1,
        state.forces.distance,
        formatNumber,
        function (value) {
          state.forces.distance = Math.round(value);
          applyForces();
        }
      ).row
    );
    body.appendChild(
      buttonRow("reset forces", function () {
        state.forces = copy(DEFAULTS.forces);
        rebuild();
        applyForces();
      })
    );
  }

  function buildGroups(body) {
    for (var i = 0; i < TYPE_GROUPS.length; i += 1) {
      (function (type) {
        var row = el("div", "gs-color-group");
        var visible = el("input", "gs-checkbox");
        visible.type = "checkbox";
        visible.checked = state.filters.types[type];
        visible.title = "show " + type;
        visible.addEventListener("change", function () {
          state.filters.types[type] = visible.checked;
          if (typeChecks[type]) typeChecks[type].checked = visible.checked;
          applyFilter();
        });
        groupChecks[type] = visible;
        row.appendChild(visible);

        var swatch = el("input", "gs-color-swatch");
        swatch.type = "color";
        swatch.value = state.colors[type];
        swatch.title = type + " colour";
        swatch.addEventListener("input", function () {
          state.colors[type] = swatch.value.toLowerCase();
          applyColors();
        });
        row.appendChild(swatch);

        row.appendChild(el("span", "gs-color-label", type));
        body.appendChild(row);
      })(TYPE_GROUPS[i]);
    }
  }

  function rebuild() {
    var parent = root && root.parentNode;
    if (!parent) return;
    var fresh = el("div", "graph-settings-panel");
    fresh.id = "graph-settings-panel";
    parent.replaceChild(fresh, root);
    root = fresh;
    countEls = { types: {}, status: {}, origin: {} };
    typeChecks = {};
    statusChecks = {};
    originChecks = {};
    groupChecks = {};
    buildInto(root);
  }

  function buildInto(container) {
    container.appendChild(el("div", "gs-panel-title", "Graph settings"));

    var filters = section("Filters", true);
    buildFilters(filters.body);
    container.appendChild(filters.details);

    var display = section("Display", true);
    buildDisplay(display.body);
    container.appendChild(display.details);

    var forces = section("Forces", false);
    buildForces(forces.body);
    container.appendChild(forces.details);

    var groups = section("Groups", false);
    buildGroups(groups.body);
    container.appendChild(groups.details);
  }

  function ensureRoot() {
    host = document.getElementById("panel");
    if (!host) return null;
    if (!root) {
      root = el("div", "graph-settings-panel");
      root.id = "graph-settings-panel";
      buildInto(root);
    }

    var placeholder = host.querySelector(".settings-placeholder");
    var target = placeholder || host;
    if (root.parentNode !== target) {
      if (placeholder) {
        while (placeholder.firstChild) placeholder.removeChild(placeholder.firstChild);
      }
      target.appendChild(root);
    }
    return root;
  }

  // -------------------------------------------------------------------------
  // counts
  // -------------------------------------------------------------------------

  function setCount(map, key, value) {
    var node = map[key];
    if (!node) return;
    node.textContent = value == null ? "" : "(" + value + ")";
  }

  function refreshCounts() {
    var api = recon();
    if (!api || typeof api.filterCounts !== "function") return;
    var counts;
    try {
      counts = api.filterCounts();
    } catch (_err) {
      return;
    }
    if (!counts || typeof counts !== "object") return;
    var i;
    for (i = 0; i < TYPE_GROUPS.length; i += 1) {
      var type = TYPE_GROUPS[i];
      setCount(countEls.types, type, counts.types ? counts.types[type] : null);
    }
    for (i = 0; i < STATUS_GROUPS.length; i += 1) {
      var status = STATUS_GROUPS[i].key;
      setCount(countEls.status, status, counts.status ? counts.status[status] : null);
    }
    for (i = 0; i < ORIGIN_GROUPS.length; i += 1) {
      var origin = ORIGIN_GROUPS[i].key;
      setCount(countEls.origin, origin, counts.origin ? counts.origin[origin] : null);
    }
  }

  function startRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(refreshCounts, 1000);
  }

  function stopRefresh() {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  function show() {
    ensureRoot();
    if (!root) return false;
    root.hidden = false;
    root.style.display = "block";

    var holder = root.parentNode;
    if (holder && holder.classList && holder.classList.contains("settings-placeholder")) {
      if (holder.style.display === "none" && host) {
        var tabs = host.querySelectorAll(".inspector-tab");
        for (var i = 0; i < tabs.length; i += 1) {
          if (String(tabs[i].textContent || "").trim().toLowerCase() === "settings") {
            tabs[i].click();
            break;
          }
        }
      }
    }

    applyAll();
    refreshCounts();
    startRefresh();
    return true;
  }

  function hide() {
    if (root) {
      root.hidden = true;
      root.style.display = "none";
    }
    stopRefresh();
    return true;
  }

  function stateSnapshot() {
    return copy(state);
  }

  window.__panel = {
    show: show,
    hide: hide,
    state: stateSnapshot
  };

  // Apply persisted settings as soon as the shell and recon API exist.
  function boot() {
    ensureRoot();
    applyAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
