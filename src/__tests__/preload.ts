/**
 * Test preload — runs before every test file.
 * Clears environment variables that would interfere with test isolation.
 */

// Auth middleware reads this at request time; clear it so tests don't need API keys
delete process.env.MERIDIAN_API_KEY
