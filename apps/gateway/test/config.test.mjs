import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveChromeHeadless,
  resolveDefaultUrl,
  resolveTargetUrl,
} from "../src/config.mjs";

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

test("uses a blank page unless the gateway default is configured", () => {
  assert.equal(resolveDefaultUrl(undefined), "about:blank");
  assert.equal(resolveDefaultUrl(""), "about:blank");
  assert.equal(resolveDefaultUrl("https://example.com/start"), "https://example.com/start");
});

test("allows blank, HTTP, and HTTPS targets only", () => {
  assert.equal(resolveTargetUrl("about:blank"), "about:blank");
  assert.equal(resolveTargetUrl("https://example.com/start"), "https://example.com/start");
  assert.equal(resolveTargetUrl("http://example.com"), "http://example.com/");
  assert.throws(() => resolveTargetUrl("file:///tmp/private"), /只允许/);
  assert.throws(() => resolveTargetUrl("chrome://settings"), /只允许/);
});
