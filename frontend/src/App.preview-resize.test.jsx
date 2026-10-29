import { expect, it, vi } from 'vitest';
import { openSidebarApp } from './test/sidebarApps.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App.jsx';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture.js';

it('actual App terminal-versus-Preview divider is reachable and operable by keyboard',async()=>{
  const fixture=installSelectionPaneR1Fixture();
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
  try {
    const view=render(<App/>);
    fireEvent.change(await screen.findByLabelText('Username'),{target:{value:R1.username}});
    fireEvent.change(screen.getByLabelText('Password'),{target:{value:R1.password}});
    fireEvent.click(screen.getByRole('button',{name:'Initialize Session'}));
    fireEvent.click(await openSidebarApp('Preview'));
    fireEvent.click(await screen.findByRole('button',{name:'More browser tools',exact:true}));
    fireEvent.click(screen.getByRole('button',{name:'Show Main Terminal',exact:true}));
    const divider=view.container.querySelector('main.main-content > .split-handle');
    expect(divider).toBeInTheDocument();
    expect(fixture.unexpected).toEqual([]);
    expect(divider).toHaveAttribute('role','separator');
    expect(divider).toHaveAttribute('tabindex','0');
    expect(divider).toHaveAttribute('aria-orientation', 'vertical');
    const retained = [...view.container.querySelectorAll('[data-pane-host], textarea.status-composer-input')];
    divider.focus();
    for (const [key, shiftKey, width] of [['ArrowRight', false, 55], ['ArrowLeft', true, 45], ['Home', false, 20], ['End', false, 80], ['Enter', false, 50]]) {
      fireEvent.keyDown(divider, { key, shiftKey });
      expect(divider).toHaveAttribute('aria-valuenow', String(width));
    }
    const main = divider.closest('main');
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ left: 200, width: 1000 });
    const pointer = (target, type, clientX, pointerId = 7) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
      Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true }, pointerType: { value: 'touch' } });
      fireEvent(target, event);
    };
    pointer(divider, 'pointerdown', 700);
    pointer(document, 'pointermove', 850);
    expect(divider).toHaveAttribute('aria-valuenow', '65');
    pointer(document, 'pointercancel', 850);
    expect(divider).not.toHaveClass('active');
    pointer(document, 'pointermove', 1050);
    expect(divider).toHaveAttribute('aria-valuenow', '65');
    expect([...view.container.querySelectorAll('[data-pane-host], textarea.status-composer-input')]).toEqual(retained);
    expect(fixture.sendCalls()).toEqual([]);
    expect(fixture.socketWrites).toEqual([]);
  } finally {cleanup();fixture.restore();vi.unstubAllGlobals();}
});
