import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { needsTranscode, transcodeWav } from "./transcode.mjs";

// A fake ffmpeg: records its arguments and what it was fed, then answers like the script says.
function fakeSpawn(script) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => child.emit("close", null);
    const fed = [];
    child.stdin.on("data", (chunk) => fed.push(chunk));
    calls.push({ command, args, options, fed });
    queueMicrotask(() => script(child));
    return child;
  };
  return { spawnImpl, calls };
}

test("wav passes through; every other format is converted", () => {
  assert.equal(needsTranscode("wav"), false);
  for (const format of ["mp3", "opus", "aac", "flac", "pcm"]) assert.equal(needsTranscode(format), true);
});

test("runs ffmpeg without a shell, feeds it the WAV and returns the converted audio with its type", async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => {
    child.stdout.write(Buffer.from([1, 2, 3]));
    child.emit("close", 0);
  });
  const result = await transcodeWav(Buffer.from([9, 9]), "opus", { spawnImpl });
  assert.deepEqual(result, { audio: Buffer.from([1, 2, 3]), contentType: "audio/ogg" });
  const [call] = calls;
  assert.equal(call.command, "ffmpeg");
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.args.slice(0, 5), ["-hide_banner", "-loglevel", "error", "-i", "pipe:0"]);
  assert.ok(call.args.includes("libopus"));
  assert.equal(call.args.at(-1), "pipe:1");
  assert.deepEqual(Buffer.concat(call.fed), Buffer.from([9, 9]));
});

test("a missing ffmpeg, a failing one, an empty result and an unknown format are all 'unavailable'", async () => {
  const missing = fakeSpawn((child) => child.emit("error", new Error("ENOENT")));
  assert.deepEqual(await transcodeWav(Buffer.from([1]), "mp3", { spawnImpl: missing.spawnImpl }), { error: "unavailable" });
  const failing = fakeSpawn((child) => child.emit("close", 1));
  assert.deepEqual(await transcodeWav(Buffer.from([1]), "mp3", { spawnImpl: failing.spawnImpl }), { error: "unavailable" });
  const empty = fakeSpawn((child) => child.emit("close", 0));
  assert.deepEqual(await transcodeWav(Buffer.from([1]), "mp3", { spawnImpl: empty.spawnImpl }), { error: "unavailable" });
  assert.deepEqual(await transcodeWav(Buffer.from([1]), "ogg"), { error: "unavailable" });
  const throwing = () => {
    throw new Error("spawn failed");
  };
  assert.deepEqual(await transcodeWav(Buffer.from([1]), "mp3", { spawnImpl: throwing }), { error: "unavailable" });
});

test("a hung ffmpeg is killed at the timeout", async () => {
  let killed = false;
  const hung = fakeSpawn(() => {});
  const spawnImpl = (...args) => {
    const child = hung.spawnImpl(...args);
    child.kill = () => {
      killed = true;
    };
    return child;
  };
  assert.deepEqual(await transcodeWav(Buffer.from([1]), "mp3", { spawnImpl, timeoutMs: 20 }), { error: "timeout" });
  assert.equal(killed, true);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

// One second of silence as a 16-bit mono WAV, built by hand.
function silentWav(seconds = 1, rate = 24000) {
  const samples = seconds * rate;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

test("real ffmpeg produces an mp3 and an Ogg Opus file", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const mp3 = await transcodeWav(silentWav(), "mp3");
  assert.equal(mp3.contentType, "audio/mpeg");
  assert.ok(mp3.audio.length > 0);
  // An mp3 starts with an ID3 tag or a frame sync (0xFFEx).
  assert.ok(mp3.audio.subarray(0, 3).toString() === "ID3" || (mp3.audio[0] === 0xff && (mp3.audio[1] & 0xe0) === 0xe0));
  const opus = await transcodeWav(silentWav(), "opus");
  assert.equal(opus.contentType, "audio/ogg");
  assert.equal(opus.audio.subarray(0, 4).toString(), "OggS");
});
