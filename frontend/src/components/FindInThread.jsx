import { useEffect, useRef, useState } from 'react';
import { FOLDED_SEARCH_CHANGED, foldedMessageMatches, foldedSearchItems } from '../utils/foldedConversationSearch';
import './FindInThread.css';

const MESSAGE = '.cc-transcript-message';
const SEARCHABLE = `${MESSAGE}, .structured-reasoning-text, .structured-plan, .structured-tool-partial, [data-folded-search-index]`;

function inActiveConversation(node) {
  if (node.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  const pane = node.closest('.split-terminal-pane');
  return !pane || pane.classList.contains('active');
}

function findCandidate(node, needle, workIndexes) {
  if (node.hasAttribute('data-folded-search-index')) {
    const group = node.parentElement;
    if (!group || !inActiveConversation(group)) return null;
    const position = Number(node.dataset.foldedSearchIndex);
    const item = foldedSearchItems(group)[position];
    let index = workIndexes.get(group);
    if (!index) {
      index = new Map([...group.querySelectorAll('[data-folded-render-index]')].map(element => [Number(element.dataset.foldedRenderIndex), element]));
      workIndexes.set(group, index);
    }
    const wrapper = index.get(position);
    let target = wrapper?.querySelector(item?.role === 'tool' ? '.cc-tool-output' : `${MESSAGE}, .structured-reasoning-text, .structured-plan`) || null;
    const content = target?.querySelector('.cc-user-content, .cc-assistant-content') || target;
    const task = item?.role === 'tool' ? [...(wrapper?.querySelectorAll('.cc-session-todo-content') || [])].find(element => element.textContent.toLowerCase().includes(needle)) : null;
    const diff = item?.role === 'tool' ? [...(wrapper?.querySelectorAll('.diff-line-content, .diff-view > .diff-context') || [])].find(element => element.textContent.toLowerCase().includes(needle)) : null;
    if (!foldedMessageMatches(item, needle) && !content?.textContent.toLowerCase().includes(needle) && !task && !diff) return null;
    if (item.role === 'tool') {
      if (task) target = task;
      else if (diff) target = diff;
      else if (target?.closest('.cc-todo-raw:not([open])') || (wrapper?.querySelector('.cc-show-more-btn') && !target?.textContent.toLowerCase().includes(needle))) target = null;
      else if (target) target = [...target.querySelectorAll('.cc-output-line')].find(line => line.textContent.toLowerCase().includes(needle)) || target;
    }
    return { key: node, node: target, group, position, item };
  }
  if (!inActiveConversation(node)) return null;
  const content = node.querySelector('.cc-user-content, .cc-assistant-content') || node;
  const work = node.closest('.conversation-work-group');
  if (work) return null;
  return content.textContent.toLowerCase().includes(needle) ? { key: node, node, group: null } : null;
}

function clearMarks() {
  document.querySelectorAll('.cc-find-match, .cc-find-current').forEach(node => node.classList.remove('cc-find-match', 'cc-find-current'));
}

// ⌘F for the conversation: highlights messages containing the text and steps through them.
export function FindInThread({ open, onClose, focusRequest }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [current, setCurrent] = useState(0);
  const input = useRef(null);
  const root = useRef(null);
  const openerRef = useRef(null);
  const ownsFocus = useRef(false);
  const latestRequest = useRef(focusRequest);
  latestRequest.current = focusRequest;
  const matchesRef = useRef([]);
  const selectedRef = useRef(null);
  const scrolledRef = useRef(null);
  const revealRef = useRef(false);

  const reveal = selected => {
    selectedRef.current = selected?.key || null;
    if (!selected?.node) {
      if (selected?.group && revealRef.current && selected.group.isConnected && inActiveConversation(selected.group)) {
        const toggle = selected.group.querySelector('.conversation-work-toggle[aria-expanded="false"]');
        if (toggle) { toggle.click(); return; }
        if (selected.item?.role === 'tool') {
          const activity = [...selected.group.querySelectorAll('[data-folded-activity-start]')].find(element =>
            Number(element.dataset.foldedActivityStart) <= selected.position && Number(element.dataset.foldedActivityEnd) >= selected.position);
          const details = activity?.querySelector('details:not([open])');
          if (details) { details.querySelector('summary')?.click(); return; }
          const wrapper = [...selected.group.querySelectorAll('[data-folded-render-index]')].find(element => Number(element.dataset.foldedRenderIndex) === selected.position);
          const toolToggle = wrapper?.querySelector('.cc-tool-header[aria-expanded="false"]');
          if (toolToggle) { toolToggle.click(); return; }
          const raw = wrapper?.querySelector('.cc-todo-raw:not([open]) > summary');
          if (raw) { raw.click(); return; }
          wrapper?.querySelector('.cc-show-more-btn')?.click();
        }
      }
      return;
    }
    if (selected.node !== scrolledRef.current) selected.node.scrollIntoView?.({ block: 'center' });
    scrolledRef.current = selected.node;
    revealRef.current = false;
  };

  useEffect(() => {
    if (!open) { clearMarks(); setQuery(''); return undefined; }
    const requested = latestRequest.current?.opener;
    openerRef.current = requested || document.activeElement;
    const trackFocus = event => { ownsFocus.current = Boolean(root.current?.contains(event.target)); };
    document.addEventListener('focusin', trackFocus);
    document.addEventListener('pointerdown', trackFocus, true);
    if (!requested || document.activeElement === requested || root.current?.contains(document.activeElement)) input.current?.focus();
    return () => {
      document.removeEventListener('focusin', trackFocus);
      document.removeEventListener('pointerdown', trackFocus, true);
      const opener = openerRef.current;
      if (ownsFocus.current && opener?.isConnected && !opener.closest?.('[inert], [hidden], [aria-hidden="true"]')) opener.focus?.({ preventScroll: true });
      ownsFocus.current = false;
    };
  }, [open]);
  useEffect(() => {
    if (!open || !focusRequest) return;
    const opener = focusRequest.opener;
    if (opener && !root.current?.contains(opener)) {
      if (!opener.isConnected || document.activeElement !== opener) return;
      openerRef.current = opener;
    }
    input.current?.focus();
  }, [open, focusRequest]);
  useEffect(() => {
    const needle = query.trim().toLowerCase();
    selectedRef.current = null;
    scrolledRef.current = null;
    revealRef.current = Boolean(open && needle);
    setCurrent(0);
    let firstRefresh = true;
    const refresh = () => {
      const workIndexes = new WeakMap();
      const found = !open || !needle ? [] : [...document.querySelectorAll(SEARCHABLE)].map(node => findCandidate(node, needle, workIndexes)).filter(Boolean);
      if (!firstRefresh && found.length === matchesRef.current.length && found.every((item, index) => item.key === matchesRef.current[index].key && item.node === matchesRef.current[index].node)) {
        if (revealRef.current) reveal(found.find(item => item.key === selectedRef.current));
        return;
      }
      firstRefresh = false;
      clearMarks();
      found.forEach(item => item.node?.classList.add('cc-find-match'));
      const retainedIndex = found.findIndex(item => item.key === selectedRef.current);
      matchesRef.current = found;
      setMatches(found);
      setCurrent(retainedIndex < 0 ? 0 : retainedIndex);
    };
    refresh();
    if (!open || !needle) return undefined;
    let pending = false, disposed = false;
    const scheduleRefresh = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; if (!disposed) refresh(); });
    };
    const observer = new MutationObserver(records => {
      const relevant = records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!target) return false;
        if (record.type === 'attributes') {
          if (record.attributeName === 'open') return Boolean(target.closest('.desktop-conversation-view'));
          return target.matches('.split-terminal-pane, .mobile-workspace-surface, .desktop-conversation-view')
            || Boolean(target.querySelector('.desktop-conversation-view'));
        }
        return Boolean(target.closest('.desktop-conversation-view') || target.querySelector('.desktop-conversation-view'));
      });
      if (relevant) scheduleRefresh();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'inert', 'hidden', 'aria-hidden', 'open'] });
    document.addEventListener(FOLDED_SEARCH_CHANGED, scheduleRefresh);
    return () => { disposed = true; observer.disconnect(); document.removeEventListener(FOLDED_SEARCH_CHANGED, scheduleRefresh); };
  }, [open, query]);
  useEffect(() => {
    matches.forEach((item, index) => item.node?.classList.toggle('cc-find-current', index === current));
    reveal(matches[current] || null);
  }, [current, matches]);
  useEffect(() => clearMarks, []);

  if (!open) return null;
  const step = direction => {
    if (!matches.length) return;
    const next = (current + direction + matches.length) % matches.length;
    revealRef.current = true;
    scrolledRef.current = null;
    if (next === current) reveal(matches[next]); else setCurrent(next);
  };
  return (
    <div ref={root} className="find-in-thread" role="search">
      <input ref={input} type="search" aria-label="Find in thread" placeholder="Find in thread" value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); onClose?.(); }
          if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
        }} />
      <span className="find-in-thread-count" aria-live="polite">{query.trim() ? (matches.length ? `${current + 1} of ${matches.length}` : 'No matches') : ''}</span>
      <button type="button" aria-label="Previous match" onClick={() => step(-1)} disabled={!matches.length}>↑</button>
      <button type="button" aria-label="Next match" onClick={() => step(1)} disabled={!matches.length}>↓</button>
      <button type="button" aria-label="Close find" onClick={onClose}>×</button>
    </div>
  );
}
