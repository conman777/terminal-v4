(function () {
  if (window.__previewInspectorLoaded) return;
  window.__previewInspectorLoaded = true;

  var enabled = false;
  var selected = null;
  var hovered = null;
  var nextId = 0;
  var ids = new WeakMap();
  var preview = null;
  var originalCursor = null;
  var previewEpoch = null;
  var styleProperties = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'textAlign', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'border', 'borderRadius', 'boxShadow', 'opacity', 'zIndex', 'flexDirection', 'justifyContent', 'alignItems', 'gap'];

  function send(type, element) {
    window.parent.postMessage({ type: type, element: element, previewEpoch: previewEpoch }, '*');
  }

  function indicator(name, border) {
    var node = document.createElement('div');
    node.id = '__preview-inspector-' + name;
    node.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;display:none;background:rgba(59,130,246,.1);border:' + border;
    document.documentElement.appendChild(node);
    return node;
  }

  var overlay = indicator('overlay', '1px solid #3b82f6');
  var selection = indicator('selection', '1px dashed #60a5fa');

  function highlight(node, target) {
    if (!target || !target.isConnected) { node.style.display = 'none'; return; }
    var rect = target.getBoundingClientRect();
    Object.assign(node.style, { display: 'block', top: rect.top + 'px', left: rect.left + 'px', width: rect.width + 'px', height: rect.height + 'px', boxSizing: 'border-box' });
  }

  function selector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    for (var current = el; current && current.nodeType === 1; current = current.parentElement) {
      if (current.id) { parts.unshift('#' + CSS.escape(current.id)); break; }
      var part = current.tagName.toLowerCase();
      if (current.parentElement) {
        var siblings = Array.from(current.parentElement.children).filter(function (child) { return child.tagName === current.tagName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function reactInfo(el) {
    try {
      var key = Object.keys(el).find(function (key) { return key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0; });
      var fiber = key && el[key];
      for (var depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
        var type = fiber.type;
        var name = type && (typeof type === 'function' || typeof type === 'object') && (type.displayName || type.name);
        if (typeof name !== 'string' || !name) continue;
        var props = {};
        Object.keys(fiber.memoizedProps || {}).forEach(function (key) {
          if (key === 'children' || key.indexOf('__') === 0) return;
          var value = fiber.memoizedProps[key];
          props[key] = typeof value === 'function' ? '[Function]' : typeof value === 'symbol' ? String(value) : value && typeof value === 'object' ? '[Object]' : value;
        });
        var source = fiber._debugSource || type.__source || {};
        return { componentName: name, props: props, filePath: source.fileName || null, lineNumber: source.lineNumber || null };
      }
    } catch (_) {}
    return null;
  }

  function info(el) {
    if (!ids.has(el)) ids.set(el, '__pi_' + (++nextId));
    var rect = el.getBoundingClientRect();
    var computed = window.getComputedStyle(el);
    var styles = {};
    styleProperties.forEach(function (property) { styles[property] = computed[property]; });
    var attributes = {};
    Array.from(el.attributes).forEach(function (attribute) { attributes[attribute.name] = attribute.value; });
    var parents = [];
    for (var current = el.parentElement; current && parents.length < 5; current = current.parentElement) {
      parents.push({ tagName: current.tagName.toLowerCase(), id: current.id || null, className: typeof current.className === 'string' ? current.className : '', selector: selector(current) });
    }
    var siblings = el.parentElement ? Array.from(el.parentElement.children) : [el];
    return {
      elementId: ids.get(el), tagName: el.tagName.toLowerCase(), id: el.id || null,
      className: typeof el.className === 'string' ? el.className : '',
      textContent: (el.textContent || '').trim().slice(0, 100), attributes: attributes,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      computedStyle: styles, extendedStyles: styles, selector: selector(el), fullSelector: selector(el),
      outerHTML: el.outerHTML.slice(0, 5000), parentChain: parents,
      siblings: { before: siblings.indexOf(el), after: siblings.length - siblings.indexOf(el) - 1, total: siblings.length }, react: reactInfo(el)
    };
  }

  function revert() {
    if (!preview) return;
    if (preview.style === null) preview.element.removeAttribute('style');
    else preview.element.setAttribute('style', preview.style);
    preview = null;
    highlight(selection, selected);
  }

  function setMode(value) {
    enabled = value === true;
    if (enabled && originalCursor === null) {
      originalCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'crosshair';
    } else if (!enabled && originalCursor !== null) {
      document.documentElement.style.cursor = originalCursor;
      originalCursor = null;
    }
    if (!enabled) { hovered = null; highlight(overlay, null); }
  }

  function selectable(target) {
    return target && target.nodeType === 1 && !target.id.startsWith('__preview-inspector-');
  }

  document.addEventListener('mousemove', function (event) {
    if (!enabled || !selectable(event.target)) return;
    hovered = event.target;
    highlight(overlay, hovered);
  }, true);
  document.addEventListener('click', function (event) {
    if (!enabled || !selectable(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    revert();
    selected = event.target;
    highlight(selection, selected);
    send('preview-element-selected', info(selected));
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { setMode(false); revert(); selected = null; highlight(selection, null); }
  }, true);

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data || {};
    if (data.type === 'preview-parent-ready' && typeof data.previewEpoch === 'string' && data.previewEpoch.length <= 100) {
      previewEpoch = data.previewEpoch;
    }
    else if (data.type === 'preview-inspect-mode') setMode(data.enabled);
    else if (data.type === 'preview-clear-selection') { revert(); selected = null; highlight(selection, null); }
    else if (data.type === 'preview-revert-style-preview') revert();
    else if (data.type === 'preview-request-detailed-info' && selected) send('preview-detailed-info', info(selected));
    else if (data.type === 'preview-apply-style-preview' && selected && ids.get(selected) === data.elementId && data.styles && typeof data.styles === 'object') {
      if (!preview) preview = { element: selected, style: selected.getAttribute('style') };
      Object.keys(data.styles).forEach(function (property) {
        if (typeof data.styles[property] !== 'string') return;
        var cssProperty = property.startsWith('--') ? property : property.replace(/[A-Z]/g, function (letter) { return '-' + letter.toLowerCase(); });
        selected.style.setProperty(cssProperty, data.styles[property]);
      });
      highlight(selection, selected);
    }
  });
  function refresh() { highlight(selection, selected); if (enabled) highlight(overlay, hovered); }
  window.addEventListener('scroll', refresh, true);
  window.addEventListener('resize', refresh);
  if (new URLSearchParams(window.location.search).get('__inspect') === '1') setMode(true);
  send('preview-inspector-ready');
})();
