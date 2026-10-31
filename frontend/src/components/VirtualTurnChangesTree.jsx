import { useId, useMemo, useRef, useState } from 'react';
import { List } from 'react-window';

function visibleRows(nodes, collapsed, level = 1, parent = null) {
  const rows = [];
  nodes.forEach((node, index) => {
    const path = node.file?.path || node.path;
    rows.push({ node, path, level, parent, position: index + 1, siblings: nodes.length });
    if (!node.file && !collapsed.has(path)) rows.push(...visibleRows(node.children, collapsed, level + 1, path));
  });
  return rows;
}

function Row({ index, style, rows, collapsed, selected, activeIndex, idPrefix, onActivate }) {
  const row = rows[index];
  const { node, path } = row;
  const folder = !node.file;
  const expanded = folder && !collapsed.has(path);
  const added = node.file?.added ?? node.added ?? 0;
  const removed = node.file?.removed ?? node.removed ?? 0;
  return <div id={`${idPrefix}-${index}`} style={{ ...style, paddingLeft: 12 + Math.min((row.level - 1) * 12, 96) }}
    role="treeitem" aria-label={path} aria-level={row.level} aria-posinset={row.position} aria-setsize={row.siblings}
    aria-expanded={folder ? expanded : undefined} aria-selected={!folder ? selected === path : undefined}
    aria-description={node.file?.binary ? 'Binary file' : `${added} added, ${removed} removed`}
    data-active={index === activeIndex ? 'true' : undefined} className="turn-changes-virtual-row" onClick={() => onActivate(index)}>
    <span className="turn-changes-path">{folder && <span aria-hidden="true">{expanded ? '▾' : '▸'} </span>}{node.name}{folder ? '/' : ''}</span>
    {node.file?.binary ? <span className="turn-changes-delta">binary</span> : <span className="turn-changes-delta"><span className="turn-changes-added">+{added.toLocaleString()}</span><span className="turn-changes-removed">−{removed.toLocaleString()}</span></span>}
  </div>;
}

export function VirtualTurnChangesTree({ children, collapsed, setCollapsed, selected, showFile }) {
  const rows = useMemo(() => visibleRows(children, collapsed), [children, collapsed]);
  const idPrefix = `turn-tree-${useId().replace(/:/g, '')}`;
  const instructionsId = `${idPrefix}-help`;
  const list = useRef(null);
  const pending = useRef(null);
  const renderedRange = useRef({ startIndex: 0, stopIndex: -1 });
  const [activePath, setActivePath] = useState(null);
  const activeIndex = Math.max(0, rows.findIndex(row => row.path === activePath));
  const activeRef = useRef(activePath);
  activeRef.current = rows[activeIndex]?.path;

  const move = index => {
    const target = Math.max(0, Math.min(index, rows.length - 1));
    activeRef.current = rows[target].path;
    setActivePath(rows[target].path);
    pending.current = target >= renderedRange.current.startIndex && target <= renderedRange.current.stopIndex ? null : target;
    list.current?.scrollToRow({ index: target, align: 'auto' });
  };
  const toggleFolder = path => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const activate = index => {
    const row = rows[index];
    move(index);
    list.current?.element?.focus();
    if (row.node.file) showFile(row.path); else toggleFolder(row.path);
  };
  const onKeyDown = event => {
    const row = rows[activeIndex];
    if (!row) return;
    if (event.key === 'ArrowDown') move(activeIndex + 1);
    else if (event.key === 'ArrowUp') move(activeIndex - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(rows.length - 1);
    else if (event.key === 'ArrowRight' && !row.node.file) {
      if (collapsed.has(row.path)) toggleFolder(row.path);
      else if (rows[activeIndex + 1]?.parent === row.path) move(activeIndex + 1);
    } else if (event.key === 'ArrowLeft') {
      if (!row.node.file && !collapsed.has(row.path)) toggleFolder(row.path);
      else if (row.parent) move(rows.findIndex(item => item.path === row.parent));
    } else if (event.key === 'Enter' || event.key === ' ') activate(activeIndex);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onRowsRendered = (visible, rendered) => {
    renderedRange.current = rendered;
    if (pending.current !== null) {
      if (pending.current >= rows.length || (pending.current >= rendered.startIndex && pending.current <= rendered.stopIndex)) pending.current = null;
      else return;
    }
    const current = rows.findIndex(row => row.path === activeRef.current);
    if (list.current?.element === document.activeElement && (current < rendered.startIndex || current > rendered.stopIndex)) {
      const path = rows[visible.startIndex]?.path;
      if (path) { activeRef.current = path; setActivePath(path); }
    }
  };

  return <>
    <p id={instructionsId} className="turn-changes-tree-help">Use arrow keys to navigate, Enter to open a file, and left or right to collapse or expand folders.</p>
    <List listRef={list} className="turn-changes-virtual" role="tree" aria-label="Changed files" aria-describedby={instructionsId}
      aria-activedescendant={rows.length ? `${idPrefix}-${activeIndex}` : undefined} tabIndex={0} onKeyDown={onKeyDown}
      onRowsRendered={onRowsRendered} rowComponent={Row} rowCount={rows.length} rowHeight={44} overscanCount={4}
      rowProps={{ rows, collapsed, selected, activeIndex, idPrefix, onActivate: activate }} style={{ height: 352 }} />
  </>;
}
