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
  overlay.style.cssText = \`
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    border: 2px solid #0ea5e9;
    background: rgba(14, 165, 233, 0.1);
    display: none;
    transition: all 0.05s ease-out;
  \`;
  document.documentElement.appendChild(overlay);

  // Create tooltip for element info
  const tooltip = document.createElement('div');
  tooltip.id = '__preview-inspector-tooltip';
  tooltip.style.cssText = \`
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    background: #1e293b;
    color: #f1f5f9;
    padding: 4px 8px;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    white-space: nowrap;
    display: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  \`;
  document.documentElement.appendChild(tooltip);

  // Create "Send to Terminal" button that appears after hover delay
  const sendButton = document.createElement('button');
  sendButton.id = '__preview-inspector-send-btn';
  sendButton.innerHTML = \`
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>
    Send to Terminal
  \`;
  sendButton.style.cssText = \`
    position: fixed;
    z-index: 2147483647;
    background: #f97316;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 6px 10px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    display: none;
    align-items: center;
    gap: 6px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    transition: background 0.15s, transform 0.15s;
  \`;
  sendButton.addEventListener('mouseenter', () => {
    sendButton.style.background = '#ea580c';
    sendButton.style.transform = 'scale(1.02)';
  });
  sendButton.addEventListener('mouseleave', () => {
    sendButton.style.background = '#f97316';
    sendButton.style.transform = 'scale(1)';
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
      setTimeout(() => {
        sendButton.style.background = '#f97316';
      }, 200);
    }
  });
  document.documentElement.appendChild(sendButton);

  // Create selection indicator (stays visible after click)
  const selection = document.createElement('div');
  selection.id = '__preview-inspector-selection';
  selection.style.cssText = \`
    position: fixed;
    pointer-events: none;
    z-index: 2147483646;
    border: 2px dashed #f97316;
    background: rgba(249, 115, 22, 0.05);
    display: none;
  \`;
  document.documentElement.appendChild(selection);

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

    // Send element info to parent
    const info = getElementInfo(el);
    window.parent.postMessage({
      type: 'preview-element-selected',
      element: info
    }, '*');
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
    }
  });

  // Add event listeners
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('mouseout', handleMouseOut, true);
  document.addEventListener('click', handleClick, true);

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
