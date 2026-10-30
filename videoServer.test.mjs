import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const videoBytes = Buffer.from(
  Array.from({ length: 100 }, (_, index) => index),
);

let workDirectory;
let root;
let server;
let baseUrl;

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

before(async () => {
  workDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imageparser-video-server-"),
  );
  root = path.join(workDirectory, "root");
  await fs.mkdir(root);
  await fs.mkdir(path.join(workDirectory, "config"));
  await fs.writeFile(path.join(root, "clip.mp4"), videoBytes);
  await fs.writeFile(path.join(root, "notes.txt"), "not a video");
  await fs.writeFile(path.join(workDirectory, "outside.mp4"), videoBytes);

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}/`;
  let output = "";
  server = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      IMAGEPARSER_ROOT: root,
      IMAGEPARSER_CONFIG_DIR: path.join(workDirectory, "config"),
      IMAGEPARSER_USERNAME: "",
      IMAGEPARSER_PASSWORD: "",
      IMAGEPARSER_SECRET_KEY: "",
      OIDC_ISSUER_URL: "",
      OIDC_DISABLED: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`The server exited early:\n${output}`);
    }
    try {
      if ((await fetch(new URL("healthz", baseUrl))).ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The server did not start:\n${output}`);
});

after(async () => {
  server?.kill();
  await fs.rm(workDirectory, { recursive: true, force: true });
});

const videoUrl = (filePath) =>
  new URL(`api/video?${new URLSearchParams({ path: filePath })}`, baseUrl);

test("streams the whole video and advertises range support", async () => {
  const response = await fetch(videoUrl("clip.mp4"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-length"), "100");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), videoBytes);
});

test("answers a byte range with 206 and the requested bytes", async () => {
  const response = await fetch(videoUrl("clip.mp4"), {
    headers: { Range: "bytes=10-19" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 10-19/100");
  assert.equal(response.headers.get("content-length"), "10");
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    videoBytes.subarray(10, 20),
  );

  const suffix = await fetch(videoUrl("clip.mp4"), {
    headers: { Range: "bytes=-5" },
  });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), "bytes 95-99/100");
  assert.deepEqual(
    Buffer.from(await suffix.arrayBuffer()),
    videoBytes.subarray(95),
  );
});

test("answers an unsatisfiable range with 416", async () => {
  const response = await fetch(videoUrl("clip.mp4"), {
    headers: { Range: "bytes=200-" },
  });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */100");
  await response.arrayBuffer();
});

test("answers HEAD without a body", async () => {
  const response = await fetch(videoUrl("clip.mp4"), { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "100");
});

test("rejects files that are not supported videos", async () => {
  const response = await fetch(videoUrl("notes.txt"));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unsupported video type/);

  const sprite = await fetch(
    new URL(
      `api/video-sprite?${new URLSearchParams({ path: "notes.txt" })}`,
      baseUrl,
    ),
  );
  assert.equal(sprite.status, 400);
  await sprite.arrayBuffer();
});

test("confines video paths to the shared root", async () => {
  const missing = await fetch(videoUrl("missing.mp4"));
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();

  const outside = await fetch(videoUrl("../outside.mp4"));
  assert.equal(outside.status, 403);
  await outside.arrayBuffer();

  const absolute = await fetch(
    videoUrl(path.join(workDirectory, "outside.mp4")),
  );
  assert.equal(absolute.status, 403);
  await absolute.arrayBuffer();
});

test("does not follow a symbolic link out of the shared root", async (t) => {
  try {
    await fs.symlink(
      path.join(workDirectory, "outside.mp4"),
      path.join(root, "linked.mp4"),
    );
  } catch {
    t.skip("Symbolic links cannot be created here.");
    return;
  }
  const response = await fetch(videoUrl("linked.mp4"));
  assert.equal(response.status, 403);
  await response.arrayBuffer();
});
