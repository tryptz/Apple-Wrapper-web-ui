'use strict';

// Zero-dependency web UI that orchestrates the Apple Music wrapper + downloader
// containers. Run:  node webui/server.js   then open http://localhost:8080

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Two run modes ───────────────────────────────────────────────────────────
//
// LOCAL (default): this process has a Docker daemon. It drives the wrapper and
// downloader containers directly — the original behaviour.
//
// PROXY (AGENT_URL set): this process has NO Docker — e.g. it is the Railway
// service. It serves the UI and forwards every /api and /files request to a
// LOCAL-mode instance running on your own machine, reached over Tailscale.
// Nothing is reimplemented: the agent stays the single place that knows how to
// talk to Docker, so both modes expose exactly the same API surface.
//
//   AGENT_URL=http://<your-agent-host>:8080     (tailnet IP, or a MagicDNS name)
//
const AGENT_URL = (process.env.AGENT_URL || '').replace(/\/+$/, '');
const PROXY_MODE = AGENT_URL !== '';

// Tailscale in userspace mode creates no network interface, so a tailnet
// address is unroutable from this process — connect() fails with EHOSTUNREACH.
// Traffic has to go through tailscaled's outbound HTTP proxy. Node has no
// implicit proxy support (HTTP_PROXY/ALL_PROXY are ignored by http.request),
// so route through it explicitly, with no extra dependency: connect to the
// proxy and use absolute-URI request form, which is exactly what an HTTP
// proxy expects.
const TS_PROXY = (() => {
  const raw = process.env.TS_HTTP_PROXY || '';
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: Number(u.port) || 80 };
  } catch {
    console.warn(`[proxy] ignoring malformed TS_HTTP_PROXY: ${raw}`);
    return null;
  }
})();

/**
 * Build http.request options for `target`, going via the tailnet proxy when
 * one is configured. Without a proxy this is a plain direct request, so local
 * (non-Railway) runs are unaffected.
 */
function requestOptionsFor(target, { method = 'GET', headers = {} } = {}) {
  const hdrs = { ...headers, host: target.host };
  if (!TS_PROXY || target.protocol !== 'http:') {
    return { target, opts: { method, headers: hdrs } };
  }
  return {
    target,
    opts: {
      host: TS_PROXY.host,
      port: TS_PROXY.port,
      method,
      path: target.href,          // absolute-URI form for the proxy
      headers: hdrs,
    },
    viaProxy: true,
  };
}

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

// ---- redaction --------------------------------------------------------------
//
// This UI can be served from a PUBLIC URL (the Railway deployment), while the
// data flowing through it comes from a private machine: tailnet addresses, the
// Apple Music token the wrapper prints on every start, auth keys. None of that
// should ever reach a browser. Redaction happens at the OUTPUT boundary — every
// JSON body, every SSE event, and every proxied text stream — so it cannot be
// bypassed by calling the API directly instead of using the page.

const REDACTIONS = [
  // Apple Music token as the wrapper logs it.
  [/(Music-Token\s*:\s*)\S+/gi, '$1[redacted]'],
  // Tailscale auth keys / OAuth client secrets.
  [/\b(tskey-[A-Za-z0-9-]{4})[A-Za-z0-9-]+/g, '$1[redacted]'],
  // Generic secret-bearing assignments: token=, authkey:, password = "…"
  [/\b(authkey|auth_key|api[-_]?key|secret|password|passwd|pwd|token)(\s*[:=]\s*"?)([^"\s,&}]{3,})/gi,
   '$1$2[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]'],
  // Any IPv4 (with optional port). Loopback/wildcard reveal nothing about the
  // network, so they stay readable — useful when reading logs.
  [/\b(?!0\.0\.0\.0\b)(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b(?::\d{1,5})?/g, '[hidden]'],
  // Apple IDs / e-mail addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[hidden]'],
];

function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

/**
 * Line-buffered redacting transform for piped streams. Buffering to line
 * boundaries matters: a token split across two chunks would otherwise slip
 * through with each half individually looking harmless.
 */
const { Transform } = require('stream');
function redactStream() {
  let tail = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      const s = tail + chunk.toString('utf8');
      const idx = s.lastIndexOf('\n');
      if (idx === -1) { tail = s; return cb(); }
      tail = s.slice(idx + 1);
      cb(null, redact(s.slice(0, idx + 1)));
    },
    flush(cb) { cb(null, tail ? redact(tail) : undefined); },
  });
}

// Only text is safe to rewrite — running a regex over a downloaded .m4a would
// corrupt it.
function isRedactableType(headers) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  return ct.includes('text/') || ct.includes('json') || ct.includes('event-stream');
}

function sendJSON(res, status, obj) {
  const body = redact(JSON.stringify(obj));
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
  res.write(`data: ${redact(JSON.stringify(data))}\n\n`);
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

// ---- proxy mode ------------------------------------------------------------

// Stream a request through to the agent. Piping both directions keeps Server-
// Sent Events working unbuffered, so live wrapper/download logs still tail in
// real time across the tailnet.
function proxyToAgent(req, res) {
  let target;
  try {
    target = new URL(req.url, AGENT_URL);
  } catch {
    return sendJSON(res, 500, { error: `AGENT_URL is not a valid URL: ${AGENT_URL}` });
  }

  const mod = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  // Never let a proxied response arrive compressed — it would break the SSE
  // framing we pipe straight through.
  delete headers['accept-encoding'];

  // Proxied bodies bypass sendJSON/sseSend entirely, so they get their own
  // redaction pass — this is the path the wrapper's log stream (and its
  // Music-Token) actually travels.
  const onUpstream = (up) => {
    const h = { ...up.headers };
    if (isRedactableType(h)) delete h['content-length'];   // length changes
    res.writeHead(up.statusCode || 502, h);
    if (isRedactableType(h)) up.pipe(redactStream()).pipe(res);
    else up.pipe(res);
  };

  const { opts, viaProxy } = requestOptionsFor(target, { method: req.method, headers });
  const upstream = viaProxy
    ? mod.request(opts, onUpstream)
    : mod.request(target, opts, onUpstream);

  upstream.setTimeout(0);           // long-lived SSE streams must not time out
  upstream.on('error', (err) => {
    if (res.headersSent) return res.end();
    sendJSON(res, 502, {
      error:
        `Cannot reach the wrapper agent (${err.code || 'connection failed'}). ` +
        `Check that the agent is running on your machine and that this service is on the tailnet.`,
    });
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

// Cheap reachability probe used by the setup wizard in proxy mode.
function agentHealth() {
  return new Promise((resolve) => {
    let target;
    try { target = new URL('/api/status', AGENT_URL); }
    catch { return resolve({ ok: false, detail: `AGENT_URL is malformed: ${AGENT_URL}` }); }

    const mod = target.protocol === 'https:' ? https : http;
    const { opts, viaProxy } = requestOptionsFor(target, { method: 'GET' });
    const onRes = (up) => {
      up.resume();
      // Deliberately no address in user-facing text — the operator already
      // knows which machine this is, and this page may be publicly served.
      resolve(
        up.statusCode === 200
          ? { ok: true, detail: 'Agent reachable' }
          : { ok: false, detail: `Agent responded ${up.statusCode}` },
      );
    };
    const rq = viaProxy
      ? mod.request({ ...opts, timeout: 4000 }, onRes)
      : mod.request(target, { ...opts, timeout: 4000 }, onRes);
    rq.on('timeout', () => { rq.destroy(); resolve({ ok: false, detail: 'Timed out reaching your PC agent' }); });
    rq.on('error', (e) => resolve({ ok: false, detail: `Cannot reach your PC agent (${e.code || 'error'})` }));
    rq.end();
  });
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
    supervisor: {
      enabled: supervisor.enabled,
      paused: supervisor.paused,
      manualStop: supervisor.manualStop,
      streamLimit: pruneWindow(supervisor.streamLimit),
      faults: pruneWindow(supervisor.faults),
      lastReason: supervisor.lastReason,
    },
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

// ---- wrapper supervisor ----------------------------------------------------
//
// The wrapper exits cleanly (code 0) when Apple pulls its stream lease - e.g.
// "More than one device is trying to play music" when the account's concurrent
// stream limit is hit. Nothing crashes, so nothing restarts it, and downloads
// silently stop working while every setup check still reports green. This
// watches the container and brings it back.
//
// LOCAL mode only: proxy-mode instances have no Docker, and the agent they
// forward to runs its own supervisor.
// Set SUPERVISE_WRAPPER=0 to disable.

const SUPERVISE = process.env.SUPERVISE_WRAPPER !== '0' && !PROXY_MODE;
const SUPERVISE_INTERVAL_MS = 20_000;

// Two independent budgets, because the two causes mean opposite things.
//
// Apple pulling the stream lease ("More than one device is trying to play
// music") is EXPECTED when several people share the account - it is not a
// broken wrapper, and giving up would be the wrong response. It gets a large
// budget and only a short backoff.
//
// An unexplained exit is a real fault. It gets a small budget and exponential
// backoff, so a wrapper that genuinely cannot start is not hot-looped.
const STREAM_LIMIT_MAX = 40;
const FAULT_MAX = 5;
const BUDGET_WINDOW_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 8_000;
const BACKOFF_MAX_MS = 2 * 60_000;

const supervisor = {
  enabled: SUPERVISE,
  manualStop: false,     // set when a user presses Stop - never fight that
  restarting: false,     // in-flight guard: no concurrent `compose up`
  streamLimit: [],       // timestamps, benign cause
  faults: [],            // timestamps, real cause
  backoffUntil: 0,
  consecutiveFaults: 0,
  lastReason: null,
  paused: false,
};

function pruneWindow(list) {
  const cutoff = Date.now() - BUDGET_WINDOW_MS;
  while (list.length && list[0] <= cutoff) list.shift();
  return list.length;
}

async function superviseTick() {
  if (!supervisor.enabled || supervisor.paused) return;
  // A deliberate Stop must stick. Restarting over the top of it was the most
  // useless thing this could do: the user presses Stop, it comes back 20s later.
  if (supervisor.manualStop) return;
  if (supervisor.restarting) return;
  if (Date.now() < supervisor.backoffUntil) return;
  // Without a session the wrapper would just exit demanding credentials.
  if (!fs.existsSync(SESSION_DB)) return;

  const insp = await dockerRun(['inspect', WRAPPER_NAME, '--format', '{{.State.Running}}|{{.State.ExitCode}}']);
  if (insp.code !== 0) return;                       // container not created yet
  const [running, exitCode] = insp.out.split('|');
  if (running === 'true') {
    supervisor.consecutiveFaults = 0;                // healthy again
    return;
  }

  // Why did it stop? Apple's dialog is far more useful than a bare exit code.
  const logs = await dockerRun(['logs', '--tail', '40', WRAPPER_NAME]);
  const dialog = /dialogHandler:\s*\{title:\s*([^,]+)/.exec(logs.out || '');
  const title = dialog ? dialog[1].trim() : '';
  const isStreamLimit = /more than one device|stream/i.test(title);
  const reason = title || `exit code ${exitCode}`;

  if (isStreamLimit) {
    supervisor.streamLimit.push(Date.now());
    if (pruneWindow(supervisor.streamLimit) > STREAM_LIMIT_MAX) {
      supervisor.paused = true;
      supervisor.lastReason =
        'Apple keeps ending the stream lease - too many devices are playing at once. Not restarting again.';
      return;
    }
    supervisor.consecutiveFaults = 0;
    supervisor.backoffUntil = Date.now() + BACKOFF_BASE_MS;
    supervisor.lastReason = `Apple ended the stream lease (${reason}) - restarted automatically.`;
  } else {
    supervisor.faults.push(Date.now());
    if (pruneWindow(supervisor.faults) > FAULT_MAX) {
      supervisor.paused = true;
      supervisor.lastReason =
        `Wrapper failed ${FAULT_MAX} times in 15 minutes (${reason}) - not restarting again.`;
      console.warn(`[supervisor] ${supervisor.lastReason}`);
      return;
    }
    supervisor.consecutiveFaults += 1;
    supervisor.backoffUntil = Date.now()
      + Math.min(BACKOFF_BASE_MS * 2 ** (supervisor.consecutiveFaults - 1), BACKOFF_MAX_MS);
    supervisor.lastReason = `Wrapper stopped (${reason}) - restarted automatically.`;
  }

  console.log(`[supervisor] wrapper down (${reason}); restarting`);
  supervisor.restarting = true;
  try {
    const r = await startWrapper('', '');
    if (r.code !== 0) {
      supervisor.lastReason = `Wrapper stopped (${reason}); restart FAILED: ${r.out}`;
      console.warn(`[supervisor] restart failed: ${r.out}`);
    }
  } finally {
    supervisor.restarting = false;
  }
}

if (SUPERVISE) {
  setInterval(() => { superviseTick().catch((e) => console.warn('[supervisor]', e)); },
              SUPERVISE_INTERVAL_MS).unref();
}

// ---- download jobs ---------------------------------------------------------

const jobs = new Map(); // id -> { id, url, format, buffer, clients, done, code, name }
let jobSeq = 0;

// Unique per agent process, so download container names can't collide with
// leftovers from a previous run.
const RUN_TAG = Math.random().toString(36).slice(2, 8);

// Reap download containers orphaned by a previous agent (a stuck retry loop
// survives the agent exiting, and each one keeps burning CPU and holding an
// Apple stream). Only touches am-dl-* — never the wrapper.
async function reapOrphanDownloaders() {
  const r = await dockerRun(['ps', '-aq', '--filter', 'name=am-dl-']);
  const ids = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return;
  console.log(`[cleanup] removing ${ids.length} orphaned downloader container(s)`);
  await dockerRun(['rm', '-f', ...ids]);
}

const FORMAT_FLAGS = {
  alac: [],
  atmos: ['--atmos'],
  aac: ['--aac'],
};

// The downloader prompts "Error detected, press Enter to try again..." on
// failure. With no TTY it never gets an Enter, so it retries forever: the
// container never exits, holds ~27% CPU and keeps an Apple stream open.
// Several of those at once is what trips the account's concurrent-stream
// limit and takes the wrapper down with it.
const RETRY_LOOP_MARKER = /Error detected, press Enter to try again|Start trying again/i;
const RETRY_LOOP_LIMIT = 3;          // strikes before we call it stuck
const JOB_MAX_MS = 30 * 60_000;      // absolute ceiling per job

function startDownload(url, format, { outDir } = {}) {
  const id = String(++jobSeq);
  // jobSeq restarts at 1 whenever the agent restarts, so `am-dl-<id>` alone
  // collides with a container left over from a previous run ("name is already
  // in use", exit 125). A per-process suffix keeps names unique across
  // restarts and concurrent users.
  const name = `am-dl-${id}-${RUN_TAG}`;
  const flags = FORMAT_FLAGS[format] || [];
  // Tryptify's per-track decrypts mount their own directory so the finished
  // file can be found by adamId alone; normal UI downloads use the shared one.
  const mount = outDir || DOWNLOADS_DIR;
  const args = [
    'run', '--rm', '--network', 'host', '--name', name,
    '-v', `${mount}:/downloads`,
    DL_IMAGE,
    ...flags,
    url,
  ];
  const job = {
    id, url, format, buffer: [], clients: new Set(), done: false, code: null, name,
    retryStrikes: 0, killed: null,
  };
  jobs.set(id, job);

  const abort = (why) => {
    if (job.done || job.killed) return;
    job.killed = why;
    push(`\n!! ${why} — stopping this job so it stops holding a stream.`);
    dockerRun(['rm', '-f', name]);
  };

  const push = (line) => {
    job.buffer.push(line);
    if (job.buffer.length > 2000) job.buffer.shift();
    for (const c of job.clients) sseSend(c, 'log', line);

    // Break the infinite retry loop rather than let it run forever.
    if (RETRY_LOOP_MARKER.test(line)) {
      job.retryStrikes += 1;
      if (job.retryStrikes >= RETRY_LOOP_LIMIT) {
        abort(`Downloader stuck retrying (${job.retryStrikes}x) — the URL is probably unavailable in this storefront`);
      }
    }
  };
  push(`$ docker ${args.join(' ')}`);

  // Hard ceiling regardless of what the logs say.
  const killTimer = setTimeout(() => abort(`Job exceeded ${JOB_MAX_MS / 60000} minutes`), JOB_MAX_MS);
  killTimer.unref();

  const p = docker(args);
  const onData = (d) => String(d).split(/\r?\n/).forEach((l) => l !== '' && push(l));
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  // Fired once the process is gone, whatever the outcome. Used by the Apple
  // path to retry a different format when the requested one yielded nothing.
  const finished = () => {
    if (typeof job.onFinished !== 'function') return;
    const fn = job.onFinished;
    job.onFinished = null;                  // never run twice
    try { fn(); } catch (e) { push(`ERROR in onFinished: ${e}`); }
  };

  p.on('close', (code) => {
    clearTimeout(killTimer);
    job.done = true;
    job.code = code;
    push(job.killed ? `\n=== job stopped: ${job.killed} ===` : `\n=== job finished (exit ${code}) ===`);
    for (const c of job.clients) sseSend(c, 'done', { code, killed: job.killed || null });
    finished();
  });
  p.on('error', (err) => {
    job.done = true;
    job.code = -1;
    push(`ERROR: ${err}`);
    for (const c of job.clients) sseSend(c, 'done', { code: -1 });
    finished();
  });
  return job;
}

// ---- Tryptify agent API -----------------------------------------------------
//
// The Tryptify Android app can play Apple Music straight off this machine over
// Tailscale, with no cloud hop. Its contract (HiFiApiClient.getAppleStreamUrl):
//
//   POST /decrypt              {"adamId":"…","quality":"…"}  + X-Agent-Secret
//   GET  /files/<adamId>.m4a   polled with Range: bytes=0-0 until 200/206,
//                              then used directly as the playback URL.
//
// Each track decrypts into its own directory keyed by adamId, because the
// downloader names output after artist/album/track and the app only knows the
// numeric id - a per-id directory is what makes the lookup possible at all.

const AGENT_SECRET = process.env.AGENT_SECRET || '';   // optional
const APPLE_DIR = path.join(DOWNLOADS_DIR, '_agent');

const appleJobs = new Map();   // adamId -> { started, jobId }

function appleTrackDir(adamId) {
  return path.join(APPLE_DIR, String(adamId));
}

/** True while this adamId's decrypt job is still running. */
function appleJobRunning(adamId) {
  const entry = appleJobs.get(String(adamId));
  if (!entry) return false;                 // nothing started, or lost to a restart
  const job = jobs.get(entry.jobId);
  return !!job && !job.done;
}

// A file written this recently is treated as still settling. Covers what the
// job map cannot: an agent restart orphans a half-written file, so no job
// exists to ask about even though the bytes are incomplete.
const APPLE_SETTLE_MS = 2000;

/**
 * The finished audio for this adamId, or null while it is still decrypting.
 * The downloader writes a nested tree - <format>/<artist>/<album>/<track>.m4a -
 * so this walks recursively rather than assuming a flat directory.
 *
 * Readiness is gated on the JOB being done, not on the file merely existing.
 * size > 0 was far too weak: the downloader streams into the final path, so the
 * file is non-empty for seconds before it is complete. The app polls this
 * endpoint and starts transferring the moment it says yes, so it was handed an
 * M4A truncated mid-mdat - present, ~90% of full size, and undecodable.
 */
function findAppleFile(adamId) {
  if (appleJobRunning(adamId)) return null;
  const dir = appleTrackDir(adamId);
  if (!fs.existsSync(dir)) return null;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return null; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (/\.(m4a|mp4|flac)$/i.test(e.name)) {
        try {
          const st = fs.statSync(full);
          if (st.size > 0 && Date.now() - st.mtimeMs >= APPLE_SETTLE_MS) return full;
        } catch { /* mid-write */ }
      }
    }
    return null;
  };
  return walk(dir);
}

/** Map a requested quality onto a downloader format code. */
function appleFormatFor(quality) {
  if (quality === 'atmos') return 'atmos';
  if (quality === 'aac') return 'aac';
  if (quality === 'hires-lossless') return 'alac';   // downloader has one ALAC tier
  return 'alac';
}

/**
 * Kick a decrypt for one adamId.
 *
 * `fallback` handles the Atmos case: most tracks have no Atmos master, and the
 * job simply finishes having produced nothing. Retrying here is what keeps that
 * cheap — the app is polling /files and cannot tell "still working" from "there
 * is no Atmos version", so if it had to time out first it would wait the full
 * 210s before trying stereo. We see the exit and start the stereo job at once.
 */
function startAppleDecrypt(adamId, quality, fallback) {
  const existing = appleJobs.get(String(adamId));
  if (existing && jobs.get(existing.jobId) && !jobs.get(existing.jobId).done) {
    return { already: true, id: existing.jobId };
  }
  const outDir = appleTrackDir(adamId);
  fs.mkdirSync(outDir, { recursive: true });

  // A bare song id is enough for the downloader; the slug is cosmetic.
  const url = `https://music.apple.com/us/song/track/${adamId}`;
  const format = appleFormatFor(quality);

  const job = startDownload(url, format, { outDir });
  appleJobs.set(String(adamId), { started: Date.now(), jobId: job.id });

  if (fallback && fallback !== quality) {
    job.onFinished = () => {
      // Ask the walker directly (not findAppleFile) so the settle delay and the
      // still-running check don't mask a genuine "nothing was produced".
      if (appleProducedFile(adamId)) return;
      console.log(`[apple] ${adamId}: ${format} produced nothing - retrying as ${appleFormatFor(fallback)}`);
      appleJobs.delete(String(adamId));
      startAppleDecrypt(adamId, fallback, null);
    };
  }
  return { already: false, id: job.id };
}

/** Any audio file under this adamId's dir, regardless of age or job state. */
function appleProducedFile(adamId) {
  const dir = appleTrackDir(adamId);
  if (!fs.existsSync(dir)) return false;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return false; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(full)) return true; }
      else if (/\.(m4a|mp4|flac)$/i.test(e.name)) {
        try { if (fs.statSync(full).size > 0) return true; } catch { /* ignore */ }
      }
    }
    return false;
  };
  return walk(dir);
}

/** Serve a file with byte-range support - required for seeking, and for the
 *  app's `Range: bytes=0-0` readiness probe. */
function serveFileRanged(req, res, full) {
  const stat = fs.statSync(full);
  const range = req.headers.range;
  const type = /\.flac$/i.test(full) ? 'audio/flac' : 'audio/mp4';

  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    return fs.createReadStream(full).pipe(res);
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
  if (start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
  });
  return fs.createReadStream(full, { start, end }).pipe(res);
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
      // Fill in {{ORIGIN}} so the Open Graph url/image are absolute — link
      // crawlers (Discord, Slack, iMessage) reject relative ones, and the
      // origin differs between the local agent and the public deployment.
      // x-forwarded-proto is what Railway's TLS terminator sets.
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
        || (req.socket.encrypted ? 'https' : 'http');
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
      const origin = `${proto}://${host}`;

      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
        .split('{{ORIGIN}}').join(origin);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      });
      return res.end(html);
    }

    if (p === '/icon.svg') {
      const svg = fs.readFileSync(path.join(__dirname, 'public', 'icon.svg'));
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': svg.length,
      });
      return res.end(svg);
    }

    // Proxy mode: everything with side effects belongs to the agent. This must
    // sit ahead of every Docker-backed route below — there is no daemon here.
    // /api/setup/state is handled locally (it describes the link itself).
    if (PROXY_MODE && p !== '/api/setup/state'
        && (p.startsWith('/api/') || p.startsWith('/files/') || p === '/decrypt')) {
      return proxyToAgent(req, res);
    }

    if (p === '/api/status' && req.method === 'GET') {
      return sendJSON(res, 200, await wrapperStatus());
    }

    // In proxy mode the setup checklist describes THIS hop (can we reach the
    // agent?) plus whatever the agent reports about its own Docker/session
    // state — so the wizard still tells the whole truth end to end.
    if (p === '/api/setup/state' && req.method === 'GET' && PROXY_MODE) {
      const link = await agentHealth();
      let remote = null;
      if (link.ok) {
        remote = await new Promise((resolve) => {
          const t = new URL('/api/setup/state', AGENT_URL);
          const mod = t.protocol === 'https:' ? https : http;
          const { opts, viaProxy } = requestOptionsFor(t, { method: 'GET' });
          const onRes = (up) => {
            let b = '';
            up.on('data', (d) => (b += d));
            up.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
          };
          const rq = viaProxy
            ? mod.request({ ...opts, timeout: 5000 }, onRes)
            : mod.request(t, { ...opts, timeout: 5000 }, onRes);
          rq.on('timeout', () => { rq.destroy(); resolve(null); });
          rq.on('error', () => resolve(null));
          rq.end();
        });
      }
      const steps = {
        agent: { ok: link.ok, detail: link.detail },
        ...(remote ? remote.steps : {}),
      };
      return sendJSON(res, 200, {
        ready: link.ok && !!remote && remote.ready,
        mode: 'proxy',
        steps,
        wrapper: remote ? remote.wrapper : { running: false, listening: false },
        // Relay the agent's supervisor state so the remote UI can explain a
        // wrapper that went down and came back on its own.
        supervisor: remote ? remote.supervisor : null,
      });
    }

    if (p === '/api/setup/state' && req.method === 'GET') {
      return sendJSON(res, 200, { ...(await setupState()), mode: 'local' });
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
      // An explicit start clears the manual-stop latch and any give-up state,
      // so the supervisor resumes looking after it from here.
      supervisor.manualStop = false;
      supervisor.paused = false;
      supervisor.backoffUntil = 0;
      supervisor.consecutiveFaults = 0;
      const r = await startWrapper(username || '', password || '');
      if (r.code !== 0) return sendJSON(res, 500, { error: r.out });
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/wrapper/stop' && req.method === 'POST') {
      // Latch the intent BEFORE stopping, so the supervisor can't race in and
      // restart what the user just asked to stop.
      supervisor.manualStop = true;
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

    // ---- Tryptify agent API ----
    // Kick off a decrypt for one Apple track. Idempotent: asking again while
    // it is already running (or already finished) does not start a second
    // container - the app polls, so repeats are expected, and duplicates would
    // each hold their own Apple stream.
    if (p === '/decrypt' && req.method === 'POST') {
      if (AGENT_SECRET && req.headers['x-agent-secret'] !== AGENT_SECRET) {
        return sendJSON(res, 403, { error: 'Bad agent secret' });
      }
      // `fallback` is optional: the format to retry with if `quality` produces
      // nothing. The app sets it to its stereo choice when asking for atmos,
      // since most tracks have no Atmos master.
      const { adamId, quality, fallback } = await readBody(req);
      if (!adamId || !/^\d+$/.test(String(adamId))) {
        return sendJSON(res, 400, { error: 'adamId (numeric) required' });
      }
      if (findAppleFile(adamId)) {
        return sendJSON(res, 200, { ok: true, ready: true });
      }
      const r = startAppleDecrypt(
        adamId,
        String(quality || 'alac'),
        fallback ? String(fallback) : null,
      );
      return sendJSON(res, 202, { ok: true, ready: false, job: r.id, already: r.already });
    }

    // Serve a decrypted track by adamId. 404 until it exists - the app treats
    // anything other than 200/206 as "still working" and keeps polling.
    const appleFile = /^\/files\/(\d+)\.m4a$/.exec(p);
    if (appleFile && (req.method === 'GET' || req.method === 'HEAD')) {
      if (AGENT_SECRET && req.headers['x-agent-secret'] &&
          req.headers['x-agent-secret'] !== AGENT_SECRET) {
        return sendJSON(res, 403, { error: 'Bad agent secret' });
      }
      const full = findAppleFile(appleFile[1]);
      if (!full) return sendJSON(res, 404, { error: 'Not ready' });
      if (req.method === 'HEAD') {
        const st = fs.statSync(full);
        res.writeHead(200, {
          'Content-Type': 'audio/mp4',
          'Content-Length': st.size,
          'Accept-Ranges': 'bytes',
        });
        return res.end();
      }
      return serveFileRanged(req, res, full);
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
  if (PROXY_MODE) {
    // Server-side console only (never shown in the browser), so the address is
    // fine here and is genuinely useful for debugging a deploy.
    console.log(`Mode: PROXY — forwarding /api and /files to ${AGENT_URL}`);
    console.log('No Docker is used by this process; the agent does the work.');
  } else {
    console.log('Mode: LOCAL — driving Docker directly');
    console.log(`Repo root: ${ROOT}`);
    reapOrphanDownloaders().catch((e) => console.warn('[cleanup]', e));
  }
});
