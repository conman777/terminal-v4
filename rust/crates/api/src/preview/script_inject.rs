/// Inject the preview debug script into an HTML response body.
/// The script captures console logs, errors, and posts them back to the API.
pub fn inject_debug_script(html: &str, port: u16, api_origin: &str) -> String {
    let script = format!(
        r#"<script data-preview-debug="true">
(function() {{
  var port = {port};
  var apiOrigin = "{api_origin}";
  var batch = [];
  var flushTimer = null;

  function flush() {{
    if (batch.length === 0) return;
    var items = batch.splice(0, batch.length);
    try {{
      fetch(apiOrigin + "/api/preview/" + port + "/logs", {{
        method: "POST",
        headers: {{ "Content-Type": "application/json" }},
        body: JSON.stringify(items)
      }}).catch(function() {{}});
    }} catch(e) {{}}
  }}

  function log(type, level, msg) {{
    batch.push({{
      id: Math.random().toString(36).slice(2),
      type: type,
      level: level,
      message: typeof msg === "string" ? msg : JSON.stringify(msg),
      timestamp: Date.now()
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
}})();
</script>"#
    );

    // Insert before </head> if present, otherwise before </body>, otherwise at end
    if let Some(pos) = html.to_lowercase().find("</head>") {
        let mut result = html.to_string();
        result.insert_str(pos, &script);
        result
    } else if let Some(pos) = html.to_lowercase().find("</body>") {
        let mut result = html.to_string();
        result.insert_str(pos, &script);
        result
    } else {
        format!("{html}{script}")
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
    fn is_html_detects_types() {
        assert!(is_html_content_type("text/html; charset=utf-8"));
        assert!(is_html_content_type("TEXT/HTML"));
        assert!(!is_html_content_type("application/json"));
        assert!(!is_html_content_type("text/css"));
    }
}
