import assert from "node:assert/strict";
import { test } from "node:test";

import { cloneFolder } from "../src/core/remotes.ts";

await test("a clone goes in the folder the URL ends in, and never anywhere a crafted URL would send it", () => {
  assert.equal(cloneFolder("https://dev.azure.com/acme/Platform/_git/uploader"), "uploader");
  assert.equal(cloneFolder("https://dev.azure.com/acme/Platform/_git/Billing%20API/"), "Billing API");
  for (const crafted of [
    "https://evil.example/x/..",
    "https://evil.example/x/%2E%2E",
    "https://evil.example/x/..%2F..%2Fhome",
    "https://evil.example/x/a%5Cb",
    "https://evil.example/x/a%00b",
    "https://evil.example/x/%2F",
    "https://evil.example/x/."
  ]) {
    assert.equal(cloneFolder(crafted), null, crafted);
  }
});
