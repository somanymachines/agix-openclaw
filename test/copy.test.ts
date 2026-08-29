import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { agixPlugin } from "../src/channel.js";

type PluginPackage = {
  description: string;
  openclaw: {
    channel: Record<string, unknown>;
  };
};

type PluginManifest = {
  description: string;
};

test("keeps user-facing channel metadata consistent", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as PluginPackage;
  const manifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as PluginManifest;

  assert.equal(manifest.description, packageJson.description);
  for (const field of ["label", "selectionLabel", "detailLabel", "docsPath", "docsLabel", "blurb"] as const) {
    assert.equal(packageJson.openclaw.channel[field], agixPlugin.meta[field]);
  }
  assert.equal(packageJson.openclaw.channel.markdownCapable, false);
  assert.equal(agixPlugin.meta.markdownCapable, false);
});

test("preserves configured status when OpenClaw passes a sanitized account to the snapshot builder", async () => {
  const cfg = {
    channels: {
      agix: {
        accounts: {
          calendar: {
            agent: "calendar",
            enabled: true,
            accessToken: "secret-token",
          },
        },
      },
    },
  };
  const inspected = agixPlugin.config.inspectAccount!(cfg as any, "calendar");
  assert.equal("accessToken" in (inspected as object), false);

  const snapshot = await agixPlugin.status!.buildAccountSnapshot!({
    account: inspected as any,
    cfg: cfg as any,
    runtime: { accountId: "calendar", running: true, connected: true },
    probe: { ok: true, agent: "agix/calendar", connected: true },
  });

  assert.equal(snapshot.accountId, "calendar");
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.tokenStatus, "available");
  assert.equal(snapshot.connected, true);
});
