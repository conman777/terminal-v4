export const PANE_DIVIDER_SIZE = 6;

function validSizes(sizes, count) {
  return Array.isArray(sizes) && sizes.length === count
    && sizes.every(size => typeof size === 'number' && Number.isFinite(size) && size > 0)
    && Number.isFinite(sizes.reduce((sum, size) => sum + size, 0));
}

export function getSplitSizes(node) {
  const count = node.children.length;
  if (!validSizes(node.sizes, count)) return node.children.map(() => 1 / count);
  const total = node.sizes.reduce((sum, size) => sum + size, 0);
  return node.sizes.map(size => size / total);
}

export function getPaneIds(node) {
  if (!node) return [];
  return node.type !== 'split' ? [node.id] : node.children.flatMap(getPaneIds);
}

export function resizePaneTree(root, path, sizes, expectedPaneIds) {
  if (!root || !Array.isArray(path) || path.some(index => !Number.isInteger(index) || index < 0)) return root;
  if (path.length) {
    if (root.type !== 'split' || !root.children[path[0]]) return root;
    const child = resizePaneTree(root.children[path[0]], path.slice(1), sizes, expectedPaneIds);
    if (child === root.children[path[0]]) return root;
    return { ...root, children: root.children.map((previous, index) => index === path[0] ? child : previous) };
  }
  if (root.type !== 'split' || !validSizes(sizes, root.children.length)) return root;
  const paneIds = getPaneIds(root);
  if (!Array.isArray(expectedPaneIds) || paneIds.length !== expectedPaneIds.length
    || paneIds.some((id, index) => id !== expectedPaneIds[index])) return root;
  const normalized = getSplitSizes({ ...root, sizes });
  if (getSplitSizes(root).every((size, index) => Math.abs(size - normalized[index]) < 1e-8)) return root;
  return { ...root, sizes: normalized };
}

export function paneTreeFromLegacy(layout) {
  const panes = layout?.panes || [];
  if (panes.length < 2) return panes[0] || null;
  if (layout.type !== 'grid') {
    return { type: 'split', direction: layout.type === 'vertical' ? 'vertical' : 'horizontal', children: panes };
  }
  const rows = [];
  for (let index = 0; index < panes.length; index += 2) {
    rows.push(index + 1 < panes.length
      ? { type: 'split', direction: 'horizontal', children: panes.slice(index, index + 2) }
      : panes[index]);
  }
  return rows.length === 1 ? rows[0] : { type: 'split', direction: 'vertical', children: rows };
}

function minimumPaneSize(node, direction) {
  if (node.type !== 'split') return direction === 'horizontal' ? 160 : 120;
  const minimums = node.children.map(child => minimumPaneSize(child, direction));
  return node.direction === direction
    ? minimums.reduce((sum, size) => sum + size, 0) + PANE_DIVIDER_SIZE * (minimums.length - 1)
    : Math.max(...minimums);
}

function boundedChildSizes(node, available) {
  const weights = getSplitSizes(node);
  const minimums = node.children.map(child => minimumPaneSize(child, node.direction));
  const minimumTotal = minimums.reduce((sum, size) => sum + size, 0);
  const floors = minimums.map(size => size * Math.min(1, available / minimumTotal));
  const lengths = weights.map(size => size * available);
  const constrained = new Set();
  // Clamp small children, then redistribute their deficit among the remaining children.
  for (let pass = 0; pass < weights.length; pass++) {
    lengths.forEach((length, index) => {
      if (length < floors[index]) constrained.add(index);
    });
    const remaining = available - floors.reduce((sum, size, index) => sum + (constrained.has(index) ? size : 0), 0);
    const weight = weights.reduce((sum, size, index) => sum + (constrained.has(index) ? 0 : size), 0);
    lengths.forEach((_, index) => {
      lengths[index] = constrained.has(index) ? floors[index] : (weight ? remaining * weights[index] / weight : 0);
    });
  }
  return { lengths, floors };
}

export function getPaneTreeGeometry(root, width, height) {
  const leaves = [];
  const dividers = [];
  function visit(node, rect, path) {
    if (!node) return;
    if (node.type !== 'split') {
      leaves.push({ pane: node, rect });
      return;
    }
    const horizontal = node.direction === 'horizontal';
    const axisSize = horizontal ? rect.width : rect.height;
    const dividerSize = Math.min(PANE_DIVIDER_SIZE, axisSize / Math.max(1, node.children.length - 1));
    const available = Math.max(0, axisSize - dividerSize * (node.children.length - 1));
    const { lengths, floors } = boundedChildSizes(node, available);
    let offset = 0;
    node.children.forEach((child, index) => {
      const childRect = horizontal
        ? { ...rect, left: rect.left + offset, width: lengths[index] }
        : { ...rect, top: rect.top + offset, height: lengths[index] };
      if (index < node.children.length - 1) {
        const pairSize = lengths[index] + lengths[index + 1];
        dividers.push({
          path, index, direction: node.direction, paneIds: getPaneIds(node),
          sizes: available ? lengths.map(size => size / available) : getSplitSizes(node),
          pairSize,
          value: pairSize ? lengths[index] / pairSize * 100 : 50,
          min: pairSize ? floors[index] / pairSize * 100 : 50,
          max: pairSize ? 100 - floors[index + 1] / pairSize * 100 : 50,
          rect: horizontal
            ? { ...rect, left: childRect.left + childRect.width, width: dividerSize }
            : { ...rect, top: childRect.top + childRect.height, height: dividerSize },
        });
      }
      visit(child, childRect, [...path, index]);
      offset += lengths[index] + dividerSize;
    });
  }
  visit(root, { left: 0, top: 0, width: Math.max(0, width), height: Math.max(0, height) }, []);
  return { leaves, dividers };
}
