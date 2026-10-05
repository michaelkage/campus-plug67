import '@testing-library/jest-dom/vitest'

// Minimal localStorage mock for theme persistence tests.
const store: Record<string, string> = {}
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => {
    store[k] = v
  },
  removeItem: (k) => {
    delete store[k]
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k])
  },
  get length() {
    return Object.keys(store).length
  },
  key: (i) => Object.keys(store)[Number(i)] ?? null,
} as Storage
