import "@testing-library/jest-dom/vitest";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver;
HTMLCanvasElement.prototype.getContext = (() => ({
  clearRect() {},
  drawImage() {},
})) as typeof HTMLCanvasElement.prototype.getContext;

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

const local = new MemoryStorage();
const session = new MemoryStorage();
Object.defineProperty(window, "localStorage", { configurable: true, value: local });
Object.defineProperty(window, "sessionStorage", { configurable: true, value: session });
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: local,
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: session,
});
