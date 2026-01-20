import { useState } from 'react';

/**
 * JsonTreeView - Collapsible JSON tree viewer
 */
export function JsonTreeView({ data, initialExpanded = false }) {
  return (
    <div className="json-tree-view">
      <JsonNode data={data} path="" initialExpanded={initialExpanded} />
    </div>
  );
}

function JsonNode({ data, path, initialExpanded }) {
  const [expanded, setExpanded] = useState(initialExpanded);

  if (data === null) {
    return <span className="json-null">null</span>;
  }

  if (data === undefined) {
    return <span className="json-undefined">undefined</span>;
  }

  const type = typeof data;

  if (type === 'string') {
    return <span className="json-string">"{data}"</span>;
  }

  if (type === 'number') {
    return <span className="json-number">{data}</span>;
  }

  if (type === 'boolean') {
    return <span className="json-boolean">{String(data)}</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="json-array">[]</span>;
    }

    return (
      <div className="json-expandable">
        <span
          className="json-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '▼' : '▶'}
        </span>
        <span className="json-bracket">[</span>
        {expanded && (
          <div className="json-children">
            {data.map((item, index) => (
              <div key={index} className="json-item">
                <span className="json-key">{index}:</span>{' '}
                <JsonNode data={item} path={`${path}[${index}]`} initialExpanded={false} />
              </div>
            ))}
          </div>
        )}
        {!expanded && <span className="json-preview"> ({data.length} items)</span>}
        <span className="json-bracket">]</span>
      </div>
    );
  }

  if (type === 'object') {
    const keys = Object.keys(data);
    if (keys.length === 0) {
      return <span className="json-object">{'{}'}</span>;
    }

    return (
      <div className="json-expandable">
        <span
          className="json-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '▼' : '▶'}
        </span>
        <span className="json-brace">{'{'}</span>
        {expanded && (
          <div className="json-children">
            {keys.map((key) => (
              <div key={key} className="json-item">
                <span className="json-key">{key}:</span>{' '}
                <JsonNode data={data[key]} path={`${path}.${key}`} initialExpanded={false} />
              </div>
            ))}
          </div>
        )}
        {!expanded && <span className="json-preview"> ({keys.length} keys)</span>}
        <span className="json-brace">{'}'}</span>
      </div>
    );
  }

  return <span>{String(data)}</span>;
}
