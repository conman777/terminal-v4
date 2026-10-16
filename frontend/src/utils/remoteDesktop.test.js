import { describe, expect, it } from 'vitest';
import { desktopPoint, desktopKey } from './remoteDesktop';
describe('desktopPoint', () => {
  it('maps the displayed image to normalized capture coordinates', () => {
    expect(desktopPoint({ left: 20, top: 30, width: 800, height: 450 }, 420, 255)).toEqual({ x: 0.5, y: 0.5 });
  });
  it('rejects coordinates outside the image and invalid geometry', () => {
    expect([desktopPoint({left:20,top:30,width:800,height:450},19,100), desktopPoint({left:0,top:0,width:0,height:0},0,0)]).toEqual([null,null]);
  });
});

describe('desktopKey', () => {
  it('preserves supported physical keys and modifiers in a bounded command', () => {
    expect(desktopKey({code:'KeyA',ctrlKey:true,shiftKey:true})).toEqual({kind:'key',key:'KeyA',modifiers:['Control','Shift']});
  });
  it('rejects browser and modifier-only keys', () => {
    expect([desktopKey({code:'ControlLeft'}),desktopKey({code:'LaunchApp1'})]).toEqual([null,null]);
  });
});
