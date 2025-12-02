import { useMemo } from 'react';

export function PathBreadcrumb({ cwd, onNavigate }) {
  const segments = useMemo(() => {
    if (!cwd) return [];

    // Handle Windows paths (C:\Users\...) and Unix paths (/home/...)
    const isWindows = /^[A-Za-z]:/.test(cwd);
    const separator = isWindows ? '\\' : '/';

    const parts = cwd.split(separator).filter(Boolean);
    const result = [];

    if (isWindows) {
      // Windows: first part is drive letter (e.g., "C:")
      let currentPath = parts[0] + separator;
      result.push({ name: parts[0], path: currentPath });

      for (let i = 1; i < parts.length; i++) {
        currentPath += parts[i] + (i < parts.length - 1 ? separator : '');
        result.push({ name: parts[i], path: currentPath });
      }
    } else {
      // Unix: starts with /
      let currentPath = '';
      for (let i = 0; i < parts.length; i++) {
        currentPath += separator + parts[i];
        result.push({ name: parts[i], path: currentPath });
      }
      // Add root
      result.unshift({ name: '/', path: '/' });
    }

    return result;
  }, [cwd]);

  if (!cwd || segments.length === 0) {
    return null;
  }

  const handleClick = (path) => {
    if (onNavigate) {
      onNavigate(path);
    }
  };

  return (
    <nav className="path-breadcrumb" aria-label="Current directory">
      {segments.map((segment, index) => (
        <span key={segment.path} className="breadcrumb-segment-wrapper">
          {index > 0 && <span className="breadcrumb-separator">{'\u203A'}</span>}
          <button
            type="button"
            className={`breadcrumb-segment${index === segments.length - 1 ? ' current' : ''}`}
            onClick={() => handleClick(segment.path)}
            title={segment.path}
          >
            {segment.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
