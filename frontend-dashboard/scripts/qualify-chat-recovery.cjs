async (page) => {
  const results = [],
    posts = [],
    resolves = [];
  const origin = "http://127.0.0.1:3139/app/__chat-recovery-local";
  let mode = "queued",
    owner = "operator-a",
    held,
    release,
    identity,
    terminal = false;
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const receipt = () => ({
    admission_id: "canonical-admission",
    ref: { profile_id: "root-profile", session_id: identity.sessionId },
    sequence: 1,
    authority_epoch: 3,
    execution_generation: 4,
    status: terminal ? "terminal" : "unknown",
    outcome: terminal ? "interrupted" : null,
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { id: owner } });
    if (!url.pathname.includes("/hermes-ui/chat")) return route.fulfill({ json: {} });
    if (url.pathname.endsWith("/resolve")) {
      resolves.push(req.postDataJSON());
      terminal = true;
      return route.abort("connectionfailed"); // Committed; every response byte lost.
    }
    if (req.method() === "GET")
      return route.fulfill({
        json: {
          runId: "canonical-run",
          status: terminal ? "cancelled" : "unknown",
          receipt: receipt(),
          historyAvailable: true,
          history: [
            { role: "user", content: "Sent once" },
            ...(terminal ? [{ role: "assistant", content: "Settled response" }] : []),
          ],
        },
      });
    identity = req.postDataJSON();
    posts.push(identity);
    const saved = await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith("headmaster-chat-pending"))
        .map((k) => sessionStorage.getItem(k)),
    );
    assert(
      saved.some((value) => JSON.parse(value).requestId === identity.requestId),
      "identity was not persisted before POST",
    );
    assert(
      saved.every((value) => !value.includes("Sent once")),
      "prompt leaked to sessionStorage",
    );
    if (mode === "held") {
      held = true;
      await new Promise((resolve) => {
        release = resolve;
      });
      return route.fulfill({ json: { message: "LATE PRIVATE REPLY" } });
    }
    if (mode === "refusal")
      return route.fulfill({ status: 403, json: { error: "Permission refused" } });
    if (mode === "owner-change") {
      owner = "operator-b";
      return route.fulfill({ json: { message: "OTHER OWNER PRIVATE REPLY" } });
    }
    if (mode === "transport") return route.abort("connectionfailed");
    return route.fulfill({ status: 409, json: { code: "admission_queued", error: "queued" } });
  });
  await page.goto(origin);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  const textbox = page.getByRole("textbox"),
    send = page.getByRole("button", { name: "Send", exact: true }),
    reset = page.getByRole("button", { name: "Reset", exact: true });
  await textbox.fill("Sent once");
  await send.click();
  await page.getByText("Request queued", { exact: true }).waitFor();
  assert(
    (await send.isDisabled()) && (await reset.isDisabled()),
    "queued request can be resent or reset",
  );
  assert((await textbox.inputValue()) === "", "queued request restored as draft");
  assert(
    (await page.getByText("Sent once", { exact: true }).count()) === 1,
    "sent turn disappeared",
  );
  await page.screenshot({ path: "../evidence/lpanel-chat-recovery/queued.png", fullPage: true });
  results.push("queued retained, checkpoint before POST, no prompt stored");
  await page.reload();
  await page.getByText("Request queued", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Refresh request", exact: true }).click();
  await page.getByText("Request needs a decision", { exact: true }).waitFor();
  await page.screenshot({ path: "../evidence/lpanel-chat-recovery/unknown.png", fullPage: true });
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Discard remaining work", exact: true }).click();
  assert(resolves.length === 0, "dismissed confirmation resolved");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Discard remaining work", exact: true }).click();
  await page.getByRole("button", { name: "Refresh request", exact: true }).waitFor();
  await page.getByRole("button", { name: "Refresh request", exact: true }).click();
  await page.getByText("Settled response", { exact: true }).waitFor();
  assert(posts.length === 1 && resolves.length === 1, "ambiguous input or resolution was replayed");
  assert(
    resolves[0].receipt.admission_id === "canonical-admission" &&
      resolves[0].receipt.execution_generation === 4,
    "wrong resolution fence",
  );
  assert(!(await textbox.isDisabled()), "settled request did not unlock composer");
  results.push(
    "reload, authenticated history, exact explicit resolution, lost ACK refresh without resend",
  );
  mode = "refusal";
  await textbox.fill("Correctable prompt");
  await send.click();
  await page.getByText("Permission refused", { exact: true }).waitFor();
  assert(
    (await textbox.inputValue()) === "Correctable prompt" && !(await send.isDisabled()),
    "known refusal stranded draft",
  );
  results.push("known permission refusal restores correctable draft");
  mode = "held";
  await textbox.fill("Old target secret");
  await send.click();
  await page.waitForFunction(() => !!document.querySelector("[role=status]"));
  while (!held) await new Promise((resolve) => setTimeout(resolve, 10));
  await page.getByRole("button", { name: "Switch target fixture", exact: true }).click();
  release();
  await textbox.waitFor();
  assert((await textbox.inputValue()) === "", "target change kept draft");
  assert(
    (await page.getByText("LATE PRIVATE REPLY", { exact: true }).count()) === 0 &&
      (await page.getByText("Old target secret", { exact: true }).count()) === 0,
    "late target reply leaked",
  );
  results.push("late target reply ignored; old identity checkpoint retained");
  await page.evaluate(() => sessionStorage.clear());
  mode = "owner-change";
  await page.goto(origin);
  await textbox.fill("Owner secret");
  await send.click();
  await page
    .getByText("Your account changed. Refresh the runtime before continuing.", { exact: true })
    .waitFor();
  assert(
    (await page.getByText("OTHER OWNER PRIVATE REPLY", { exact: true }).count()) === 0 &&
      (await page.getByText("Owner secret", { exact: true }).count()) === 0,
    "changed-owner reply leaked",
  );
  assert(await textbox.isDisabled(), "owner change left composer enabled");
  results.push("cookie-owner change rejects late reply and locks composer");
  owner = "operator-a";
  mode = "transport";
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(origin);
  await textbox.fill("Transport uncertain");
  await send.click();
  await page.getByText("Request status unconfirmed", { exact: true }).waitFor();
  assert(
    (await textbox.isDisabled()) && (await textbox.inputValue()) === "",
    "transport failure restored sendable prompt",
  );
  await page.reload();
  await page.getByText("Request status unconfirmed", { exact: true }).waitFor();
  results.push("transport loss remains blocked after reload");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await textbox.fill("Storage refused");
  const before = posts.length;
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("storage disabled");
    };
  });
  await send.click();
  await page.getByText("Chat is paused", { exact: true }).waitFor();
  assert(posts.length === before, "storage failure still dispatched input");
  results.push("checkpoint write failure stops POST");
  await page.evaluate(
    (result) => {
      window.__chatQualification = result;
    },
    { results, inputPosts: posts.length, resolutionPosts: resolves.length },
  );
  console.log(
    JSON.stringify({ results, inputPosts: posts.length, resolutionPosts: resolves.length }),
  );
}
