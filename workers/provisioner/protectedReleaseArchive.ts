// @ts-nocheck
// Stopped-container archives only. No extraction of a whole runtime home or database.
const tar = require("tar-stream");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const fs = require("fs");
const fsp = require("fs/promises");
const { pipeline } = require("stream/promises");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const bad = () => new Error("PROTECTED_RELEASE_ARCHIVE_INVALID");
const MAX_BYTES = 8 * 1024 * 1024 * 1024;

function archivePath(raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\\") || raw.includes("\0") || path.posix.isAbsolute(raw)
      || raw.split("/").includes("..")) throw bad();
  return path.posix.normalize(raw).replace(/^\.\//, "").replace(/\/$/, "");
}

/** Validate a real tar stream before any upload. Bounded snapshot payload is retained by the caller. */
async function readArchive(input, root, { maxBytes = 16 * 1024 * 1024, maxEntries = 200000, spoolDirectory = null, hashOnly = false } = {}) {
  const extract = tar.extract(), entries = [], seen = new Set();
  let total = 0;
  const done = new Promise((resolve, reject) => {
    extract.on("error", reject); extract.on("finish", resolve);
    extract.on("entry", async (header, stream, next) => {
      const chunks = []; let handle;
      try {
        const name = archivePath(header.name);
        if ((name !== root && !name.startsWith(root + "/")) || seen.has(name) || entries.length >= maxEntries
            || !["file", "directory", "symlink", "link"].includes(header.type) || (header.mode & 0o7000)) throw bad();
        seen.add(name);
        if (!Number.isSafeInteger(header.size) || header.size < 0 || total + header.size > maxBytes) throw bad();
        const entry = { ...header, name, mode: header.mode & 0o777, bytes: 0 };
        entries.push(entry);
        const digest = crypto.createHash("sha256");
        if (spoolDirectory && header.type === "file") {
          entry.contentPath = path.join(spoolDirectory, String(entries.length));
          handle = await fsp.open(entry.contentPath, "wx", 0o600);
        }
        for await (const chunk of stream) {
          total += chunk.length;
          if (total > maxBytes) throw bad();
          entry.bytes += chunk.length; digest.update(chunk);
          if (handle) await handle.writeFile(chunk); else if (!hashOnly) chunks.push(Buffer.from(chunk));
        }
        if (entry.bytes !== (header.type === "file" ? header.size : 0)) throw bad();
        if (handle) { await handle.sync(); await handle.close(); handle = null; }
        else if (!hashOnly) entry.content = Buffer.concat(chunks);
        entry.sha256 = digest.digest("hex"); next();
      } catch (error) { if (handle) await handle.close().catch(() => {}); stream.resume(); extract.destroy(error); }
    });
  });
  (Buffer.isBuffer(input) ? Readable.from(input) : input).on("error", error => extract.destroy(error)).pipe(extract);
  await done;
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  for (const entry of entries) {
    for (let parent = path.posix.dirname(entry.name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (["symlink", "link"].includes(byName.get(parent)?.type)) throw bad();
    }
    if (entry.type === "link") {
      const target = archivePath(entry.linkname);
      if (!byName.has(target) || byName.get(target).type !== "file") throw bad();
      entry.linkname = target;
    }
    if (entry.type === "symlink") {
      const target = entry.linkname;
      if (typeof target !== "string" || !target || target.includes("\0") || target.includes("\\")) throw bad();
      if (path.posix.isAbsolute(target)) {
        // PM interpreters may point into the immutable image; never follow these links during restore.
        if (!/^\/(?:usr\/(?:local\/)?bin|opt\/hermes\/\.venv\/bin)\/[A-Za-z0-9_.-]+$/.test(target)
            && !path.posix.normalize(target).startsWith("/opt/data/installs/")) throw bad();
      } else {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.name), target));
        if (resolved !== root && !resolved.startsWith(root + "/")) throw bad();
      }
    }
  }
  if (!entries.length || !byName.has(root) || byName.get(root).type !== (root === "installs" ? "directory" : "file")) throw bad();
  return entries;
}

function packStream(entries, { prefix = "", uid = 10000, gid = 10000, preserveOwnership = false } = {}) {
  const pack = tar.pack();
  (async () => {
    if (prefix) {
      const parts = prefix.split("/");
      for (let i = 1; i <= parts.length; i++) await new Promise((resolve, reject) => pack.entry({ name: parts.slice(0, i).join("/"), type: "directory", uid: 0, gid: 0, mode: 0o700 }, error => error ? reject(error) : resolve()));
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const linkname = entry.type === "link" && prefix ? `${prefix}/${entry.linkname}` : entry.linkname;
      const header = { name, linkname, type: entry.type, mode: entry.mode, uid: preserveOwnership ? entry.uid ?? uid : uid, gid: preserveOwnership ? entry.gid ?? gid : gid,
        size: entry.type === "file" ? (entry.bytes ?? entry.content.length) : 0 };
      if (entry.contentPath) {
        await pipeline(fs.createReadStream(entry.contentPath), pack.entry(header));
      } else await new Promise((resolve, reject) => pack.entry(header, entry.type === "file" ? entry.content : undefined, error => error ? reject(error) : resolve()));
    }
    pack.finalize();
  })().catch(error => pack.destroy(error));
  return pack;
}

async function archiveRoot(input) {
  const extract = tar.extract();
  return new Promise((resolve, reject) => {
    let found = false;
    input.on("error", error => { if (!found) reject(error); });
    extract.on("error", error => { if (!found) reject(error); });
    extract.on("finish", () => { if (!found) reject(bad()); });
    extract.once("entry", (header, stream) => {
      found = true; input.unpipe(extract); input.destroy(); stream.resume(); extract.destroy(); resolve(header);
    });
    input.pipe(extract);
  });
}

async function packArchive(entries, options = {}) {
  const chunks = [];
  for await (const chunk of packStream(entries, options)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function inventory(entries) {
  return entries.map(entry => ({ path: entry.name, type: entry.type, mode: entry.mode,
    link: entry.linkname || null, bytes: entry.bytes ?? entry.content.length, sha256: entry.sha256 ?? hash(entry.content) })).sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { readArchive, packArchive, packStream, inventory, canonicalize, archivePath, archiveRoot, MAX_BYTES };
