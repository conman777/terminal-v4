import { getPreferredSessionTopic } from './sessionTopic';

function normalizePath(value) {
  return typeof value === 'string' ? value.replace(/[\\/]+$/, '') : '';
}

function getPathLeaf(value) {
  const normalized = normalizePath(value).replace(/\\/g, '/');
  if (!normalized) return '';
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function looksLikePath(value) {
  return typeof value === 'string' && (
    /^[a-z]:[\\/]/i.test(value)
    || value.startsWith('/')
    || value.startsWith('~')
  );
}

function isGenericTerminalTitle(value) {
  return typeof value === 'string' && /^terminal(?:\s+\d+)?$/i.test(value.trim());
}

function getProjectPath(session) {
  return (
    session?.thread?.projectPath
    || session?.groupPath
    || session?.cwd
    || ''
  );
}

export function getSessionFallbackLabel(session, fallbackTitle = 'New session') {
  const projectName = getPathLeaf(getProjectPath(session));
  const title = typeof session?.title === 'string' ? session.title.trim() : '';

  if (projectName && (looksLikePath(title) || isGenericTerminalTitle(title) || !title)) {
    return projectName;
  }

  return title || projectName || fallbackTitle;
}

export function getSessionDisplayInfo(session, fallbackTitle = 'New session') {
  const fallbackLabel = getSessionFallbackLabel(session, fallbackTitle);
  const primaryLabel = getPreferredSessionTopic(session?.thread?.topic, fallbackLabel);
  const projectPath = getProjectPath(session);
  const projectName = getPathLeaf(projectPath);
  const title = typeof session?.title === 'string' ? session.title.trim() : '';

  let secondaryLabel = '';
  if (projectName && projectName.toLowerCase() !== primaryLabel.toLowerCase()) {
    secondaryLabel = projectName;
  } else if (looksLikePath(title) && title !== primaryLabel) {
    secondaryLabel = title;
  } else if (title && !isGenericTerminalTitle(title) && title !== primaryLabel) {
    secondaryLabel = title;
  } else if (projectPath && projectPath !== primaryLabel) {
    secondaryLabel = projectPath;
  }

  return {
    primaryLabel,
    secondaryLabel,
    projectName,
    projectPath,
  };
}

export function getCompactSessionSubtitle(session, fallbackTitle = 'New session') {
  const { primaryLabel, projectName } = getSessionDisplayInfo(session, fallbackTitle);
  if (!projectName) return '';
  return projectName.toLowerCase() === primaryLabel.toLowerCase() ? '' : projectName;
}
