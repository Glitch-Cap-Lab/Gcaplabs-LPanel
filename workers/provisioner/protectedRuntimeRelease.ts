// @ts-nocheck
// One local, retained-container release path inside the existing deployments worker.
const { validateManifest, assertAgent, digest, refuse } = require("./protectedReleaseManifest");

/** A refusal code such as PROTECTED_RELEASE_ARCHIVE_INVALID, or null for anything else (free text can hold secrets). */
function failureCode(error) {
  const code = [error?.code, error?.message].find(value => typeof value === "string" && /^PROTECTED_RELEASE_[A-Z0-9_]{1,64}$/.test(value));
  return code || null;
}

async function runProtectedRuntimeRelease({ manifest: input, action = "apply", adapter, state, receipt = null, deploymentId = null, saveReceipt, dryRun = false }) {
  const { manifest, releaseId, target } = validateManifest(input);
  if (!["apply", "recover"].includes(action)) throw refuse("PROTECTED_RELEASE_ACTION_INVALID");
  const names = { old: `${target.container_name}-release-${releaseId.slice(0, 16)}`, stage: `.protected-release-${releaseId}` };
  let r = receipt ? JSON.parse(JSON.stringify(receipt)) : { release_id: releaseId, phase: "validated", candidate_id: null, deployment_id: deploymentId };
  if (r.release_id !== releaseId) throw refuse("PROTECTED_RELEASE_RECEIPT_MISMATCH");
  const record = async (phase, fields = {}) => {
    r = { ...r, ...fields, release_id: releaseId, phase, expected_binding: target.runtime,
      owner_id: target.owner_id, account_id: target.account_id, workspace_id: target.workspace_id,
      expected_lp_image: target.image_binding, external_metadata_confirmed: false, publication_blocked: true };
    // The volume receipt survives queue ACK loss/worker restart. Never contains env/config values.
    if (phase !== "validated") await adapter.writeReceipt(target, names, r);
    await saveReceipt(r);
  };
  const row = await state.read();
  const retained = await adapter.retained(target, names);
  const onDisk = await adapter.readReceipt(target, names);
  if (onDisk) {
    if (onDisk.release_id !== releaseId) throw refuse("PROTECTED_RELEASE_RECEIPT_MISMATCH");
    r = onDisk;
    if (action === "apply") throw refuse("PROTECTED_RELEASE_RECOVERY_REQUIRED");
  }
  if (retained && !["rolled_back", "external_metadata_pending"].includes(r.phase) && action === "apply") {
    throw refuse("PROTECTED_RELEASE_RECOVERY_REQUIRED");
  }
  if (action === "recover") {
    if (r.previous_status !== target.status) throw refuse("PROTECTED_RELEASE_RECEIPT_MISMATCH");
    if (onDisk?.phase === "rolled_back") { assertAgent(manifest, row); await state.rollback(manifest, null, onDisk.previous_status, onDisk); return onDisk; }
    if (!r.previous_status || (!r.staged && (retained || !["validated", "stopped", "restored", "recovery_required"].includes(r.phase)))) throw refuse("PROTECTED_RELEASE_RECOVERY_UNAVAILABLE");
    if (r.staged && (!onDisk || (!retained && !r.restored_before_old_start))) throw refuse("PROTECTED_RELEASE_RECOVERY_UNAVAILABLE");
  } else {
    assertAgent(manifest, row);
    try { await adapter.preflight(manifest, row, { dryRun }); }
    catch (error) {
      // No runtime mutation has begun. Compensate only this queued deployment under exact CAS.
      if (!dryRun) await state.rollback(manifest, null, target.status, r);
      throw error;
    }
    if (dryRun) return { release_id: releaseId, phase: "dry_run", publication_blocked: true, target: target.agent_id };
    if (retained) throw refuse("PROTECTED_RELEASE_RECOVERY_REQUIRED");
    r.previous_status = target.status;
  }

  const recover = async () => {
    const candidate = await adapter.candidate(target, releaseId);
    await state.assertRecoverable(manifest, candidate?.Id || r.candidate_id);
    if (r.staged && !(await adapter.retained(target, names))) {
      const observed = await adapter.observe(target);
      if (observed.retained.container_name !== target.container_name) throw refuse("PROTECTED_RELEASE_RETAINED_CHANGED");
      await adapter.stop(target.container_id);
    }
    if (!r.staged) {
      if (candidate || retained) throw refuse("PROTECTED_RELEASE_RECOVERY_UNAVAILABLE");
      await adapter.observe(target);
      await adapter.stop(target.container_id);
      await adapter.assertNoWriters(target.volume);
      await state.assertRecoverable(manifest, null);
      await adapter.cleanupStaging(names);
      await record("restored", { snapshot_restore_required: false });
      await state.rollback(manifest, null, r.previous_status, r);
      await adapter.start(target.container_id);
      await record("rolled_back", { old_started: true, lp_committed: false });
      return r;
    }
    if (candidate) {
      // A create ACK can be lost before candidate_id was recorded: require the immutable labels.
      // Identity only: a candidate the full check refused must still be stopped and set aside.
      await adapter.verifyCandidateIdentity(candidate, manifest, releaseId);
      r.candidate_id = candidate.Id;
      await adapter.stop(candidate.Id);
    }
    await adapter.assertNoWriters(target.volume);
    // Exact CAS refuses a newer deployment; never start an old writer over another owner's binding.
    await state.assertRecoverable(manifest, r.candidate_id);
    await adapter.restore(target, names, r.staged);
    await adapter.cleanupStaging(names);
    await record("restored", { restored_before_old_start: true });
    await state.rollback(manifest, r.candidate_id, r.previous_status, r);
    if (candidate) await adapter.retainFailed(candidate.Id, names);
    await adapter.restoreName(target, names);
    if (r.previous_status !== "stopped") await adapter.start(target.container_id);
    await record("rolled_back", { old_started: r.previous_status !== "stopped", lp_committed: false });
    return r;
  };

  if (action === "recover") return recover();
  let stopped = false;
  try {
    // Save immutable ownership before the first stop, even if a later queue update fails.
    await record("validated");
    await adapter.drain(target);
    await adapter.stop(target.container_id); stopped = true;
    await adapter.assertNoWriters(target.volume);
    await record("stopped");
    const staged = await adapter.stage(target, names, manifest.image);
    await record("staged", { staged });
    await state.assertRecoverable(manifest, null);
    await adapter.renameOld(target, names);
    await record("old_retained");
    const candidate = await adapter.create(manifest, names, releaseId);
    r.candidate_id = candidate.Id;
    await record("candidate_created");
    await adapter.checkImage(manifest, candidate.Id);
    await adapter.assertNoWriters(target.volume);
    await adapter.start(candidate.Id);
    await adapter.check(manifest, candidate.Id);
    await record("candidate_healthy");
    await state.commit(manifest, candidate.Id);
    // Account binding metadata is a separate owner; this slice cannot claim fleet/publication success.
    await record("external_metadata_pending", { lp_committed: true, lp_routing_tuple_preserved: true, external_binding_unchanged: null });
    return r;
  } catch (error) {
    if (adapter.signal?.aborted || ["PROTECTED_RELEASE_DOCKER_TIMEOUT", "PROTECTED_RELEASE_JOURNAL_UNCERTAIN", "ABORT_ERR", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error?.code)) {
      // A timed-out mutation may have reached Docker. Keep the old runtime stopped;
      // only a later explicit recovery may inspect the authoritative result.
      try { await record("recovery_required", { transport_uncertain: true, lp_committed: false }); } catch { /* last completed canonical boundary remains authoritative */ }
      throw refuse("PROTECTED_RELEASE_RECOVERY_REQUIRED");
    }
    // Keep only a fixed refusal code (never a Docker/DB message) so a failed swap says which check stopped it.
    r.failure_code = failureCode(error);
    // Extraction failure is before rename/create: old container can safely resume without a restore.
    if (stopped && !r.staged) {
      await recover();
    } else if (r.staged) {
      try { await recover(); }
      catch {
        try { await record("recovery_required"); } catch { /* volume receipt from last completed boundary remains */ }
        throw refuse("PROTECTED_RELEASE_RECOVERY_REQUIRED");
      }
    }
    // Fixed reason only: Docker/DB errors can contain credentials or private configuration.
    throw refuse("PROTECTED_RELEASE_FAILED");
  }
}

module.exports = { runProtectedRuntimeRelease, failureCode };
