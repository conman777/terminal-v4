/// Inject the preview debug script into an HTML response body.
/// The script captures console logs, errors, and posts them back to the API.
pub fn inject_debug_script(html: &str, port: u16, api_origin: &str) -> String {
    inject_debug_script_with_options(html, port, api_origin, None)
}

pub fn inject_debug_script_with_options(
    html: &str,
    port: u16,
    api_origin: &str,
    preview_base_path: Option<&str>,
) -> String {
    let preview_base_path = preview_base_path.unwrap_or("");
    let base_tag = if !preview_base_path.is_empty() && !html.to_ascii_lowercase().contains("<base")
    {
        let mut href = preview_base_path.to_string();
        if !href.ends_with('/') {
            href.push('/');
        }
        format!(r#"<base href="{href}">"#)
    } else {
        String::new()
    };
    let script = format!(
        r#"<script data-preview-debug="true">
(function() {{
  var port = {port};
  var apiOrigin = "{api_origin}";
  var previewBasePath = "{preview_base_path}";
  var batch = [];
  var flushTimer = null;
  var storageSyncTimer = null;

  function apiUrl(path) {{
    return apiOrigin + path;
  }}

  function postToParent(payload) {{
    try {{
      window.parent.postMessage(payload, "*");
    }} catch (e) {{}}
  }}

  function stripPreviewBase(pathname) {{
    if (!previewBasePath) return pathname || "/";
    if (pathname.indexOf(previewBasePath) === 0) {{
      var stripped = pathname.slice(previewBasePath.length);
      if (!stripped) return "/";
      return stripped.charAt(0) === "/" ? stripped : "/" + stripped;
    }}
    return pathname || "/";
  }}

  function withPreviewBase(pathname) {{
    var path = pathname || "/";
    if (!previewBasePath) return path;
    if (path === previewBasePath || path.indexOf(previewBasePath + "/") === 0) {{
      return path;
    }}
    return path.charAt(0) === "/" ? previewBasePath + path : previewBasePath + "/" + path;
  }}

  function isLocalPreviewHost(hostname, targetPort) {{
    if (!hostname) return false;
    var normalized = String(hostname).toLowerCase();
    if (normalized !== "localhost" && normalized !== "127.0.0.1" && normalized !== "0.0.0.0" && normalized !== "::1") {{
      return false;
    }}
    return !targetPort || String(targetPort) === String(port);
  }}

  function rewriteWebSocketUrl(rawUrl) {{
    if (!previewBasePath || rawUrl == null) return rawUrl;
    try {{
      var parsed = new URL(String(rawUrl), window.location.href);
      var sameOrigin = parsed.origin === window.location.origin;
      var localTarget = isLocalPreviewHost(parsed.hostname, parsed.port);
      if (!sameOrigin && !localTarget) {{
        return rawUrl;
      }}
      if (parsed.pathname.indexOf("/api/") === 0 && parsed.pathname.indexOf(previewBasePath) !== 0) {{
        return rawUrl;
      }}
      var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return protocol + "//" + window.location.host + withPreviewBase(parsed.pathname || "/") + parsed.search + parsed.hash;
    }} catch (e) {{
      return rawUrl;
    }}
  }}

  function serializeValue(value) {{
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof Error) return value.stack || value.message || String(value);
    try {{
      return JSON.stringify(value, null, 2);
    }} catch (e) {{
      return String(value);
    }}
  }}

  function flush() {{
    if (batch.length === 0) return;
    var items = batch.splice(0, batch.length);
    try {{
      fetch(apiUrl("/api/preview/" + port + "/logs"), {{
        method: "POST",
        headers: {{ "Content-Type": "application/json" }},
        body: JSON.stringify(items)
      }}).catch(function() {{}});
    }} catch(e) {{}}
  }}

  function log(type, level, msg) {{
    var entry = {{
      id: Math.random().toString(36).slice(2),
      type: type,
      level: level,
      message: serializeValue(msg),
      timestamp: Date.now()
    }};
    batch.push(entry);
    postToParent({{
      type: "preview-" + type,
      level: level,
      message: entry.message,
      timestamp: entry.timestamp
    }});
    if (!flushTimer) flushTimer = setTimeout(function() {{ flushTimer = null; flush(); }}, 100);
  }}

  var origLog = console.log, origWarn = console.warn, origError = console.error, origInfo = console.info;
  console.log = function() {{ log("console","log",Array.from(arguments).join(" ")); origLog.apply(console, arguments); }};
  console.warn = function() {{ log("console","warn",Array.from(arguments).join(" ")); origWarn.apply(console, arguments); }};
  console.error = function() {{ log("console","error",Array.from(arguments).join(" ")); origError.apply(console, arguments); }};
  console.info = function() {{ log("console","info",Array.from(arguments).join(" ")); origInfo.apply(console, arguments); }};

  window.addEventListener("error", function(e) {{ log("error","error",e.message + " at " + e.filename + ":" + e.lineno); }});
  window.addEventListener("unhandledrejection", function(e) {{ log("error","error","Unhandled: " + (e.reason || e)); }});

  function reportLocation() {{
    postToParent({{
      type: "preview-location",
      url: "http://localhost:" + port + stripPreviewBase(location.pathname) + location.search + location.hash
    }});
  }}

  function wrapHistoryMethod(name) {{
    var original = history[name];
    if (typeof original !== "function") return;
    history[name] = function() {{
      var result = original.apply(this, arguments);
      reportLocation();
      return result;
    }};
  }}

  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");
  window.addEventListener("popstate", reportLocation);
  window.addEventListener("hashchange", reportLocation);
  window.addEventListener("load", reportLocation);

  if (previewBasePath && typeof window.WebSocket === "function") {{
    var OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {{
      var rewrittenUrl = rewriteWebSocketUrl(url);
      if (protocols !== undefined) {{
        return new OriginalWebSocket(rewrittenUrl, protocols);
      }}
      return new OriginalWebSocket(rewrittenUrl);
    }};
    for (var key in OriginalWebSocket) {{
      try {{
        window.WebSocket[key] = OriginalWebSocket[key];
      }} catch (e) {{}}
    }}
    window.WebSocket.prototype = OriginalWebSocket.prototype;
  }}

  function snapshotStorage(storage) {{
    var out = {{}};
    try {{
      for (var i = 0; i < storage.length; i++) {{
        var key = storage.key(i);
        if (key) {{
          out[key] = storage.getItem(key);
        }}
      }}
    }} catch (e) {{}}
    return out;
  }}

  function sendStorageSync() {{
    postToParent({{
      type: "preview-storage-sync",
      port: port,
      local: typeof localStorage !== "undefined" ? snapshotStorage(localStorage) : {{}},
      session: typeof sessionStorage !== "undefined" ? snapshotStorage(sessionStorage) : {{}}
    }});
  }}

  function scheduleStorageSync() {{
    if (storageSyncTimer) clearTimeout(storageSyncTimer);
    storageSyncTimer = setTimeout(function() {{
      storageSyncTimer = null;
      sendStorageSync();
    }}, 100);
  }}

  function instrumentStorage(storage) {{
    if (!storage) return;
    try {{
      var originalSet = storage.setItem;
      var originalRemove = storage.removeItem;
      var originalClear = storage.clear;
      storage.setItem = function() {{
        var result = originalSet.apply(this, arguments);
        scheduleStorageSync();
        return result;
      }};
      storage.removeItem = function() {{
        var result = originalRemove.apply(this, arguments);
        scheduleStorageSync();
        return result;
      }};
      storage.clear = function() {{
        var result = originalClear.apply(this, arguments);
        scheduleStorageSync();
        return result;
      }};
    }} catch (e) {{}}
  }}

  function applyStorageSnapshot(storage, snapshot) {{
    if (!storage || !snapshot || typeof snapshot !== "object") return;
    try {{
      Object.keys(snapshot).forEach(function(key) {{
        storage.setItem(key, snapshot[key]);
      }});
    }} catch (e) {{}}
  }}

  function applyStorageOperation(payload) {{
    var storage = payload.storageType === "sessionStorage" ? sessionStorage : localStorage;
    if (payload.storageType === "cookies") {{
      try {{
        if (payload.operation === "set" && payload.key) {{
          document.cookie = payload.key + "=" + encodeURIComponent(payload.value || "") + "; path=/";
        }} else if (payload.operation === "remove" && payload.key) {{
          document.cookie = payload.key + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
        }} else if (payload.operation === "clear") {{
          document.cookie.split(";").forEach(function(item) {{
            var name = item.split("=")[0];
            if (name) {{
              document.cookie = name.trim() + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
            }}
          }});
        }}
      }} catch (e) {{}}
      scheduleStorageSync();
      return;
    }}

    if (!storage) return;
    try {{
      if (payload.operation === "set" && payload.key) {{
        storage.setItem(payload.key, payload.value || "");
      }} else if (payload.operation === "remove" && payload.key) {{
        storage.removeItem(payload.key);
      }} else if (payload.operation === "clear") {{
        storage.clear();
      }} else if (payload.operation === "import" && payload.entries) {{
        Object.keys(payload.entries).forEach(function(key) {{
          storage.setItem(key, payload.entries[key]);
        }});
      }}
    }} catch (e) {{}}
    scheduleStorageSync();
  }}

  var metricsBuffer = [];
  var metricsFlushTimer = null;

  function sendMetrics(metrics) {{
    if (!metrics || metrics.length === 0) return;
    try {{
      fetch(apiUrl("/api/preview/" + port + "/performance"), {{
        method: "POST",
        headers: {{ "Content-Type": "application/json" }},
        body: JSON.stringify({{ metrics: metrics }})
      }}).catch(function() {{}});
    }} catch (e) {{}}
  }}

  function flushMetrics() {{
    if (metricsBuffer.length === 0) return;
    var items = metricsBuffer.splice(0, metricsBuffer.length);
    sendMetrics(items);
  }}

  function scheduleMetricsFlush() {{
    if (metricsFlushTimer) return;
    metricsFlushTimer = setTimeout(function() {{
      metricsFlushTimer = null;
      flushMetrics();
    }}, 2000);
  }}

  function trackMetric(type, data) {{
    metricsBuffer.push({{
      type: type,
      timestamp: Date.now(),
      data: data
    }});
    scheduleMetricsFlush();
  }}

  try {{
    var lcpObserver = new PerformanceObserver(function(list) {{
      var entries = list.getEntries();
      var lastEntry = entries[entries.length - 1];
      if (!lastEntry) return;
      trackMetric("coreWebVitals", {{
        lcp: lastEntry.renderTime || lastEntry.loadTime || null,
        fid: null,
        cls: null
      }});
    }});
    lcpObserver.observe({{ type: "largest-contentful-paint", buffered: true }});
  }} catch (e) {{}}

  try {{
    var fidObserver = new PerformanceObserver(function(list) {{
      list.getEntries().forEach(function(entry) {{
        trackMetric("coreWebVitals", {{
          lcp: null,
          fid: entry.processingStart - entry.startTime,
          cls: null
        }});
      }});
    }});
    fidObserver.observe({{ type: "first-input", buffered: true }});
  }} catch (e) {{}}

  try {{
    var clsValue = 0;
    var clsObserver = new PerformanceObserver(function(list) {{
      list.getEntries().forEach(function(entry) {{
        if (!entry.hadRecentInput) {{
          clsValue += entry.value;
        }}
      }});
      trackMetric("coreWebVitals", {{
        lcp: null,
        fid: null,
        cls: clsValue
      }});
    }});
    clsObserver.observe({{ type: "layout-shift", buffered: true }});
  }} catch (e) {{}}

  window.addEventListener("load", function() {{
    setTimeout(function() {{
      try {{
        var navTiming = performance.getEntriesByType("navigation")[0];
        if (!navTiming) return;
        trackMetric("loadMetrics", {{
          domContentLoaded: navTiming.domContentLoadedEventEnd - navTiming.domContentLoadedEventStart,
          fullPageLoad: navTiming.loadEventEnd - navTiming.loadEventStart,
          timeToInteractive: navTiming.domInteractive - navTiming.fetchStart
        }});
      }} catch (e) {{}}
    }}, 0);
  }});

  var frameCount = 0;
  var lastFpsReport = performance.now();

  function measureRuntimeMetrics() {{
    var now = performance.now();
    frameCount += 1;

    if (now - lastFpsReport >= 1000) {{
      var runtimeData = {{
        fps: frameCount * 1000 / (now - lastFpsReport),
        memory: null,
        longTasks: []
      }};

      if (performance.memory) {{
        runtimeData.memory = {{
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
        }};
      }}

      trackMetric("runtimeMetrics", runtimeData);
      frameCount = 0;
      lastFpsReport = now;
    }}

    requestAnimationFrame(measureRuntimeMetrics);
  }}

  requestAnimationFrame(measureRuntimeMetrics);

  try {{
    var longTaskObserver = new PerformanceObserver(function(list) {{
      var longTasks = list.getEntries().map(function(entry) {{
        return {{
          startTime: entry.startTime,
          duration: entry.duration
        }};
      }});
      if (longTasks.length === 0) return;
      trackMetric("runtimeMetrics", {{
        fps: null,
        memory: null,
        longTasks: longTasks
      }});
    }});
    longTaskObserver.observe({{ type: "longtask", buffered: true }});
  }} catch (e) {{}}

  window.addEventListener("message", function(event) {{
    var payload = event.data || {{}};
    if (payload.type === "preview-storage-restore" && String(payload.port) === String(port)) {{
      applyStorageSnapshot(typeof localStorage !== "undefined" ? localStorage : null, payload.local);
      applyStorageSnapshot(typeof sessionStorage !== "undefined" ? sessionStorage : null, payload.session);
      scheduleStorageSync();
      return;
    }}
    if (payload.type === "preview-storage-operation") {{
      applyStorageOperation(payload);
      return;
    }}
    if (payload.type === "preview-clear-storage") {{
      try {{ if (typeof localStorage !== "undefined") localStorage.clear(); }} catch (e) {{}}
      try {{ if (typeof sessionStorage !== "undefined") sessionStorage.clear(); }} catch (e) {{}}
      scheduleStorageSync();
      return;
    }}
    if (payload.type === "preview-evaluate" && typeof payload.expression === "string") {{
      try {{
        var result = (0, eval)(payload.expression);
        log("console", "log", result);
      }} catch (e) {{
        log("error", "error", e && e.stack ? e.stack : String(e));
      }}
    }}
  }});

  instrumentStorage(typeof localStorage !== "undefined" ? localStorage : null);
  instrumentStorage(typeof sessionStorage !== "undefined" ? sessionStorage : null);
  postToParent({{ type: "preview-storage-request", port: port }});
  sendStorageSync();
  window.addEventListener("beforeunload", flushMetrics);
  window.addEventListener("pagehide", flushMetrics);
}})();
</script>"#
    );

    let mut payload = format!("{base_tag}{script}");

    // Insert before </head> if present, otherwise before </body>, otherwise at end
    if let Some(pos) = html.to_lowercase().find("</head>") {
        let mut result = html.to_string();
        result.insert_str(pos, &payload);
        result
    } else if let Some(pos) = html.to_lowercase().find("</body>") {
        let mut result = html.to_string();
        result.insert_str(pos, &payload);
        result
    } else {
        payload.insert_str(0, html);
        payload
    }
}

/// Check if a response content-type is HTML.
pub fn is_html_content_type(content_type: &str) -> bool {
    let lower = content_type.to_lowercase();
    lower.contains("text/html") || lower.contains("application/xhtml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_before_head_close() {
        let html = "<html><head><title>Test</title></head><body></body></html>";
        let result = inject_debug_script(html, 3000, "http://localhost:3020");
        assert!(result.contains("data-preview-debug"));
        assert!(result.find("data-preview-debug").unwrap() < result.find("</head>").unwrap());
    }

    #[test]
    fn inject_before_body_close_when_no_head() {
        let html = "<html><body><p>Hi</p></body></html>";
        let result = inject_debug_script(html, 3000, "http://localhost:3020");
        assert!(result.contains("data-preview-debug"));
    }

    #[test]
    fn injects_websocket_rewrite_support_for_path_preview() {
        let html = "<html><head></head><body></body></html>";
        let result = inject_debug_script_with_options(
            html,
            5173,
            "http://localhost:3020",
            Some("/preview/5173"),
        );
        assert!(result.contains("rewriteWebSocketUrl"));
        assert!(result.contains("window.WebSocket = function(url, protocols)"));
        assert!(result.contains(r#"var previewBasePath = "/preview/5173";"#));
    }

    #[test]
    fn injects_authenticated_log_and_performance_reporting() {
        let html = "<html><head></head><body></body></html>";
        let result = inject_debug_script(html, 5173, "http://localhost:3020");

        assert!(result.contains(r#"fetch(apiUrl("/api/preview/" + port + "/logs")"#));
        assert!(result.contains(r#"fetch(apiUrl("/api/preview/" + port + "/performance")"#));
        assert!(result.contains(r#"trackMetric("runtimeMetrics""#));
    }

    #[test]
    fn is_html_detects_types() {
        assert!(is_html_content_type("text/html; charset=utf-8"));
        assert!(is_html_content_type("TEXT/HTML"));
        assert!(!is_html_content_type("application/json"));
        assert!(!is_html_content_type("text/css"));
    }
}
