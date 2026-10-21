// @ts-nocheck
// Existing account bearer stays in this process. Never put it in argv, env,
// manifests, queue data, deployment receipts, or diagnostic errors.
const { refuse } = require("../../workers/provisioner/protectedReleaseManifest");
async function readAccessToken(input) {
  if (input.isTTY) throw refuse("PROTECTED_RELEASE_PROTECTED_STDIN_REQUIRED");
  const chunks = []; let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > 8192) throw refuse("PROTECTED_RELEASE_TOKEN_INVALID");
    chunks.push(Buffer.from(chunk));
  }
  const token = Buffer.concat(chunks).toString("utf8").trim();
  for (const chunk of chunks) chunk.fill(0);
  if (!token || /\s/.test(token)) throw refuse("PROTECTED_RELEASE_TOKEN_INVALID");
  return token;
}
function createOwnerClient({ origin, accessToken, fetchImpl = fetch }) {
  let url; try { url = new URL(origin); } catch { throw refuse("PROTECTED_RELEASE_OWNER_UNAVAILABLE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !accessToken || accessToken.length > 8192 || /\s/.test(accessToken)) throw refuse("PROTECTED_RELEASE_OWNER_UNAVAILABLE");
  const call = async (path, method, body) => {
    try {
      const res = await fetchImpl(`${url.origin}/api/headmaster/v1/admin/runtime-releases/${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${accessToken}`, ...(body ? {"content-type":"application/json"} : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new Error("unconfirmed");
      const reader = res.body?.getReader(); if (!reader) throw new Error("unconfirmed");
      const chunks=[];let bytes=0;
      try { for (;;) { const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8192){await reader.cancel();throw new Error("unconfirmed");}chunks.push(Buffer.from(value)); } }
      finally {reader.releaseLock();}
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
      if (!data || !/^[0-9a-f]{64}$/.test(data.release_id) || typeof data.metadata_finalized !== "boolean") throw new Error("unconfirmed");
      return data;
    } catch { throw refuse("PROTECTED_RELEASE_OWNER_UNCONFIRMED"); }
  };
  return {
    prepare: (manifest,releaseId) => call("prepare","POST",{manifest,release_id:releaseId}),
    finalize: releaseId => call(`${releaseId}/finalize`,"POST"),
    status: releaseId => call(releaseId,"GET"),
  };
}
module.exports = {createOwnerClient,readAccessToken};
