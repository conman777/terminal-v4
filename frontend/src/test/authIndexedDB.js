import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, afterEach } from 'vitest';

let originalIndexedDB;

beforeEach(() => {
  originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: new IDBFactory() });
});

afterEach(() => {
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
  else delete globalThis.indexedDB;
});
