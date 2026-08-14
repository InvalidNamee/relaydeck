import assert from "node:assert/strict";
import test from "node:test";
import { resolveChromeHeadless } from "../src/config.mjs";

test("forces headless Chrome on Linux without a display server", () => {
  assert.equal(
    resolveChromeHeadless({ platform: "linux", configured: false, hasDisplay: false }),
    true,
  );
  assert.equal(
    resolveChromeHeadless({ platform: "linux", configured: false, hasDisplay: true }),
    false,
  );
  assert.equal(
    resolveChromeHeadless({ platform: "linux", configured: true, hasDisplay: true }),
    true,
  );
  assert.equal(
    resolveChromeHeadless({ platform: "darwin", configured: false, hasDisplay: false }),
    false,
  );
});
