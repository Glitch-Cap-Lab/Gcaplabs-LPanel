// A real process exit prevents the controller's catch/finally from performing compensation.
process.env.PROTECTED_RELEASE_FIXTURE_ONLY = "1";
const { fixture } = require("./protectedRelease.test");
(async () => {
  const root = process.argv[2], boundary = process.argv[3];
  const f = await fixture({ after() {} }, { root, killAfterCreate: boundary === "create", killAfterRestore: boundary === "restore", killAfterStop: boundary === "stop", killAfterStage: boundary === "stage", killAfterRestoreName: boundary === "restoreName", killAfterOldStart: boundary === "oldStart" });
  if (["restore", "restoreName", "oldStart"].includes(boundary)) f.faults.health = true;
  await f.run();
  process.exitCode = 99;
})().catch(error => { console.error(error); process.exitCode = 98; });
