import test from "node:test";
import assert from "node:assert/strict";
import { isNavItemVisible } from "./adminNav";

test("ungated nav items are always visible", () => {
  assert.equal(isNavItemVisible("/users", null), true);
});

test("Kubernetes and Remote Hosts follow the backend catalog", () => {
  const dockerOnly = { enabledBackends: ["docker"], remoteHostsEnabled: false };
  assert.equal(isNavItemVisible("/kubernetes", dockerOnly), false);
  assert.equal(isNavItemVisible("/remote-hosts", dockerOnly), false);
  assert.equal(isNavItemVisible("/kubernetes", null), false);
  const all = { enabledBackends: ["docker", "k8s"], remoteHostsEnabled: true };
  assert.equal(isNavItemVisible("/kubernetes", all), true);
  assert.equal(isNavItemVisible("/remote-hosts", all), true);
});
