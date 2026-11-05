import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("every pattern attribute compiles as a v-flag regular expression", async () => {
  const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
  const patterns = [...html.matchAll(/pattern="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(patterns.length >= 2, "the server name fields keep their pattern attributes");
  for (const pattern of patterns) {
    assert.doesNotThrow(() => new RegExp(pattern, "v"), `pattern ${pattern} must compile under the v flag`);
  }
});
