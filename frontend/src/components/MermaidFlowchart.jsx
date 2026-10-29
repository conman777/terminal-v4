import { useId } from 'react';

const NODE = '([A-Za-z_][A-Za-z0-9_-]*)(?:\\[([^\\]\\r\\n]{1,80})\\]|\\(([^()\\r\\n]{1,80})\\)|\\{([^{}\\r\\n]{1,80})\\})?';
const EDGE = new RegExp(`^${NODE}\\s*-->\\s*(?:\\|([^|\\r\\n]{1,60})\\|\\s*)?${NODE}$`);
const DECLARATION = new RegExp(`^${NODE}$`);

function parseFlowchart(source) {
  if (source.length > 8192) return null;
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = /^(?:graph|flowchart)\s+(TD|TB|LR)$/i.exec(lines.shift() || '');
  if (!header) return null;
  const nodes = new Map(), edges = [];
  const addNode = (id, label, shape) => {
    const previous = nodes.get(id);
    const clean = label?.replace(/^"(.*)"$/, '$1');
    if (previous) { if (clean) { previous.label = clean; previous.shape = shape; } return; }
    nodes.set(id, { id, label: clean || id, shape, incoming: 0, outgoing: [], layer: 0 });
  };
  for (const line of lines) {
    const edge = EDGE.exec(line);
    if (edge) {
      addNode(edge[1], edge[2] || edge[3] || edge[4], edge[4] ? 'decision' : 'box');
      addNode(edge[6], edge[7] || edge[8] || edge[9], edge[9] ? 'decision' : 'box');
      edges.push([edge[1], edge[6], edge[5] || '']);
    } else {
      const declaration = DECLARATION.exec(line);
      if (!declaration) return null;
      addNode(declaration[1], declaration[2] || declaration[3] || declaration[4], declaration[4] ? 'decision' : 'box');
    }
    if (nodes.size > 32 || edges.length > 64) return null;
  }
  if (!edges.length) return null;
  for (const [from, to] of edges) { nodes.get(from).outgoing.push(to); nodes.get(to).incoming += 1; }
  const ready = [...nodes.values()].filter(node => node.incoming === 0);
  const ordered = [];
  for (let index = 0; index < ready.length; index += 1) {
    const node = ready[index]; ordered.push(node);
    for (const id of node.outgoing) {
      const child = nodes.get(id);
      child.layer = Math.max(child.layer, node.layer + 1);
      child.incoming -= 1;
      if (child.incoming === 0) ready.push(child);
    }
  }
  if (ordered.length !== nodes.size) return null;
  const groups = [];
  for (const node of nodes.values()) (groups[node.layer] ||= []).push(node);
  const across = Math.max(...groups.map(group => group.length));
  const horizontal = header[1].toUpperCase() === 'LR';
  for (const [layer, group] of groups.entries()) {
    for (const [position, node] of group.entries()) {
      const acrossPosition = (across - group.length) * 80 + position * 160 + 80;
      node.x = horizontal ? layer * 180 + 80 : acrossPosition;
      node.y = horizontal ? acrossPosition : layer * 100 + 36;
    }
  }
  return { nodes, edges, horizontal, width: horizontal ? groups.length * 180 : across * 160, height: horizontal ? across * 160 : groups.length * 100 };
}

export function MermaidFlowchart({ source }) {
  const markerId = `flow-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const graph = parseFlowchart(source);
  if (!graph) return null;
  return <div className="md-flowchart-scroll" role="region" aria-label="Mermaid flowchart" tabIndex={0} data-conversation-scroll-region>
    <svg role="img" aria-label={`Flowchart: ${graph.edges.map(([from, to, label]) => `${graph.nodes.get(from).label} to ${graph.nodes.get(to).label}${label ? ` (${label})` : ''}`).join('; ')}`} width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`}>
      <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      {graph.edges.map(([from, to, edgeLabel], index) => {
        const start = graph.nodes.get(from), end = graph.nodes.get(to);
        const x1 = start.x + (graph.horizontal ? 60 : 0), y1 = start.y + (graph.horizontal ? 0 : 20);
        const x2 = end.x - (graph.horizontal ? 60 : 0), y2 = end.y - (graph.horizontal ? 0 : 20);
        const label = Array.from(edgeLabel);
        return <g key={index}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" markerEnd={`url(#${markerId})`} />
          {edgeLabel && <text className="md-flowchart-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle"><title>{edgeLabel}</title>{label.length > 20 ? `${label.slice(0, 19).join('')}…` : edgeLabel}</text>}</g>;
      })}
      {[...graph.nodes.values()].map(node => {
        const label = Array.from(node.label);
        return <g key={node.id}>{node.shape === 'decision' ? <polygon points={`${node.x},${node.y - 20} ${node.x + 60},${node.y} ${node.x},${node.y + 20} ${node.x - 60},${node.y}`} /> : <rect x={node.x - 60} y={node.y - 20} width="120" height="40" rx="6" />}<text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="middle"><title>{node.label}</title>{label.length > 18 ? `${label.slice(0, 17).join('')}…` : node.label}</text></g>;
      })}
    </svg>
  </div>;
}

export { parseFlowchart };
