// Audio format conversion for the speech route. A speech engine that answers one format (Munsit: WAV)
// is converted here to the format the runtime asked for, so Telegram and WhatsApp voice bubbles (Ogg
// Opus) and ordinary mp3 players work. ffmpeg runs without a shell, reads the WAV on stdin and writes the
// result on stdout; it is killed on timeout and its output is capped. The relay image carries ffmpeg.

import { spawn } from "node:child_process";

export const TRANSCODE_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

// response_format -> ffmpeg output arguments and the content type of the result. The runtime picks the
// format from the output file's extension: .ogg is opus, .wav is wav, anything else mp3.
const OUTPUTS = {
  mp3: { args: ["-f", "mp3", "-codec:a", "libmp3lame", "-q:a", "4"], contentType: "audio/mpeg" },
  opus: { args: ["-f", "ogg", "-codec:a", "libopus", "-b:a", "32k", "-application", "voip"], contentType: "audio/ogg" },
  aac: { args: ["-f", "adts", "-codec:a", "aac", "-b:a", "64k"], contentType: "audio/aac" },
  flac: { args: ["-f", "flac"], contentType: "audio/flac" },
  pcm: { args: ["-f", "s16le", "-ac", "1"], contentType: "audio/pcm" },
};

/** True when `format` needs a conversion from WAV (wav itself is passed through). */
export function needsTranscode(format) {
  return Object.hasOwn(OUTPUTS, format);
}

/**
 * Resolves { audio, contentType } or { error: "unavailable" | "timeout" }. Never throws.
 * `spawnImpl` is injectable for tests.
 */
export function transcodeWav(wav, format, { spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const output = OUTPUTS[format];
  if (!output) return Promise.resolve({ error: "unavailable" });
  return new Promise((resolve) => {
    let settled = false;
    const chunks = [];
    let size = 0;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({ error: "timeout" });
    }, timeoutMs);
    try {
      child = spawnImpl("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...output.args, "pipe:1"], {
        stdio: ["pipe", "pipe", "ignore"],
        shell: false,
      });
    } catch {
      return finish({ error: "unavailable" });
    }
    child.on("error", () => finish({ error: "unavailable" }));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > TRANSCODE_MAX_BYTES) {
        child.kill("SIGKILL");
        finish({ error: "unavailable" });
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0 || size === 0) return finish({ error: "unavailable" });
      finish({ audio: Buffer.concat(chunks), contentType: output.contentType });
    });
    child.stdin.end(wav);
  });
}
