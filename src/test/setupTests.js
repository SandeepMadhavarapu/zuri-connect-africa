import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

class StorageMock {
  constructor() {
    this.store = {};
  }
  getItem(key) {
    return this.store[key] ?? null;
  }
  setItem(key, value) {
    this.store[key] = String(value);
  }
  removeItem(key) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
  get length() {
    return Object.keys(this.store).length;
  }
  key(i) {
    return Object.keys(this.store)[i] ?? null;
  }
}

Object.defineProperty(globalThis, 'sessionStorage', {
  value: new StorageMock(),
  writable: true,
});

Object.defineProperty(globalThis, 'localStorage', {
  value: new StorageMock(),
  writable: true,
});

if (!globalThis.crypto?.subtle) {
  globalThis.crypto = webcrypto;
}

if (typeof HTMLCanvasElement !== 'undefined' && !HTMLCanvasElement.prototype.getContext._zuriPatched) {
  const ctx2d = {
    fillRect: () => {},
    fillText: () => {},
    measureText: () => ({ width: 0 }),
    getImageData: () => ({ data: new Uint8ClampedArray(64) }),
  };
  HTMLCanvasElement.prototype.getContext = function patchedGetContext() {
    ctx2d.canvas = this;
    return ctx2d;
  };
  HTMLCanvasElement.prototype.toDataURL = function toDataURLStub() {
    return 'data:image/png;base64,AAAA';
  };
  HTMLCanvasElement.prototype.getContext._zuriPatched = true;
}
