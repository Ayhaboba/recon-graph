/* recon.js — stage 6 client.
 *
 * WebSocket ingest (proto 1) -> local adjacency -> Obsidian graph engine.
 * Classic script, no modules, no dependencies. Exposes window.__recon.
 */
(function () {
  "use strict";

  if (window.__recon) return;

  var PAGE_LIMIT = 5000;
  var SEP = " \u00b7 ";
  var RECONNECT_DELAYS = [250, 500, 1000, 2000, 5000];

  var TYPE_MAP = {
    page: "",
    endpoint: "attachment",
    artifact: "tag",
    unresolved: "unresolved",
    asset: "",
    param: "attachment",
    focused: "focused"
  };

  var readyResolve;
  var readyDone = false;
  var readyPromise = new Promise(function (resolve) {
    readyResolve = resolve;
  });

  var R = null;
  var statusEl = null;
  var errorEl = null;
  var selectEl = null;

  var nodesById = {};       // numeric node id -> wire record {id,key,type,degree,...}
  var idsByKey = {};        // graph id (= node key) -> numeric node id
  var edgesByPair = {};     // "src\0dst" -> true (engine links are per src->dst pair)
  var localState = null;    // {key} while a local subgraph is shown
  var activeFilter = null;  // stage 9: normalized visibility filter
  var groupColors = null;   // stage 9: {type: {a, rgb}} renderer overrides
  var renderOptions = null; // replayed once the renderer exists
  var forceOptions = null;

  var FILTER_TYPES = ["page", "endpoint", "asset", "artifact", "unresolved", "param"];
  var FILTER_STATUS = ["ok", "redirect", "clientErr", "serverErr", "unknown"];
  var FILTER_ORIGIN = ["crawl", "fuzz"];
  var lastStats = {};
  var lastMsg = null;

  var loading = null;       // {scanId, gen, sawFirst, awaitingPage, lastAfter}
  var gen = 0;
  var pendingSwitch = null; // {gen, scanId, resolve, reject}

  var socket = null;
  var helloOk = false;
  var retryTimer = null;
  var retryAttempt = 0;
  var pageClosed = false;

  var objectIdMap = new WeakMap();
  var nextObjectId = 1;

  var api = {
    ready: readyPromise,
    renderer: null,
    scans: [],
    currentScanId: null,
    datasetNodeCount: datasetNodeCount,
    nodeIds: nodeIds,
    positions: positions,
    objectIds: objectIds,
    edgeCount: edgeCount,
    switchScan: switchScan,
    send: send,
    // Stage 8: search.js taps the live socket for search/searchChunk frames.
    socket: function () {
      return socket;
    },
    requestNode: requestNode,
    setLocalGraph: setLocalGraph,
    clearLocalGraph: clearLocalGraph,
    isLocalGraph: isLocalGraph,
    statusText: statusText,
    lastMessage: function () {
      return lastMsg;
    },
    // Stage 9: panel filter/render API.
    setFilter: setFilter,
    getFilter: getFilter,
    setRenderOptions: setRenderOptions,
    setForces: setForces,
    filterCounts: filterCounts,
    setGroupColors: setGroupColors
  };

  window.__recon = api;
  window.__reconLoads = 0;

  // -------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------

  function setStatusText(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setStatus(nodes, edges, pending) {
    var p = Number(pending);
    if (!isFinite(p) || p < 0) p = 0;
    setStatusText("nodes " + nodes + SEP + "edges " + edges + SEP + "pending " + p);
  }

  function statusText() {
    return statusEl ? statusEl.textContent : "";
  }

  function engineType(raw) {
    var type = raw == null ? "" : String(raw);
    return TYPE_MAP.hasOwnProperty(type) ? TYPE_MAP[type] : "";
  }

  function degreeOf(record) {
    var n = Number(record && record.degree);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function localNodeCount() {
    return Object.keys(nodesById).length;
  }

  function countResolvedEdges() {
    var pairs = Object.keys(edgesByPair);
    var count = 0;
    for (var i = 0; i < pairs.length; i += 1) {
      var parts = pairs[i].split("\u0000");
      if (nodesById[parts[0]] && nodesById[parts[1]]) count += 1;
    }
    return count;
  }

  function resetLocal() {
    nodesById = {};
    idsByKey = {};
    edgesByPair = {};
    lastStats = {};
  }

  function showFatal(err) {
    console.error("[graph] init failed", err);
    if (!errorEl) errorEl = document.getElementById("error");
    if (errorEl) {
      errorEl.textContent =
        "[graph] init failed\n\n" + (err && err.stack ? err.stack : String(err));
      errorEl.style.display = "block";
    }
    setStatusText("fatal" + SEP + "see overlay");
  }

  function showNotice(text) {
    setStatusText(text);
  }

  // -------------------------------------------------------------------------
  // local adjacency -> engine dataset
  // -------------------------------------------------------------------------

  function mergeNodes(list) {
    if (!list || typeof list.length !== "number") return;
    for (var i = 0; i < list.length; i += 1) {
      var node = list[i];
      if (!node || node.id == null || node.key == null) continue;
      var id = String(node.id);
      var key = String(node.key);
      var status = node.status == null ? null : Number(node.status);
      nodesById[id] = {
        id: node.id,
        key: key,
        type: node.type,
        degree: node.degree,
        status: isFinite(status) ? status : null,
        origin: node.origin == null ? null : String(node.origin),
        label: node.label == null ? null : String(node.label)
      };
      idsByKey[key] = node.id;
    }
  }

  function mergeEdges(list) {
    if (!list || typeof list.length !== "number") return;
    for (var i = 0; i < list.length; i += 1) {
      var edge = list[i];
      if (!edge || edge.length < 2) continue;
      var src = String(edge[0]);
      var dst = String(edge[1]);
      if (src === "" || dst === "") continue;
      edgesByPair[src + "\u0000" + dst] = true;
    }
  }

  /* Engine setData() keeps x/y for ids present in the incoming dataset and
   * prunes every node that is absent. A delta therefore has to carry the full
   * live node set (with complete links maps) or unrelated nodes disappear.
   * This builds that set from the local adjacency: required delta ids are
   * included by construction, plus every other live id, all with full links.
   */
  function typeBucket(record) {
    var type = record && record.type == null ? "" : String(record.type);
    return FILTER_TYPES.indexOf(type) >= 0 ? type : null;
  }

  function statusBucket(record) {
    var status = record && record.status == null ? NaN : Number(record.status);
    if (!isFinite(status) || status <= 0) return "unknown";
    if (status >= 200 && status < 300) return "ok";
    if (status >= 300 && status < 400) return "redirect";
    if (status >= 400 && status < 500) return "clientErr";
    if (status >= 500 && status < 600) return "serverErr";
    return "unknown";
  }

  function originBucket(record) {
    if (!record) return "crawl";
    var origin = record.origin;
    if (origin == null || origin === "") return "crawl";
    return String(origin) === "fuzz" ? "fuzz" : "crawl";
  }

  function allTrue(keys) {
    var out = {};
    for (var i = 0; i < keys.length; i += 1) out[keys[i]] = true;
    return out;
  }

  function normalizeFilter(filter) {
    var source = filter && typeof filter === "object" ? filter : {};
    var out = {
      types: allTrue(FILTER_TYPES),
      status: allTrue(FILTER_STATUS),
      origin: allTrue(FILTER_ORIGIN)
    };
    var groups = ["types", "status", "origin"];
    for (var g = 0; g < groups.length; g += 1) {
      var group = groups[g];
      var incoming = source[group] && typeof source[group] === "object" ? source[group] : null;
      if (!incoming) continue;
      var keys = Object.keys(out[group]);
      for (var i = 0; i < keys.length; i += 1) {
        if (incoming.hasOwnProperty(keys[i])) out[group][keys[i]] = !!incoming[keys[i]];
      }
    }
    return out;
  }

  function filterOfRecord(record) {
    var filter = activeFilter;
    var type = typeBucket(record);
    if (type && filter.types[type] === false) return false;
    if (filter.status[statusBucket(record)] === false) return false;
    if (filter.origin[originBucket(record)] === false) return false;
    return true;
  }

  function buildDataset(predicate) {
    var visible = typeof predicate === "function" ? predicate : function (record) {
      return activeFilter ? filterOfRecord(record) : true;
    };
    var allIds = Object.keys(nodesById);
    var ids = [];
    var keyOf = {};
    var links = {};
    var nodes = {};
    var weights = {};
    var i;

    for (i = 0; i < allIds.length; i += 1) {
      var record = nodesById[allIds[i]];
      if (!visible(record)) continue;
      ids.push(allIds[i]);
      var key = String(record.key);
      keyOf[allIds[i]] = key;
      links[key] = {};
    }

    var pairs = Object.keys(edgesByPair);
    var numLinks = 0;
    for (i = 0; i < pairs.length; i += 1) {
      var parts = pairs[i].split("\u0000");
      var srcKey = keyOf[parts[0]];
      var dstKey = keyOf[parts[1]];
      if (srcKey === undefined || dstKey === undefined) continue;
      links[srcKey][dstKey] = true;
      numLinks += 1;
    }

    for (i = 0; i < ids.length; i += 1) {
      var item = nodesById[ids[i]];
      var nodeKey = keyOf[ids[i]];
      var typeName = item.type == null ? "" : String(item.type);
      var node = {
        type: engineType(item.type),
        links: links[nodeKey]
      };
      if (groupColors && groupColors[typeName]) {
        node.color = groupColors[typeName];
      }
      nodes[nodeKey] = node;
      weights[nodeKey] = degreeOf(item);
    }

    return { nodes: nodes, numLinks: numLinks, weights: weights };
  }

  function applyLocalDataset() {
    if (!R) return;
    if (localState) {
      var local = buildLocalDataset(localState.key);
      if (local) {
        R.setData(local);
        return;
      }
      exitLocalGraph();
    }
    R.setData(buildDataset());
  }

  // -------------------------------------------------------------------------
  // stage 7: inspector + local subgraph hooks
  // -------------------------------------------------------------------------

  function requestNode(id) {
    send({ t: "node", id: id });
  }

  function buildLocalDataset(nodeKey) {
    if (!window.__obsidianGraph || typeof window.__obsidianGraph.buildLocalGraph !== "function") {
      return null;
    }
    var full = buildDataset();
    if (!full.nodes.hasOwnProperty(nodeKey)) return null;
    var local = window.__obsidianGraph.buildLocalGraph(full, {
      localFile: nodeKey,
      localJumps: 2,
      localInterlinks: true,
      localForelinks: true,
      localBacklinks: true
    });
    if (!local || !local.nodes) return null;
    return local;
  }

  function showGraphBack(visible) {
    var button = ensureGraphBack();
    if (!button) return;
    button.style.display = visible ? "inline-block" : "none";
  }

  function ensureGraphBack() {
    var button = document.getElementById("graph-back");
    if (button) return button;
    var topbar = document.getElementById("topbar");
    if (!topbar) return null;
    button = document.createElement("button");
    button.id = "graph-back";
    button.type = "button";
    button.textContent = "\u2190 global";
    button.title = "back to global graph";
    button.style.display = "none";
    button.addEventListener("click", function () {
      clearLocalGraph();
    });
    if (statusEl && statusEl.parentNode === topbar) topbar.insertBefore(button, statusEl);
    else topbar.appendChild(button);
    return button;
  }

  function setLocalGraph(nodeKey) {
    if (!R || nodeKey === undefined || nodeKey === null) return false;
    var key = String(nodeKey);
    var local = buildLocalDataset(key);
    if (!local) return false;
    R.setData(local);
    localState = { key: key };
    showGraphBack(true);
    return true;
  }

  function clearLocalGraph() {
    localState = null;
    showGraphBack(false);
    if (R) R.setData(buildDataset());
  }

  function exitLocalGraph() {
    localState = null;
    showGraphBack(false);
  }

  function isLocalGraph() {
    return !!localState;
  }

  function onNodeClick(evt, id) {
    var key = id === undefined || id === null ? "" : String(id);
    var nodeId = idsByKey.hasOwnProperty(key) ? idsByKey[key] : id;
    if (window.__inspector && typeof window.__inspector.select === "function") {
      window.__inspector.select(nodeId);
    }
    send({ t: "node", id: nodeId });
  }

  function ensureInspector() {
    if (window.__inspector) return;
    if (document.querySelector('script[src="inspector.js"], script[src$="/inspector.js"]')) return;
    var script = document.createElement("script");
    script.src = "inspector.js";
    script.async = false;
    script.onerror = function () {
      console.warn("[recon] inspector.js failed to load");
    };
    (document.body || document.documentElement).appendChild(script);
  }

  // -------------------------------------------------------------------------
  // stage 9: filter / render options
  // -------------------------------------------------------------------------

  function cloneFilter(filter) {
    return JSON.parse(JSON.stringify(filter));
  }

  function setFilter(filter) {
    activeFilter = normalizeFilter(filter);
    applyLocalDataset();
    if (R) {
      setStatus(
        R.nodes.length,
        countResolvedEdges(),
        lastStats.pending == null ? 0 : lastStats.pending
      );
    }
    return cloneFilter(activeFilter);
  }

  function getFilter() {
    return cloneFilter(activeFilter || normalizeFilter(null));
  }

  function setRenderOptions(opts) {
    renderOptions = opts && typeof opts === "object" ? opts : null;
    if (R && typeof R.setRenderOptions === "function") R.setRenderOptions(renderOptions || {});
    return renderOptions;
  }

  function setForces(opts) {
    forceOptions = opts && typeof opts === "object" ? opts : null;
    if (R && typeof R.setForces === "function") R.setForces(forceOptions || {});
    return forceOptions;
  }

  function filterCounts() {
    var counts = {
      types: {},
      status: {},
      origin: {},
      total: 0
    };
    var i;
    for (i = 0; i < FILTER_TYPES.length; i += 1) counts.types[FILTER_TYPES[i]] = 0;
    for (i = 0; i < FILTER_STATUS.length; i += 1) counts.status[FILTER_STATUS[i]] = 0;
    for (i = 0; i < FILTER_ORIGIN.length; i += 1) counts.origin[FILTER_ORIGIN[i]] = 0;

    var ids = Object.keys(nodesById);
    for (i = 0; i < ids.length; i += 1) {
      var record = nodesById[ids[i]];
      var type = typeBucket(record);
      if (type) counts.types[type] += 1;
      counts.status[statusBucket(record)] += 1;
      counts.origin[originBucket(record)] += 1;
      counts.total += 1;
    }
    return counts;
  }

  function setGroupColors(colors) {
    groupColors = null;
    if (colors && typeof colors === "object") {
      var out = {};
      var keys = Object.keys(colors);
      for (var i = 0; i < keys.length; i += 1) {
        var value = colors[keys[i]];
        if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
          /* The vendored renderer expects Node.color in its internal shape
           * {a: alpha, rgb: 0xRRGGBB}; getFillColor() returns it raw and
           * Node.initGraphics feeds .rgb straight into PIXI tint. A plain
           * "#rrggbb" string makes PIXI throw "Unable to convert color
           * undefined" and aborts initGraphics (leaving this.text null). */
          out[keys[i]] = { a: 1, rgb: parseInt(value.slice(1), 16) };
        }
      }
      groupColors = out;
    }
    applyLocalDataset();
    return groupColors;
  }

  // -------------------------------------------------------------------------
  // public API helpers
  // -------------------------------------------------------------------------

  function datasetNodeCount() {
    return R ? R.nodes.length : 0;
  }

  function nodeIds() {
    return Object.keys(R ? R.nodeLookup : {});
  }

  function positions() {
    var out = {};
    var nodes = R ? R.nodes : [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      out[node.id] = { x: node.x, y: node.y };
    }
    return out;
  }

  function objectIds() {
    var out = {};
    var nodes = R ? R.nodes : [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!objectIdMap.has(node)) {
        objectIdMap.set(node, nextObjectId);
        nextObjectId += 1;
      }
      out[node.id] = objectIdMap.get(node);
    }
    return out;
  }

  function edgeCount() {
    return countResolvedEdges();
  }

  function switchScan(id) {
    window.__reconLoads += 1;
    return readyPromise.then(function () {
      var scanId = Number(id);
      if (!isFinite(scanId) || scanId <= 0) {
        throw new Error("switchScan: invalid scan id");
      }
      var promise = new Promise(function (resolve, reject) {
        beginSwitch(scanId, resolve, reject);
      });
      // A superseded switch must not surface as an unhandled rejection.
      promise.catch(function () {});
      return promise;
    });
  }

  // -------------------------------------------------------------------------
  // scan lifecycle
  // -------------------------------------------------------------------------

  function startLoading(scanId) {
    gen += 1;
    loading = {
      scanId: scanId,
      gen: gen,
      sawFirst: false,
      awaitingPage: false,
      lastAfter: 0
    };
    return loading;
  }

  function beginSwitch(scanId, resolve, reject) {
    if (pendingSwitch && pendingSwitch.reject) {
      try {
        pendingSwitch.reject(new Error("switchScan superseded"));
      } catch (_err) {
        /* already settled */
      }
    }

    pendingSwitch = { gen: gen + 1, scanId: scanId, resolve: resolve, reject: reject };

    if (api.currentScanId != null) {
      send({ t: "close", scanId: api.currentScanId });
    }

    exitLocalGraph();
    resetLocal();
    api.currentScanId = scanId;
    pendingSwitch.gen = gen + 1;

    if (selectEl) {
      try {
        selectEl.value = String(scanId);
      } catch (_err) {
        /* option may be missing until the next scans frame */
      }
    }

    if (R) R.setData({ nodes: {}, numLinks: 0 });
    setStatus(0, 0, 0);
    startLoading(scanId);

    if (socket && socket.readyState === 1 && helloOk) {
      send({ t: "open", scanId: scanId, rev: 0 });
    }
    // Otherwise onHelloOk() opens the current scan after reconnect.
  }

  function openInitial(scanId) {
    api.currentScanId = scanId;
    if (selectEl) {
      try {
        selectEl.value = String(scanId);
      } catch (_err) {
        /* ignore */
      }
    }
    resetLocal();
    setStatus(0, 0, 0);
    startLoading(scanId);
    send({ t: "open", scanId: scanId, rev: 0 });
  }

  function finalizeLoad(scanId) {
    var finishedGen = loading ? loading.gen : null;
    loading = null;

    applyLocalDataset();
    setStatus(
      R ? R.nodes.length : localNodeCount(),
      countResolvedEdges(),
      lastStats.pending == null ? 0 : lastStats.pending
    );

    if (!readyDone) {
      readyDone = true;
      readyResolve();
    }

    if (
      pendingSwitch &&
      pendingSwitch.scanId === scanId &&
      pendingSwitch.gen === finishedGen
    ) {
      var pending = pendingSwitch;
      pendingSwitch = null;
      try {
        pending.resolve();
      } catch (_err) {
        /* already settled */
      }
    }
  }

  // -------------------------------------------------------------------------
  // WS protocol
  // -------------------------------------------------------------------------

  function wsUrl() {
    var scheme = location.protocol === "https:" ? "wss://" : "ws://";
    return scheme + location.host + "/ws";
  }

  function send(message) {
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      console.warn("[recon] ws send failed", err);
    }
  }

  function onHelloOk() {
    helloOk = true;
    retryAttempt = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    send({ t: "scans" });

    var scanId = api.currentScanId;
    if (scanId != null) {
      if (!loading || loading.scanId !== scanId) {
        resetLocal();
        startLoading(scanId);
      } else {
        // Mid-pagination reconnect: restart the snapshot flow. Accumulated
        // nodes are harmless and the open snapshot covers the whole state.
        loading.sawFirst = false;
        loading.awaitingPage = false;
        loading.lastAfter = 0;
      }
      send({ t: "open", scanId: scanId, rev: 0 });
    }
  }

  function onScans(msg) {
    var items = Array.isArray(msg.items) ? msg.items : [];
    api.scans = items;
    fillScanSelect(items);

    if (api.currentScanId == null && items.length > 0) {
      var first = items[0];
      if (first && Number.isSafeInteger(Number(first.id)) && Number(first.id) > 0) {
        openInitial(Number(first.id));
      }
    }
  }

  function fillScanSelect(items) {
    if (!selectEl) return;
    while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);

    for (var i = 0; i < items.length; i += 1) {
      var item = items[i] || {};
      var id = item.id == null ? "" : String(item.id);
      var target = item.target == null ? "" : String(item.target);
      var status = item.status == null ? "" : String(item.status);
      var option = document.createElement("option");
      option.value = id;
      option.textContent = "#" + id + " " + target + " (" + status + ")";
      selectEl.appendChild(option);
    }

    if (api.currentScanId != null) {
      try {
        selectEl.value = String(api.currentScanId);
      } catch (_err) {
        /* ignore */
      }
    }
  }

  function onSnapshot(msg) {
    var scanId = Number(msg.scanId);
    if (!loading || loading.scanId !== scanId || api.currentScanId !== scanId) return;

    if (loading.sawFirst && loading.awaitingPage) {
      loading.awaitingPage = false;
    } else {
      // First page, or a fresh open response (same-scan switch / reconnect
      // where an older reply was still in flight): restart pagination.
      loading.sawFirst = true;
      loading.lastAfter = 0;
    }

    var nodes = Array.isArray(msg.nodes) ? msg.nodes : [];
    mergeNodes(nodes);
    mergeEdges(msg.edges);

    var count = nodes.length;
    if (count >= PAGE_LIMIT) {
      var last = nodes[count - 1];
      var after = last && last.id != null ? Number(last.id) : NaN;
      if (!isFinite(after) || after <= loading.lastAfter) {
        finalizeLoad(scanId);
        return;
      }
      loading.lastAfter = after;
      loading.awaitingPage = true;
      send({ t: "page", scanId: scanId, after: after, limit: PAGE_LIMIT });
      return;
    }

    finalizeLoad(scanId);
  }

  function onDelta(msg) {
    var scanId = Number(msg.scanId);
    if (scanId !== api.currentScanId) return;

    mergeNodes(msg.nodes);
    mergeEdges(msg.edges);

    var pending = lastStats.pending == null ? 0 : lastStats.pending;
    if (loading && loading.scanId === scanId) {
      // Full snapshot is still in flight; merge only.
      setStatus(localNodeCount(), countResolvedEdges(), pending);
      return;
    }

    applyLocalDataset();
    setStatus(
      R ? R.nodes.length : localNodeCount(),
      countResolvedEdges(),
      pending
    );
  }

  function onProgress(msg) {
    var scanId = Number(msg.scanId);
    if (scanId !== api.currentScanId) return;
    if (msg.stats && typeof msg.stats === "object") lastStats = msg.stats;

    setStatus(
      lastStats.nodes == null ? localNodeCount() : lastStats.nodes,
      lastStats.edges == null ? countResolvedEdges() : lastStats.edges,
      lastStats.pending
    );
  }

  function onServerError(msg) {
    console.warn("[recon] server error", msg);
    if (msg && msg.code === "no-scan" && pendingSwitch) {
      var pending = pendingSwitch;
      pendingSwitch = null;
      try {
        pending.reject(new Error("scan not found: " + pending.scanId));
      } catch (_err) {
        /* already settled */
      }
    }
  }

  function onMessage(event) {
    var msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch (err) {
      console.warn("[recon] bad ws json", err);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    lastMsg = msg;

    switch (msg.t) {
      case "hello":
        if (msg.ok) onHelloOk();
        return;
      case "scans":
        onScans(msg);
        return;
      case "snapshot":
        onSnapshot(msg);
        return;
      case "delta":
        onDelta(msg);
        return;
      case "progress":
        onProgress(msg);
        return;
      case "node":
        if (window.__inspector && typeof window.__inspector.onNodePayload === "function") {
          window.__inspector.onNodePayload(msg);
        }
        return;
      case "action":
        if (window.__inspector && typeof window.__inspector.onActionPayload === "function") {
          window.__inspector.onActionPayload(msg);
        }
        return;
      case "error":
        onServerError(msg);
        if (window.__inspector && typeof window.__inspector.onServerError === "function") {
          window.__inspector.onServerError(msg);
        }
        return;
      default:
        // search replies belong to stage 8; keep lastMessage.
        return;
    }
  }

  function scheduleReconnect() {
    if (pageClosed || retryTimer) return;
    var delay = RECONNECT_DELAYS[Math.min(retryAttempt, RECONNECT_DELAYS.length - 1)];
    retryAttempt += 1;
    showNotice("disconnected" + SEP + "retrying in " + delay + " ms");
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (pageClosed) return;

    var ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (err) {
      console.warn("[recon] ws create failed", err);
      scheduleReconnect();
      return;
    }

    socket = ws;
    helloOk = false;

    ws.onopen = function () {
      if (socket !== ws) return;
      send({ t: "hello", proto: 1 });
    };

    ws.onmessage = function (event) {
      if (socket !== ws) return;
      onMessage(event);
    };

    ws.onerror = function () {
      console.warn("[recon] ws error");
    };

    ws.onclose = function () {
      if (socket !== ws) return;
      socket = null;
      helloOk = false;
      if (!pageClosed) {
        showNotice("disconnected" + SEP + "reconnecting");
        scheduleReconnect();
      }
    };
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  function init() {
    statusEl = document.getElementById("status");
    errorEl = document.getElementById("error");
    selectEl = document.getElementById("scan-select");

    var graphEl = document.getElementById("graph");
    if (!graphEl) throw new Error("#graph container missing");

    window.__obsidianHost = true;

    R = new window.__obsidianGraph.Renderer(
      graphEl,
      false,
      false,
      new Worker("vendor/sim.js", { name: "Graph Worker" })
    );
    api.renderer = R;
    window.__graph = R;

    R.onNodeClick = onNodeClick;

    R.setData({ nodes: {}, numLinks: 0 });
    if (renderOptions && typeof R.setRenderOptions === "function") {
      R.setRenderOptions(renderOptions);
    }
    if (forceOptions && typeof R.setForces === "function") {
      R.setForces(forceOptions);
    }
    setStatus(0, 0, 0);

    if (selectEl) {
      selectEl.addEventListener("change", function () {
        var value = Number(selectEl.value);
        if (!isFinite(value) || value <= 0) return;
        if (value === api.currentScanId) return;
        switchScan(value).catch(function (err) {
          console.warn("[recon] switch failed", err);
        });
      });
    }

    ensureGraphBack();
    ensureInspector();
    connect();
  }

  var startedAt = Date.now();
  var started = false;

  function poll() {
    if (started) return;
    if (
      window.PIXI &&
      window.__obsidianGraph &&
      document.getElementById("graph")
    ) {
      started = true;
      try {
        init();
      } catch (err) {
        showFatal(err);
      }
      return;
    }
    if (Date.now() - startedAt > 5000) {
      showFatal(
        new Error("timed out waiting for window.PIXI, window.__obsidianGraph and #graph")
      );
      return;
    }
    setTimeout(poll, 50);
  }

  window.addEventListener("beforeunload", function () {
    pageClosed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (socket) {
      try {
        socket.close();
      } catch (_err) {
        /* ignore */
      }
    }
  });

  poll();
})();
