// Inspector script to be injected into previewed pages
// This enables element selection similar to browser DevTools

export const INSPECTOR_SCRIPT = `
(function() {
  if (window.__previewInspectorLoaded) return;
  window.__previewInspectorLoaded = true;

  let inspectMode = false;
  let hoveredElement = null;
  let selectedElement = null;
  let hoverTimeout = null;
  let lastHoverTime = 0;

  // Create overlay for highlighting
  const overlay = document.createElement('div');
  overlay.id = '__preview-inspector-overlay';
  overlay.style.cssText = 'position: fixed; pointer-events: none; z-index: 2147483647; border: 1px solid #3b82f6; background: rgba(59, 130, 246, 0.12); border-radius: 4px; display: none; transition: all 0.05s ease-out;';
  document.documentElement.appendChild(overlay);

  // Create tooltip for element info
  const tooltip = document.createElement('div');
  tooltip.id = '__preview-inspector-tooltip';
  tooltip.style.cssText = 'position: fixed; pointer-events: none; z-index: 2147483647; background: #0f172a; color: #e2e8f0; padding: 4px 8px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 11px; white-space: nowrap; display: none; border: 1px solid rgba(148, 163, 184, 0.2); box-shadow: 0 8px 20px rgba(0,0,0,0.35);';
  document.documentElement.appendChild(tooltip);

  // Create "Send to Terminal" button that appears after hover delay
  const sendButton = document.createElement('button');
  sendButton.id = '__preview-inspector-send-btn';
  sendButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg> Send to Terminal';
  sendButton.style.cssText = "position: fixed; z-index: 2147483647; background: #0f172a; color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 6px; padding: 6px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; font-weight: 600; cursor: pointer; display: none; align-items: center; gap: 6px; box-shadow: 0 8px 20px rgba(0,0,0,0.35); transition: background 0.15s, transform 0.15s, border-color 0.15s, color 0.15s;";
  sendButton.addEventListener('mouseenter', () => {
    sendButton.style.background = '#111827';
    sendButton.style.borderColor = 'rgba(59, 130, 246, 0.6)';
    sendButton.style.transform = 'translateY(-1px)';
  });
  sendButton.addEventListener('mouseleave', () => {
    sendButton.style.background = '#0f172a';
    sendButton.style.borderColor = 'rgba(148, 163, 184, 0.2)';
    sendButton.style.color = '#e2e8f0';
    sendButton.style.transform = 'translateY(0)';
  });
  sendButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (hoveredElement) {
      const info = getElementInfo(hoveredElement);
      window.parent.postMessage({
        type: 'preview-send-to-terminal',
        element: info
      }, '*');
      // Flash feedback
      sendButton.style.background = '#22c55e';
      sendButton.style.borderColor = 'rgba(34, 197, 94, 0.6)';
      sendButton.style.color = '#0f172a';
      setTimeout(() => {
        sendButton.style.background = '#0f172a';
        sendButton.style.borderColor = 'rgba(148, 163, 184, 0.2)';
        sendButton.style.color = '#e2e8f0';
      }, 200);
    }
  });
  document.documentElement.appendChild(sendButton);

  // Create selection indicator (stays visible after click)
  const selection = document.createElement('div');
  selection.id = '__preview-inspector-selection';
  selection.style.cssText = 'position: fixed; pointer-events: none; z-index: 2147483646; border: 1px dashed #60a5fa; background: rgba(59, 130, 246, 0.08); border-radius: 4px; display: none;';
  document.documentElement.appendChild(selection);

  // Element ID counter for stable targeting
  let elementIdCounter = 0;
  const elementIdMap = new WeakMap();

  function getOrCreateElementId(el) {
    if (!elementIdMap.has(el)) {
      elementIdMap.set(el, '__pi_' + (++elementIdCounter));
    }
    return elementIdMap.get(el);
  }

  function getElementSelector(el) {
    if (el.id) return '#' + el.id;

    let selector = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('__preview'));
      if (classes.length > 0) {
        selector += '.' + classes.slice(0, 2).join('.');
      }
    }
    return selector;
  }

  // Get unique CSS selector path for element
  function getFullSelector(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector = '#' + current.id;
        parts.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('__preview'));
        if (classes.length > 0) {
          selector += '.' + classes.slice(0, 2).join('.');
        }
      }
      // Add nth-child if needed for uniqueness
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += ':nth-child(' + index + ')';
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  // Smart CSS selector generation with priority: ID > data-testid > class > path
  function getSmartCSSSelector(el) {
    // Priority 1: ID selector (most specific and stable)
    if (el.id && !el.id.startsWith('__preview')) {
      return '#' + el.id;
    }

    // Priority 2: data-testid (common in testing frameworks)
    if (el.hasAttribute('data-testid')) {
      return '[data-testid="' + el.getAttribute('data-testid') + '"]';
    }

    // Priority 3: Unique class combination
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('__preview'));
      if (classes.length > 0) {
        const classSelector = '.' + classes.join('.');
        // Check if this selector is unique
        try {
          if (document.querySelectorAll(classSelector).length === 1) {
            return classSelector;
          }
        } catch (e) {
          // Invalid selector, continue
        }
      }
    }

    // Priority 4: Full path selector
    return getFullSelector(el);
  }

  // Generate XPath for element
  function getXPath(el) {
    if (el.id && !el.id.startsWith('__preview')) {
      return '//*[@id="' + el.id + '"]';
    }

    const parts = [];
    let current = el;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 0;
      let sibling = current.previousSibling;

      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === current.nodeName) {
          index++;
        }
        sibling = sibling.previousSibling;
      }

      const tagName = current.nodeName.toLowerCase();
      const pathIndex = index > 0 ? '[' + (index + 1) + ']' : '';
      parts.unshift(tagName + pathIndex);

      current = current.parentNode;
    }

    return parts.length ? '/' + parts.join('/') : '';
  }

  // Generate JavaScript path for element (e.g., document.querySelector...)
  function getJSPath(el) {
    const selector = getSmartCSSSelector(el);
    // Escape quotes in selector
    const escapedSelector = selector.replace(/"/g, '\\\\"');
    return 'document.querySelector("' + escapedSelector + '")';
  }

  // Context menu for copying selectors
  const contextMenu = document.createElement('div');
  contextMenu.id = '__preview-inspector-context-menu';
  contextMenu.style.cssText = 'position: fixed; z-index: 2147483647; background: #0f172a; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; padding: 4px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12px; box-shadow: 0 8px 20px rgba(0,0,0,0.35); display: none; min-width: 180px;';
  document.documentElement.appendChild(contextMenu);

  let contextMenuElement = null;

  function showContextMenu(e, el) {
    e.preventDefault();
    e.stopPropagation();

    contextMenuElement = el;
    const cssSelector = getSmartCSSSelector(el);
    const xpath = getXPath(el);
    const jsPath = getJSPath(el);

    contextMenu.innerHTML = \`
      <div style="padding: 4px 0;">
        <button class="context-menu-item" data-action="copy-css" style="width: 100%; text-align: left; background: none; border: none; color: #e2e8f0; padding: 8px 12px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 8px; font-size: 12px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          Copy CSS Selector
        </button>
        <button class="context-menu-item" data-action="copy-xpath" style="width: 100%; text-align: left; background: none; border: none; color: #e2e8f0; padding: 8px 12px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 8px; font-size: 12px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          Copy XPath
        </button>
        <button class="context-menu-item" data-action="copy-js" style="width: 100%; text-align: left; background: none; border: none; color: #e2e8f0; padding: 8px 12px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 8px; font-size: 12px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          Copy JS Path
        </button>
      </div>
    \`;

    // Position context menu
    const menuWidth = 200;
    const menuHeight = 130;
    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 4;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 4;
    }

    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.style.display = 'block';

    // Add hover effects and click handlers
    const items = contextMenu.querySelectorAll('.context-menu-item');
    items.forEach(item => {
      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(59, 130, 246, 0.1)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none';
      });
      item.addEventListener('click', () => {
        const action = item.getAttribute('data-action');
        let textToCopy = '';

        if (action === 'copy-css') {
          textToCopy = cssSelector;
        } else if (action === 'copy-xpath') {
          textToCopy = xpath;
        } else if (action === 'copy-js') {
          textToCopy = jsPath;
        }

        // Copy to clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(textToCopy).then(() => {
            // Flash success feedback
            item.style.background = 'rgba(34, 197, 94, 0.2)';
            item.style.color = '#22c55e';
            setTimeout(() => {
              item.style.background = 'none';
              item.style.color = '#e2e8f0';
              hideContextMenu();
            }, 200);
          }).catch(() => {
            // Fallback for clipboard API failure
            hideContextMenu();
          });
        } else {
          // Fallback for older browsers
          const textarea = document.createElement('textarea');
          textarea.value = textToCopy;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          try {
            document.execCommand('copy');
            hideContextMenu();
          } catch (e) {
            console.error('Failed to copy:', e);
          }
          document.body.removeChild(textarea);
        }
      });
    });
  }

  function hideContextMenu() {
    contextMenu.style.display = 'none';
    contextMenuElement = null;
  }

  // Get parent chain for context
  function getParentChain(el, maxDepth = 5) {
    const chain = [];
    let current = el.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < maxDepth) {
      chain.push({
        tagName: current.tagName.toLowerCase(),
        id: current.id || null,
        className: typeof current.className === 'string' ? current.className : '',
        selector: getElementSelector(current)
      });
      current = current.parentElement;
      depth++;
    }
    return chain;
  }

  // Get sibling info
  function getSiblingInfo(el) {
    const parent = el.parentElement;
    if (!parent) return { before: 0, after: 0, total: 1 };
    const siblings = Array.from(parent.children);
    const index = siblings.indexOf(el);
    return {
      before: index,
      after: siblings.length - index - 1,
      total: siblings.length
    };
  }

  // Detect React component info
  function getReactInfo(el) {
    try {
      // Find React Fiber node
      const key = Object.keys(el).find(k =>
        k.startsWith('__reactFiber$') ||
        k.startsWith('__reactInternalInstance$')
      );
      if (!key) return null;

      const fiber = el[key];
      if (!fiber) return null;

      // Traverse fiber tree to find component
      let current = fiber;
      while (current) {
        const type = current.type;
        if (type && (typeof type === 'function' || typeof type === 'object')) {
          const name = type.displayName || type.name || null;
          if (name && name !== 'Anonymous' && !name.startsWith('_')) {
            const props = current.memoizedProps || {};
            // Filter out children and internal props
            const cleanProps = {};
            for (const [k, v] of Object.entries(props)) {
              if (k !== 'children' && !k.startsWith('__')) {
                if (typeof v === 'function') {
                  cleanProps[k] = '[Function]';
                } else if (typeof v === 'object' && v !== null) {
                  cleanProps[k] = Array.isArray(v) ? '[Array]' : '[Object]';
                } else {
                  cleanProps[k] = v;
                }
              }
            }
            return {
              componentName: name,
              props: cleanProps,
              filePath: type.__source?.fileName || null,
              lineNumber: type.__source?.lineNumber || null
            };
          }
        }
        current = current.return;
      }
    } catch (e) {
      // Silently fail if React detection fails
    }
    return null;
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(el);

    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : '',
      textContent: (el.textContent || '').trim().substring(0, 100),
      attributes: Array.from(el.attributes || []).reduce((acc, attr) => {
        if (!attr.name.startsWith('__preview')) {
          acc[attr.name] = attr.value;
        }
        return acc;
      }, {}),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      computedStyle: {
        display: computedStyle.display,
        position: computedStyle.position,
        color: computedStyle.color,
        backgroundColor: computedStyle.backgroundColor,
        fontSize: computedStyle.fontSize,
        fontFamily: computedStyle.fontFamily,
        padding: computedStyle.padding,
        margin: computedStyle.margin
      },
      selector: getElementSelector(el)
    };
  }

  // Get detailed element info for AI context
  function getDetailedElementInfo(el) {
    const basicInfo = getElementInfo(el);
    const computedStyle = window.getComputedStyle(el);

    // Get outerHTML but truncate if too large
    let outerHTML = el.outerHTML || '';
    if (outerHTML.length > 5000) {
      // Get just the opening tag and indicate truncation
      const match = outerHTML.match(/^<[^>]+>/);
      outerHTML = (match ? match[0] : '<' + el.tagName.toLowerCase() + '>') + '...truncated...';
    }

    return {
      ...basicInfo,
      elementId: getOrCreateElementId(el),
      outerHTML: outerHTML,
      fullSelector: getFullSelector(el),
      parentChain: getParentChain(el),
      siblings: getSiblingInfo(el),
      react: getReactInfo(el),
      // Extended computed styles for AI editing
      extendedStyles: {
        display: computedStyle.display,
        position: computedStyle.position,
        top: computedStyle.top,
        left: computedStyle.left,
        right: computedStyle.right,
        bottom: computedStyle.bottom,
        width: computedStyle.width,
        height: computedStyle.height,
        color: computedStyle.color,
        backgroundColor: computedStyle.backgroundColor,
        fontSize: computedStyle.fontSize,
        fontFamily: computedStyle.fontFamily,
        fontWeight: computedStyle.fontWeight,
        lineHeight: computedStyle.lineHeight,
        textAlign: computedStyle.textAlign,
        padding: computedStyle.padding,
        margin: computedStyle.margin,
        border: computedStyle.border,
        borderRadius: computedStyle.borderRadius,
        boxShadow: computedStyle.boxShadow,
        opacity: computedStyle.opacity,
        zIndex: computedStyle.zIndex,
        flexDirection: computedStyle.flexDirection,
        justifyContent: computedStyle.justifyContent,
        alignItems: computedStyle.alignItems,
        gap: computedStyle.gap
      }
    };
  }

  // Style preview system
  let previewStyles = null;
  let originalStyles = null;

  function applyStylePreview(elementId, styles) {
    // Find element by ID
    let targetEl = null;
    for (const [el, id] of elementIdMap) {
      if (id === elementId) {
        targetEl = el;
        break;
      }
    }
    if (!targetEl) return false;

    // Save original inline styles
    originalStyles = {};
    for (const prop of Object.keys(styles)) {
      originalStyles[prop] = targetEl.style[prop] || '';
    }

    // Apply preview styles
    for (const [prop, value] of Object.entries(styles)) {
      targetEl.style[prop] = value;
    }
    previewStyles = { elementId, styles };
    return true;
  }

  function revertStylePreview() {
    if (!previewStyles || !originalStyles) return;

    // Find element
    let targetEl = null;
    for (const [el, id] of elementIdMap) {
      if (id === previewStyles.elementId) {
        targetEl = el;
        break;
      }
    }
    if (!targetEl) return;

    // Restore original styles
    for (const [prop, value] of Object.entries(originalStyles)) {
      targetEl.style[prop] = value;
    }
    previewStyles = null;
    originalStyles = null;
  }

  function updateOverlay(el) {
    if (!el || el.id?.startsWith('__preview-inspector')) {
      overlay.style.display = 'none';
      tooltip.style.display = 'none';
      return;
    }

    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';

    // Update tooltip
    const selector = getElementSelector(el);
    const dims = Math.round(rect.width) + ' × ' + Math.round(rect.height);
    tooltip.textContent = selector + '  ' + dims;
    tooltip.style.display = 'block';

    // Position tooltip above or below element
    let tooltipTop = rect.top - 28;
    if (tooltipTop < 4) {
      tooltipTop = rect.bottom + 4;
    }
    let tooltipLeft = rect.left;
    if (tooltipLeft + tooltip.offsetWidth > window.innerWidth - 4) {
      tooltipLeft = window.innerWidth - tooltip.offsetWidth - 4;
    }
    tooltip.style.top = tooltipTop + 'px';
    tooltip.style.left = Math.max(4, tooltipLeft) + 'px';
  }

  function updateSelection(el) {
    if (!el) {
      selection.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    selection.style.display = 'block';
    selection.style.top = rect.top + 'px';
    selection.style.left = rect.left + 'px';
    selection.style.width = rect.width + 'px';
    selection.style.height = rect.height + 'px';
  }

  function showSendButton(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    sendButton.style.display = 'flex';

    // Position button below the element, or above if no room below
    let btnTop = rect.bottom + 8;
    if (btnTop + 30 > window.innerHeight) {
      btnTop = rect.top - 36;
    }
    let btnLeft = rect.left;
    if (btnLeft + 120 > window.innerWidth) {
      btnLeft = window.innerWidth - 130;
    }
    sendButton.style.top = btnTop + 'px';
    sendButton.style.left = Math.max(4, btnLeft) + 'px';
  }

  function hideSendButton() {
    sendButton.style.display = 'none';
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
  }

  function handleMouseMove(e) {
    if (!inspectMode) return;

    const el = document.elementFromPoint(e.clientX, e.clientY);

    // Ignore our own UI elements
    if (el?.id?.startsWith('__preview-inspector')) return;

    if (el && el !== hoveredElement) {
      hoveredElement = el;
      updateOverlay(el);

      // Reset hover timer for send button
      hideSendButton();
      lastHoverTime = Date.now();
      hoverTimeout = setTimeout(() => {
        // Show button after 1.2 seconds of hovering on same element
        if (hoveredElement === el && inspectMode) {
          showSendButton(el);
        }
      }, 1200);
    }
  }

  function handleMouseOut(e) {
    if (!inspectMode) return;

    // Check if we're moving to the send button (allow clicking it)
    if (e.relatedTarget?.id === '__preview-inspector-send-btn') return;

    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      overlay.style.display = 'none';
      tooltip.style.display = 'none';
      hideSendButton();
      hoveredElement = null;
    }
  }

  function handleClick(e) {
    if (!inspectMode) return;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id?.startsWith('__preview-inspector')) return;

    e.preventDefault();
    e.stopPropagation();

    selectedElement = el;
    updateSelection(el);

    // Send detailed element info to parent (includes React info, parent chain, etc.)
    const info = getDetailedElementInfo(el);
    window.parent.postMessage({
      type: 'preview-element-selected',
      element: info
    }, '*');
  }

  // Touch event handlers for mobile support
  let touchStartTime = 0;
  let touchStartElement = null;

  function handleTouchStart(e) {
    if (!inspectMode) return;

    // Don't interfere with multi-touch gestures
    if (e.touches.length > 1) return;

    const touch = e.touches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);

    // Ignore our own UI elements
    if (el?.id?.startsWith('__preview-inspector')) return;

    if (el && el !== hoveredElement) {
      hoveredElement = el;
      touchStartElement = el;
      touchStartTime = Date.now();
      updateOverlay(el);

      // Show send button after 600ms for touch-hold (faster than mouse hover)
      hideSendButton();

      // Clear any existing timeout to prevent race conditions
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }

      hoverTimeout = setTimeout(() => {
        if (hoveredElement === el && inspectMode) {
          showSendButton(el);
        }
      }, 600);
    }
  }

  function handleTouchMove(e) {
    if (!inspectMode) return;

    // Don't interfere with multi-touch gestures
    if (e.touches.length > 1) return;

    // Prevent scroll during inspect
    e.preventDefault();

    const touch = e.touches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);

    // Ignore our own UI elements
    if (el?.id?.startsWith('__preview-inspector')) return;

    if (el && el !== hoveredElement) {
      hoveredElement = el;
      updateOverlay(el);

      // Reset timer for new element
      hideSendButton();
      touchStartElement = el;
      touchStartTime = Date.now();

      // Clear any existing timeout to prevent race conditions
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }

      hoverTimeout = setTimeout(() => {
        if (hoveredElement === el && inspectMode) {
          showSendButton(el);
        }
      }, 600);
    }
  }

  function handleTouchEnd(e) {
    if (!inspectMode) return;

    // Don't interfere with multi-touch gestures
    if (e.changedTouches.length !== 1) return;

    const touch = e.changedTouches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);

    // If touching send button, let it handle the click
    if (el?.id === '__preview-inspector-send-btn') return;

    // Ignore our own UI elements
    if (el?.id?.startsWith('__preview-inspector')) return;

    if (!el) return;

    e.preventDefault();
    e.stopPropagation();

    // Check if this was a tap (not a long hold that already triggered send button)
    const touchDuration = Date.now() - touchStartTime;
    const isTap = touchDuration < 600 && touchStartElement && el === touchStartElement;

    if (isTap) {
      // Quick tap = select element
      selectedElement = el;
      updateSelection(el);

      // Send detailed element info to parent
      const info = getDetailedElementInfo(el);
      window.parent.postMessage({
        type: 'preview-element-selected',
        element: info
      }, '*');
    }

    // Hide overlay and send button after selection
    overlay.style.display = 'none';
    tooltip.style.display = 'none';
    hideSendButton();

    // Clear any pending hover timeout
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }

    hoveredElement = null;
  }

  function handleTouchCancel(e) {
    if (!inspectMode) return;

    // Clean up on touch cancel
    overlay.style.display = 'none';
    tooltip.style.display = 'none';
    hideSendButton();

    // Clear any pending hover timeout
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }

    hoveredElement = null;
    touchStartElement = null;
  }

  function setInspectMode(enabled) {
    inspectMode = enabled;
    document.body.style.cursor = enabled ? 'crosshair' : '';

    if (!enabled) {
      overlay.style.display = 'none';
      tooltip.style.display = 'none';
      hideSendButton();
      hoveredElement = null;
    }
  }

  function clearSelection() {
    selectedElement = null;
    selection.style.display = 'none';
  }

  // Listen for messages from parent
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'preview-inspect-mode') {
      setInspectMode(e.data.enabled);
    } else if (e.data?.type === 'preview-clear-selection') {
      clearSelection();
    } else if (e.data?.type === 'preview-apply-style-preview') {
      // Apply temporary style preview
      const { elementId, styles } = e.data;
      if (elementId && styles) {
        applyStylePreview(elementId, styles);
      }
    } else if (e.data?.type === 'preview-revert-style-preview') {
      // Revert style preview
      revertStylePreview();
    } else if (e.data?.type === 'preview-request-detailed-info') {
      // Request detailed info for currently selected element
      if (selectedElement) {
        const info = getDetailedElementInfo(selectedElement);
        window.parent.postMessage({
          type: 'preview-detailed-info',
          element: info
        }, '*');
      }
    }
  });

  // Right-click handler for context menu
  function handleContextMenu(e) {
    if (!inspectMode) return;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id?.startsWith('__preview-inspector')) return;

    showContextMenu(e, el);
  }

  // Click handler to hide context menu
  document.addEventListener('click', (e) => {
    if (contextMenu.style.display === 'block' && !contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  }, true);

  // Add event listeners for both mouse and touch
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('mouseout', handleMouseOut, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('contextmenu', handleContextMenu, true);

  // Touch event listeners for mobile support
  document.addEventListener('touchstart', handleTouchStart, true);
  document.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
  document.addEventListener('touchend', handleTouchEnd, true);
  document.addEventListener('touchcancel', handleTouchCancel, true);

  // Update selection position on scroll/resize
  window.addEventListener('scroll', () => {
    if (selectedElement) updateSelection(selectedElement);
    if (hoveredElement) updateOverlay(hoveredElement);
  }, true);
  window.addEventListener('resize', () => {
    if (selectedElement) updateSelection(selectedElement);
    if (hoveredElement) updateOverlay(hoveredElement);
  });

  // Notify parent that inspector is ready
  window.parent.postMessage({ type: 'preview-inspector-ready' }, '*');
})();
`;
