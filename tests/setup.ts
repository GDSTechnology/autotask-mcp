// Jest Setup File
// Configure test environment and global settings

import { config } from 'dotenv';

// Load environment variables from .env file if it exists
config();

// Set test timeout for longer-running API tests
jest.setTimeout(30000);

// Global test setup
beforeAll(() => {
  // Suppress console.log during tests unless explicitly testing logging
  if (process.env.NODE_ENV === 'test' && !process.env.VERBOSE_TESTS) {
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  }
});

// The Autotask read cache is module-level (per API user) — start every test
// cold so a response cached by one test can never be served to the next.
import { _resetHttpCache } from '../src/services/http-cache';
// Same for the auth-failure pause: a 401 in one test must not pause the next.
import { _resetAuthBlocks } from '../src/services/autotask-http';
beforeEach(() => {
  _resetHttpCache();
  _resetAuthBlocks();
});

// Global test cleanup
afterAll(() => {
  // Any cleanup operations
}); 