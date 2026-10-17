import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import InboundSecretDialog from "../components/agents/InboundSecretDialog";
import {
  ROTATION_BODY,
  revealFromCreateResponse,
  revealFromRotateResponse,
} from "./inboundSecret";

test("the create response secret is picked up, not discarded", () => {
  const reveal = revealFromCreateResponse({ id: "c1", inbound_secret: "a".repeat(64) }, "Ops");
  assert.equal(reveal?.secret, "a".repeat(64));
  assert.equal(reveal?.reason, "created");
});

test("a redacted or missing secret is never offered for display", () => {
  assert.equal(revealFromCreateResponse({ inbound_secret: "[REDACTED]" }, "Ops"), null);
  assert.equal(revealFromCreateResponse({ config: { inbound_secret: "[REDACTED]" } }, "Ops"), null);
  assert.equal(revealFromCreateResponse(null, "Ops"), null);
});

test("the secret shows once with a warning, and is gone after the dialog closes", () => {
  const secret = "b".repeat(64);
  const reveal = revealFromCreateResponse({ inbound_secret: secret }, "Ops");
  const shown = renderToStaticMarkup(
    createElement(InboundSecretDialog, { reveal, onClose: () => {} }),
  );
  assert.ok(shown.includes(secret));
  assert.match(shown, /won&#x27;t see this again/);

  // Closing drops the reveal; nothing of the secret is rendered afterwards.
  const afterClose = renderToStaticMarkup(
    createElement(InboundSecretDialog, { reveal: null, onClose: () => {} }),
  );
  assert.equal(afterClose, "");
});

test("rotation asks the server for the secret and shows only what it returns", () => {
  assert.deepEqual(ROTATION_BODY, { rotate_inbound_secret: true });
  assert.ok(!("config" in ROTATION_BODY));
  const reveal = revealFromRotateResponse({ id: "c1", inbound_secret: "c".repeat(64) }, "Ops");
  assert.equal(reveal?.secret, "c".repeat(64));
  assert.equal(reveal?.reason, "rotated");
  assert.equal(revealFromRotateResponse({ id: "c1", inbound_secret: "[REDACTED]" }, "Ops"), null);
});
