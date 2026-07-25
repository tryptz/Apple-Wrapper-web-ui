'use strict';

// Zero-dependency web UI that orchestrates the Apple Music wrapper + downloader
// containers. Run:  node webui/server.js   then open http://localhost:8080

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..');            // the wrapper repo root
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');

// Onboarding: the two things a fresh clone does NOT ship (both gitignored).
// rootfs/system holds the Android runtime libs the wrapper executes against;
// rootfs/data holds the signed-in session. kvs.sqlitedb is the file
// entrypoint.sh keys off to decide "already logged in?", so it is the single
// source of truth for whether onboarding is complete.
const ROOTFS_SYSTEM = path.join(ROOT, 'rootfs', 'system');
const ROOTFS_DATA = path.join(ROOT, 'rootfs', 'data');
const SESSION_DIR = path.join(
  ROOTFS_DATA, 'data', 'com.apple.android.music', 'files'
);
const SESSION_DB = path.join(SESSION_DIR, 'mpl_db', 'kvs.sqlitedb');

const WRAPPER_IMAGE = 'ghcr.io/worldobservationlog/wrapper:local';
const DL_IMAGE = 'ghcr.io/zhaarey/apple-music-downloader:latest';
// Must match `container_name` in compose.yaml — the web UI drives that single
// compose-managed container rather than spawning its own instance.
const WRAPPER_NAME = 'am-wrapper';
const COMPOSE_SERVICE = 'app';

// ---- helpers ---------------------------------------------------------------

function docker(args, { detached = false, cwd, env } = {}) {
  // spawn without a shell so paths with spaces / special chars are safe
  return spawn('docker', args, {
    windowsHide: true,
    detached,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
  });
}

// run a docker command to completion, resolve with {code, out}
function dockerRun(args, opts) {
  return new Promise((resolve) => {
    const p = docker(args, opts);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out: out.trim() }));
    p.on('error', (err) => resolve({ code: -1, out: String(err) }));
  });
}

// run `docker compose ...` from the repo root (where compose.yaml lives), with
// optional USERNAME/PASSWORD injected into the environment for interpolation.
function composeRun(args, env) {
  return dockerRun(['compose', ...args], { cwd: ROOT, env });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// ---- SSE plumbing ----------------------------------------------------------

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---- wrapper container management ------------------------------------------

async function wrapperStatus() {
  const insp = await dockerRun([
    'inspect', WRAPPER_NAME, '--format', '{{.State.Running}}',
  ]);
  const running = insp.code === 0 && insp.out === 'true';
  let listening = false;
  if (running) {
    const logs = await dockerRun(['logs', '--tail', '200', WRAPPER_NAME]);
    listening = /listening 0\.0\.0\.0:10020/.test(logs.out);
  }
  return { running, listening };
}

async function startWrapper(username, password) {
  // Guard against a stray, non-compose wrapper container sharing the login DB.
  // The compose container itself is `am-wrapper` (WRAPPER_NAME); anything else
  // from the same image is a second instance that would corrupt the token.
  const others = await dockerRun([
    'ps', '--filter', `ancestor=${WRAPPER_IMAGE}`, '--format', '{{.Names}}',
  ]);
  const foreign = others.out
    .split('\n')
    .map((s) => s.trim())
    .filter((n) => n && n !== WRAPPER_NAME);
  if (foreign.length) {
    return {
      code: 1,
      out:
        `Another wrapper container is already running: ${foreign.join(', ')}. ` +
        `Two instances share and corrupt the same login DB. Stop it first: ` +
        `docker rm -f ${foreign.join(' ')}`,
    };
  }
  // Drive the single compose-managed container. `up -d` is idempotent: it
  // recreates am-wrapper only when the (credential) config changes, so there is
  // exactly one wrapper instance. Credentials flow in via the environment and
  // are interpolated by compose.yaml.
  return composeRun(['up', '-d', COMPOSE_SERVICE], { USERNAME: username, PASSWORD: password });
}

// ---- onboarding / setup ----------------------------------------------------

// Everything a new user needs before the app can do anything, each reported as
// ok/not-ok with a human explanation. The UI renders this as a checklist and
// only unlocks the main app once `ready` is true.
async function setupState() {
  const [dockerV, composeV] = await Promise.all([
    dockerRun(['version', '--format', '{{.Server.Version}}']),
    dockerRun(['compose', 'version', '--short']),
  ]);

  const dockerOk = dockerV.code === 0;
  const composeOk = composeV.code === 0;

  // A plausible rootfs has the dynamic linker + the Apple Music native lib.
  const systemOk =
    fs.existsSync(path.join(ROOTFS_SYSTEM, 'bin', 'linker64')) &&
    fs.existsSync(path.join(ROOTFS_SYSTEM, 'lib64', 'libandroidappmusic.so'));

  const sessionOk = fs.existsSync(SESSION_DB);
  const { running, listening } = dockerOk ? await wrapperStatus() : { running: false, listening: false };

  return {
    ready: dockerOk && composeOk && systemOk && sessionOk,
    steps: {
      docker: {
        ok: dockerOk,
        detail: dockerOk
          ? `Docker ${dockerV.out}`
          : 'Docker not reachable. Install Docker Desktop and make sure it is running.',
      },
      compose: {
        ok: composeOk,
        detail: composeOk
          ? `Compose ${composeV.out}`
          : 'The `docker compose` plugin is missing (ships with Docker Desktop).',
      },
      rootfs: {
        ok: systemOk,
        detail: systemOk
          ? 'Android runtime present'
          : 'rootfs/system is missing. It is not distributed with this repo — copy it in from your own extraction.',
      },
      session: {
        ok: sessionOk,
        detail: sessionOk
          ? 'Signed in — token stored in rootfs/data'
          : 'No Apple Music session yet. Sign in below to create one.',
      },
    },
    wrapper: { running, listening },
  };
}

// Sign out = destroy the local session so a different Apple ID can be used, or
// to recover from a corrupted/expired token. Only the app's own generated
// session files are removed; rootfs/system is never touched.
async function clearSession() {
  await composeRun(['stop', COMPOSE_SERVICE]);   // release the SQLite locks first
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  }
  return !fs.existsSync(SESSION_DB);
}

// ---- download jobs ---------------------------------------------------------

const jobs = new Map(); // id -> { id, url, format, buffer, clients, done, code, name }
let jobSeq = 0;

const FORMAT_FLAGS = {
  alac: [],
  atmos: ['--atmos'],
  aac: ['--aac'],
};

function startDownload(url, format) {
  const id = String(++jobSeq);
  const name = `am-dl-${id}`;
  const flags = FORMAT_FLAGS[format] || [];
  const args = [
    'run', '--rm', '--network', 'host', '--name', name,
    '-v', `${DOWNLOADS_DIR}:/downloads`,
    DL_IMAGE,
    ...flags,
    url,
  ];
  const job = { id, url, format, buffer: [], clients: new Set(), done: false, code: null, name };
  jobs.set(id, job);

  const push = (line) => {
    job.buffer.push(line);
    if (job.buffer.length > 2000) job.buffer.shift();
    for (const c of job.clients) sseSend(c, 'log', line);
  };
  push(`$ docker ${args.join(' ')}`);

  const p = docker(args);
  const onData = (d) => String(d).split(/\r?\n/).forEach((l) => l !== '' && push(l));
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('close', (code) => {
    job.done = true;
    job.code = code;
    push(`\n=== job finished (exit ${code}) ===`);
    for (const c of job.clients) sseSend(c, 'done', { code });
  });
  p.on('error', (err) => {
    job.done = true;
    job.code = -1;
    push(`ERROR: ${err}`);
    for (const c of job.clients) sseSend(c, 'done', { code: -1 });
  });
  return job;
}

// ---- downloaded file listing ----------------------------------------------

function listFiles() {
  const out = [];
  if (!fs.existsSync(DOWNLOADS_DIR)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(DOWNLOADS_DIR, full).split(path.sep).join('/');
        const { size, mtimeMs } = fs.statSync(full);
        out.push({ path: rel, size, mtime: mtimeMs });
      }
    }
  };
  walk(DOWNLOADS_DIR);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ---- HTTP routing ----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (p === '/api/status' && req.method === 'GET') {
      return sendJSON(res, 200, await wrapperStatus());
    }

    if (p === '/api/setup/state' && req.method === 'GET') {
      return sendJSON(res, 200, await setupState());
    }

    // First-time sign-in. Identical mechanics to /api/wrapper/start — the
    // credentials are handed to `docker compose up` through the environment
    // for that one invocation and are never written to disk by this server.
    // Once the wrapper mints rootfs/data they are not needed again.
    if (p === '/api/setup/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      if (!username || !password) {
        return sendJSON(res, 400, { error: 'Apple ID and password are required' });
      }
      const state = await setupState();
      if (!state.steps.docker.ok) return sendJSON(res, 409, { error: state.steps.docker.detail });
      if (!state.steps.rootfs.ok) return sendJSON(res, 409, { error: state.steps.rootfs.detail });

      const r = await startWrapper(username, password);
      if (r.code !== 0) return sendJSON(res, 500, { error: r.out });
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/setup/signout' && req.method === 'POST') {
      const cleared = await clearSession();
      return cleared
        ? sendJSON(res, 200, { ok: true })
        : sendJSON(res, 500, { error: 'Could not remove the session — stop the container and retry.' });
    }

    if (p === '/api/wrapper/start' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      // Credentials are only required for the very first login. Once the
      // session exists in rootfs/data the wrapper reuses it, so a restart
      // needs nothing — don't make the user re-enter a password to press play.
      const haveSession = fs.existsSync(SESSION_DB);
      if (!haveSession && (!username || !password)) {
        return sendJSON(res, 400, {
          error: 'No saved session yet — an Apple ID and password are required for the first sign-in.',
        });
      }
      const r = await startWrapper(username || '', password || '');
      if (r.code !== 0) return sendJSON(res, 500, { error: r.out });
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/wrapper/stop' && req.method === 'POST') {
      // Stop the compose-managed container (keeps it defined for a fast restart).
      await composeRun(['stop', COMPOSE_SERVICE]);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/wrapper/logs' && req.method === 'GET') {
      openSSE(res);
      const lp = docker(['logs', '-f', '--tail', '200', WRAPPER_NAME]);
      const onData = (d) =>
        String(d).split(/\r?\n/).forEach((l) => l !== '' && sseSend(res, 'log', l));
      lp.stdout.on('data', onData);
      lp.stderr.on('data', onData);
      req.on('close', () => lp.kill());
      return;
    }

    if (p === '/api/download' && req.method === 'POST') {
      const { url: dlUrl, format } = await readBody(req);
      if (!dlUrl) return sendJSON(res, 400, { error: 'url required' });
      const job = startDownload(dlUrl.trim(), format || 'alac');
      return sendJSON(res, 200, { id: job.id });
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      const list = [...jobs.values()].map((j) => ({
        id: j.id, url: j.url, format: j.format, done: j.done, code: j.code,
      }));
      return sendJSON(res, 200, list);
    }

    if (p.startsWith('/api/jobs/') && p.endsWith('/stream') && req.method === 'GET') {
      const id = p.split('/')[3];
      const job = jobs.get(id);
      if (!job) { res.writeHead(404); return res.end(); }
      openSSE(res);
      for (const line of job.buffer) sseSend(res, 'log', line);
      if (job.done) sseSend(res, 'done', { code: job.code });
      job.clients.add(res);
      req.on('close', () => job.clients.delete(res));
      return;
    }

    if (p.startsWith('/api/jobs/') && p.endsWith('/stop') && req.method === 'POST') {
      const id = p.split('/')[3];
      const job = jobs.get(id);
      if (job) await dockerRun(['rm', '-f', job.name]);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/files' && req.method === 'GET') {
      return sendJSON(res, 200, listFiles());
    }

    if (p === '/files/download' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || '';
      const full = path.join(DOWNLOADS_DIR, rel);
      // prevent path traversal outside downloads/
      if (!full.startsWith(DOWNLOADS_DIR) || !fs.existsSync(full)) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(full)}"`,
      });
      return fs.createReadStream(full).pipe(res);
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    sendJSON(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Apple Music web UI running at http://localhost:${PORT}`);
  console.log(`Repo root: ${ROOT}`);
});
