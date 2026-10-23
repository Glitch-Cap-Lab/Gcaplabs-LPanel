// @ts-nocheck
// Organization files (Headmaster WS13): a team organization's shared folder is a host directory
// per organization, written only by the chat bridge. Every member's runtime sees it read-only
// as "Organization files" in the workspace, so bots read it like any folder and a bot cannot
// change or delete what the organization shares. Off unless the operator names the host root.
const path = require("node:path");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORG_FILES_MOUNT = "/opt/data/workspace/Organization files";

/** The Docker bind for an organization's folder, or null when the feature is off or the id is not one. */
function orgFilesBind(orgId, hostRoot = process.env.HEADMASTER_ORG_FILES_HOST_ROOT) {
  const root = typeof hostRoot === "string" ? hostRoot.trim() : "";
  if (!root || !path.posix.isAbsolute(root) || root.includes(":") || root.split("/").includes("..")) return null;
  if (typeof orgId !== "string" || !UUID.test(orgId)) return null;
  return `${path.posix.join(root, orgId)}:${ORG_FILES_MOUNT}:ro`;
}

module.exports = { orgFilesBind, ORG_FILES_MOUNT };
