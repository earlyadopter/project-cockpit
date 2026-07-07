# Testing Rules

## Preserve existing tests

- Never delete, skip, or disable existing tests unless explicitly asked
- If a test breaks because of your change, fix the test to match the new behavior — don't remove it
- If you're unsure why a test exists, ask before modifying it

## Run tests before declaring done

- After making code changes, run the relevant test suite
- If you don't know how to run tests in this project, check for: `package.json` scripts, `Makefile`, `pytest.ini`, `pyproject.toml`, or ask
- Don't commit code that breaks existing tests

## Write tests for new behavior

- When adding a new function, endpoint, or feature, add at least one test covering the happy path
- Match the existing test style and framework — don't introduce a new testing library
- Place test files where the project convention expects them

## Prefer real over mock

- Use real dependencies (database, filesystem, APIs) in tests when practical
- Only mock external services that are slow, flaky, or have side effects (email, payments, third-party APIs)
- Never mock internal modules just to make a test easier to write
- If a test needs complex setup, that's a signal the code may need simplification — not more mocks

## Test naming and structure

- Test names should describe the behavior being tested, not the implementation
- Good: `test_login_fails_with_expired_token`
- Bad: `test_validate_token_returns_false`
- Group related tests together; keep each test focused on one behavior
