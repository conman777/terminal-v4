import { describe, expect, it } from 'vitest';
import { environmentAllows } from './runtimePermissions';
describe('environmentAllows', () => {
 it('allows the authenticated home host and only explicit remote capabilities', () => {
  expect([environmentAllows(null, 'terminalInput'), environmentAllows({id:'remote'}, 'terminalInput'), environmentAllows({capabilities:{terminalInput:true}}, 'terminalInput'), environmentAllows({capabilities:{terminalInput:'true'}}, 'terminalInput'), environmentAllows({capabilities:{terminalInput:true}}, 'agentExecute')]).toEqual([true,false,true,false,false]);
 });
});
