import { getProjectBadge } from '../utils/projectBadge';

export function ProjectBadge({ name }) {
  const badge = getProjectBadge(name);
  return <span className="threads-project-badge" style={{ '--badge-hue': badge.hue }} aria-hidden="true">{badge.initials}</span>;
}
