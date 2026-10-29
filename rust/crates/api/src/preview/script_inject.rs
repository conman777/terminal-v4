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
    inject_debug_script_for_document(html, port, api_origin, preview_base_path, "/")
}

pub fn inject_debug_script_for_document(
    html: &str,
    port: u16,
    api_origin: &str,
    preview_base_path: Option<&str>,
    document_path: &str,
) -> String {
    let preview_base_path = preview_base_path.unwrap_or("");
    let base_tag = if !preview_base_path.is_empty() && !html.to_ascii_lowercase().contains("<base")
    {
        let path = document_path.split(['?', '#']).next().unwrap_or("/");
        let directory = path
            .rsplit_once('/')
            .map(|(directory, _)| directory)
            .unwrap_or("");
        let href = format!("{}{}/", preview_base_path.trim_end_matches('/'), directory)
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;");
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
  var previewDocumentGrant = new URL(location.href).searchParams.get("previewToken");
  var previewController = null;
  var previewEvaluationEnabled = {evaluation_enabled};
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
    if (window.parent !== window) {{
      postToParent({{ type: "preview-log-batch", port: port, documentUrl: location.href, documentGrant: previewDocumentGrant, entries: items }});
      return;
    }}
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

  function getPreviewStorage(name) {{
    try {{ return window[name] || null; }} catch (e) {{ return null; }}
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
      local: snapshotStorage(getPreviewStorage("localStorage")),
      session: snapshotStorage(getPreviewStorage("sessionStorage")),
      available: {{ localStorage: getPreviewStorage("localStorage") !== null, sessionStorage: getPreviewStorage("sessionStorage") !== null }}
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
    var storage = getPreviewStorage(payload.storageType === "sessionStorage" ? "sessionStorage" : "localStorage");
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
    if (window.parent !== window) {{
      postToParent({{ type: "preview-performance", port: port, documentUrl: location.href, documentGrant: previewDocumentGrant, metrics: metrics }});
      return;
    }}
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
    if (window.parent === window || event.source !== window.parent
        || !previewController || event.origin !== previewController.origin
        || Date.now() >= previewController.expiresAt * 1000) return;
    var payload = event.data || {{}};
    if (payload.type === "preview-storage-restore" && String(payload.port) === String(port)) {{
      applyStorageSnapshot(getPreviewStorage("localStorage"), payload.local);
      applyStorageSnapshot(getPreviewStorage("sessionStorage"), payload.session);
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
    if (payload.type === "preview-evaluate" && previewEvaluationEnabled && typeof payload.expression === "string") {{
      try {{
        var result = (0, eval)(payload.expression);
        log("console", "log", result);
      }} catch (e) {{
        log("error", "error", e && e.stack ? e.stack : String(e));
      }}
    }}
  }});

  instrumentStorage(getPreviewStorage("localStorage"));
  instrumentStorage(getPreviewStorage("sessionStorage"));
  postToParent({{ type: "preview-storage-request", port: port }});
  sendStorageSync();
  window.addEventListener("beforeunload", flushMetrics);
  window.addEventListener("pagehide", flushMetrics);
}})();
</script>"#,
        evaluation_enabled = crate::preview_eval_enabled(),
    );

    let inspector = include_str!("inspector.js");
    let mut payload =
        format!("{base_tag}{script}<script data-preview-inspector=\"true\">{inspector}</script>");

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

pub(crate) fn bind_controller(
    html: &str,
    controller: Option<&super::auth_urls::PreviewController>,
) -> String {
    let binding = serde_json::to_string(&controller)
        .expect("preview controller serializes")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    let pattern = regex_lite::Regex::new(r"(?m)^  var previewController = [^\r\n]*;$")
        .expect("static controller binding expression");
    pattern
        .replace_all(html, |_captures: &regex_lite::Captures<'_>| {
            format!("  var previewController = {binding};")
        })
        .into_owned()
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
    fn controller_binding_defaults_read_only_and_overwrites_remote_bindings() {
        let html = inject_debug_script("<html><head></head></html>", 5173, "http://localhost:3020");
        assert!(html.contains("var previewController = null;"));
        assert!(html.contains(&format!(
            "var previewEvaluationEnabled = {};",
            crate::preview_eval_enabled()
        )));
        let controller = super::super::auth_urls::PreviewController {
            origin: "http://localhost:5173".into(),
            expires_at: 2_000_000_000,
        };
        let bound = bind_controller(&html, Some(&controller));
        assert!(bound.contains(
            r#"var previewController = {"origin":"http://localhost:5173","expiresAt":2000000000};"#
        ));
        assert_eq!(bind_controller(&bound, None), html);
    }

    #[test]
    fn injects_inspector_and_style_message_contract() {
        let result =
            inject_debug_script("<html><head></head></html>", 5173, "http://localhost:3020");
        for contract in [
            "preview-inspector-ready",
            "preview-element-selected",
            "preview-apply-style-preview",
            "preview-revert-style-preview",
        ] {
            assert!(result.contains(contract), "missing {contract}");
        }
    }

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
    fn injects_parent_broker_for_opaque_frame_log_and_performance_reporting() {
        let html = "<html><head></head><body></body></html>";
        let result = inject_debug_script(html, 5173, "http://localhost:3020");

        assert!(result.contains(r#"fetch(apiUrl("/api/preview/" + port + "/logs")"#));
        assert!(result.contains(r#"fetch(apiUrl("/api/preview/" + port + "/performance")"#));
        assert!(result.contains(r#"trackMetric("runtimeMetrics""#));
        assert!(result.contains(r#"type: "preview-performance", port: port, documentUrl: location.href, documentGrant: previewDocumentGrant, metrics: metrics"#));
        assert!(result.contains(
            r#"type: "preview-log-batch", port: port, documentUrl: location.href, documentGrant: previewDocumentGrant, entries: items"#
        ));
    }

    #[test]
    fn is_html_detects_types() {
        assert!(is_html_content_type("text/html; charset=utf-8"));
        assert!(is_html_content_type("TEXT/HTML"));
        assert!(!is_html_content_type("application/json"));
        assert!(!is_html_content_type("text/css"));
    }
}
