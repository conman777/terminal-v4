# Keyboard Shortcuts

Terminal v4 supports various keyboard shortcuts for efficient navigation and control.

## Global Shortcuts

These shortcuts work from anywhere in the application:

| Shortcut | Action | Description |
| --- | --- | --- |
| `Ctrl+Alt+N` | New Terminal | Create a new terminal session |
| `Ctrl+Alt+C` | Claude Code | Toggle Claude Code panel |
| `Ctrl+Alt+P` | Preview Panel | Toggle preview panel |
| `Ctrl+Alt+F` | File Manager | Open file manager |
| `Ctrl+Alt+B` | Bookmarks | Open bookmarks modal |
| `Ctrl+Alt+T` | Notes | Open notes modal |
| `Ctrl+Alt+S` | Settings | Open settings modal |
| `Ctrl+Alt+M` | Process Manager | Open process manager |
| `Ctrl+Alt+1` through `9` | Switch Session | Switch to terminal session 1-9 |
| `Ctrl+Alt+Left/Right` | Navigate Sessions | Move between terminal sessions |
| `Escape` | Close Modal | Close any open modal or panel |

## Terminal Shortcuts

These shortcuts work when a terminal is focused:

| Shortcut | Action | Description |
| --- | --- | --- |
| `Ctrl+C` | Interrupt | Send SIGINT to running process |
| `Ctrl+D` | EOF | Send end-of-file signal |
| `Ctrl+L` | Clear | Clear terminal screen |
| `Ctrl+Shift+C` | Copy | Copy selected text |
| `Ctrl+Shift+V` | Paste | Paste from clipboard |
| `Ctrl+Shift+F` | Search | Search terminal output |
| `Ctrl+Plus` | Zoom In | Increase terminal font size |
| `Ctrl+Minus` | Zoom Out | Decrease terminal font size |
| `Ctrl+0` | Reset Zoom | Reset font size to default |

## Split Pane Shortcuts

| Shortcut | Action | Description |
| --- | --- | --- |
| `Ctrl+Alt+V` | Split Vertical | Split current pane vertically |
| `Ctrl+Alt+H` | Split Horizontal | Split current pane horizontally |
| `Ctrl+Alt+W` | Close Pane | Close current pane |
| `Ctrl+Alt+Enter` | Fullscreen | Toggle fullscreen mode for pane |
| `Ctrl+Alt+Arrow` | Move Focus | Move focus between panes |

## Preview Panel Shortcuts

| Shortcut | Action | Description |
| --- | --- | --- |
| `Ctrl+R` | Refresh Preview | Reload preview iframe |
| `Ctrl+Shift+R` | Hard Refresh | Hard refresh with cache clearing |
| `Ctrl+Alt+D` | DevTools | Toggle DevTools panel |
| `Ctrl+Alt+I` | Screenshot | Take screenshot of preview |
| `F11` | Picture-in-Picture | Toggle PiP mode for preview |

## DevTools Shortcuts

| Shortcut | Action | Description |
| --- | --- | --- |
| `Ctrl+Shift+C` | Console Tab | Switch to console tab |
| `Ctrl+Shift+N` | Network Tab | Switch to network tab |
| `Ctrl+Shift+S` | Storage Tab | Switch to storage tab |
| `Ctrl+Shift+W` | WebSocket Tab | Switch to WebSocket tab |
| `Ctrl+Shift+P` | Performance Tab | Switch to performance tab |
| `Ctrl+K` | Clear Logs | Clear current tab logs |
| `Ctrl+F` | Search Logs | Focus search input |

## Mobile Shortcuts

On mobile devices, use the mobile keybar for quick access to:

| Key | Description |
| --- | --- |
| `Esc` | Escape key |
| `Tab` | Tab key |
| `Ctrl` | Control modifier (sticky) |
| `Alt` | Alt modifier (sticky) |
| `Shift` | Shift modifier (sticky) |
| `↑↓←→` | Arrow keys |
| `F1-F12` | Function keys (via Fn dropdown) |
| `Home/End` | Home and End keys |
| `PgUp/PgDn` | Page Up and Page Down |

## Mobile Gestures

| Gesture | Action | Description |
| --- | --- | --- |
| Swipe Left/Right | Switch Session | Navigate between terminal sessions |
| Long Press | Context Menu | Open context menu for session |
| Pinch Zoom | Font Size | Adjust terminal font size |
| Two-Finger Scroll | Scroll Terminal | Scroll through terminal output |
| Pull Down | Refresh | Refresh current view |

## Notes

- **Sticky Modifiers**: On mobile, Ctrl/Alt/Shift keys are "sticky" - tap once to activate, tap again to deactivate.
- **Chord Shortcuts**: Some shortcuts require pressing multiple keys simultaneously (e.g., `Ctrl+Alt+N`).
- **Context-Sensitive**: Some shortcuts only work in specific contexts (e.g., terminal, preview, DevTools).
- **Customization**: Keyboard shortcuts may be customizable in future versions.

## Tips

1. **Learn 5 Core Shortcuts**: Start with `Ctrl+Alt+N` (new terminal), `Ctrl+Alt+C` (Claude), `Ctrl+Alt+P` (preview), `Ctrl+Alt+F` (files), and `Ctrl+Alt+S` (settings).

2. **Use Session Numbers**: `Ctrl+Alt+1` through `Ctrl+Alt+9` for quick session switching.

3. **Mobile Keybar**: Enable the mobile keybar for essential keys on touch devices.

4. **Search is Powerful**: Use `Ctrl+Shift+F` in terminal to search through output history.

5. **Split Panes for Multi-Tasking**: Use split panes to monitor multiple terminals simultaneously.
