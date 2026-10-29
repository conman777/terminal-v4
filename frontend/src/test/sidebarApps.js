import { fireEvent, screen } from '@testing-library/react';

// Workspace apps (Browser, Files, Preview, Notes, Bookmarks) live in the sidebar footer menu.
export async function openSidebarApp(name) {
  fireEvent.click(await screen.findByRole('button', { name: 'Workspace apps' }));
  return screen.getByRole('menuitem', { name });
}
