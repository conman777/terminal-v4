import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileKeybar } from './MobileKeybar';
vi.mock('../contexts/TerminalSessionContext', () => ({ useTerminalSession: () => ({}) }));

describe('MobileKeybar height ownership', () => {
  it('releases height on conditional removal and ignores a previously queued resize callback', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(155);
    const listener = vi.spyOn(window, 'addEventListener'); const publish = vi.fn();
    const view = render(<MobileKeybar sessionId="owned-A" isOpen onHeightChange={publish} />);
    const resize = listener.mock.calls.find(([type]) => type === 'resize')[1];
    expect(publish.mock.calls.at(-1)).toEqual([155]);
    view.unmount();
    expect(publish.mock.calls.at(-1)).toEqual([0]);
    const calls = publish.mock.calls.length; resize(); fireEvent.resize(window);
    expect(publish.mock.calls.length).toBe(calls); height.mockRestore();
  });
});
