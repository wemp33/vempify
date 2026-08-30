// Password gate for Vempify.
//
// Deliberately dependency-free: node:crypto + Express only. No cookie-parser
// (we read req.headers.cookie by hand), no session store (the cookie itself is
// the session, signed with an HMAC so the server holds no state).

import express, { Router } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const loginPagePath = path.join(projectRoot, 'public', 'login.html');

const COOKIE_NAME = 'vempify_auth';
// 400 days is the practical ceiling: Chrome silently clamps any longer
// Max-Age to this value, so asking for more would just be a lie in the
// response header. This is "log in once per device" as far as a cookie can
// promise it - the other half of that promise is VEMPIFY_SECRET being set
// and stable across restarts (see SECRET below).
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // 400 days
const MAX_AGE_SEC = MAX_AGE_MS / 1000;
const DEFAULT_PASSWORD = 'vempify';

const PASSWORD = process.env.VEMPIFY_PASSWORD || DEFAULT_PASSWORD;
if (!process.env.VEMPIFY_PASSWORD) {
  console.warn(
    '[vempify] WARNING: VEMPIFY_PASSWORD is not set - falling back to the default dev password "vempify". Set VEMPIFY_PASSWORD before exposing this server to the internet.'
  );
}

// No VEMPIFY_SECRET means a fresh random secret on every boot, which invalidates
// every outstanding cookie: a restart logs everyone out. That is the intended
// trade-off for never persisting a secret to disk or to the repo. Set
// VEMPIFY_SECRET in the Railway variables to keep sessions across deploys.
const SECRET = process.env.VEMPIFY_SECRET || crypto.randomBytes(32).toString('hex');

// --- primitives ---------------------------------------------------------

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

// Constant-time comparison that is safe for operands of differing length:
// hashing first makes both sides a fixed 32 bytes, so timingSafeEqual can never
// throw on a length mismatch (and the length itself does not leak).
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function sign(timestamp) {
  return crypto.createHmac('sha256', SECRET).update(String(timestamp)).digest('hex');
}

// The device token is signed with the SAME secret but over a domain-separated
// message: "device:<ts>" instead of the session cookie's bare "<ts>". A
// timestamp is all digits, so "device:1724..." can never be the string a
// session signature covers, and the two signatures over the same timestamp are
// therefore unrelated. That is what stops a stolen session cookie from being
// posted to /auth/resume as a device token (and a device token from being
// pasted into the cookie jar as a session): each verifier recomputes its own
// message and the other side's hex never matches.
const DEVICE_DOMAIN = 'device:';

function signDevice(timestamp) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(DEVICE_DOMAIN + String(timestamp))
    .digest('hex');
}

function parseCookies(header) {
  const jar = Object.create(null);
  if (!header) return jar;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name in jar) continue; // first occurrence wins
    const raw = part.slice(eq + 1).trim();
    try {
      jar[name] = decodeURIComponent(raw);
    } catch {
      jar[name] = raw;
    }
  }
  return jar;
}

// --- session cookie -----------------------------------------------------

function isSecureRequest(req) {
  // Railway terminates TLS at its proxy, so the socket here is plain http and
  // req.secure only works because index.js sets 'trust proxy'. The header check
  // is the belt to that braces. Never hardcode Secure: it would make the cookie
  // undeliverable over plain http://localhost during local testing.
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  if (!forwarded) return false;
  return String(forwarded).split(',')[0].trim().toLowerCase() === 'https';
}

function issueSession(req, res) {
  const ts = Date.now();
  res.cookie(COOKIE_NAME, `${ts}.${sign(ts)}`, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_MS,
    secure: isSecureRequest(req),
  });
}

function clearSession(req, res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req),
  });
}

// The session cookie and the device token share one wire format,
// "<issuedAtMs>.<hex HMAC>", and differ only in which signer covers it. One
// parser for both, so the age and shape rules can never drift apart.
function verifyStamped(token, signer) {
  if (typeof token !== 'string' || !token) return false;

  const dot = token.indexOf('.');
  if (dot < 1) return false;

  const ts = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^\d+$/.test(ts) || !signature) return false;

  if (!safeEqual(signature, signer(ts))) return false;

  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age)) return false;
  if (age > MAX_AGE_MS) return false; // expired
  if (age < -MAX_AGE_MS) return false; // absurdly future-dated

  return true;
}

function hasValidSession(req) {
  return verifyStamped(parseCookies(req.headers.cookie)[COOKIE_NAME], sign);
}

// --- device token -------------------------------------------------------

// Why this exists: the cookie alone cannot keep the promise of "log in once".
// An installed iOS PWA has its own storage container, Safari evicts cookies
// from an app that sits unused, and a link opened in someone else's in-app
// browser lands in a third jar entirely. None of that is fixable with cookie
// flags. So the device also keeps a long-lived token in localStorage and can
// trade it back for a session silently - the password is asked once per
// device, and only losing BOTH halves can ask again.
function issueDeviceToken() {
  const ts = Date.now();
  return `${ts}.${signDevice(ts)}`;
}

function verifyDeviceToken(token) {
  return verifyStamped(token, signDevice);
}

// --- routes -------------------------------------------------------------

export const authRouter = Router();

authRouter.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(loginPagePath);
});

authRouter.post(
  '/login',
  express.urlencoded({ extended: false, limit: '1kb' }),
  (req, res) => {
    const submitted = typeof req.body?.password === 'string' ? req.body.password : '';
    if (submitted && safeEqual(submitted, PASSWORD)) {
      issueSession(req, res);
      res.redirect('/');
      return;
    }
    res.redirect('/login?error=1');
  }
);

authRouter.post('/logout', (req, res) => {
  clearSession(req, res);
  res.redirect('/login');
});

// Handing a freshly logged-in device its long-lived token. Requires a session,
// and this router runs ahead of requireAuth, so the check is made here rather
// than inherited. no-store matters: this response body IS a credential and must
// never sit in a proxy or a service worker cache.
authRouter.get('/auth/device-token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!hasValidSession(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ token: issueDeviceToken() });
});

// The way back in for a device whose cookie was evicted. Deliberately reachable
// WITHOUT a session - that is the entire point - but it is not an open door: it
// hands out a session only in exchange for a token this server signed, and the
// signature is domain-separated so a session cookie replayed here proves
// nothing.
//
// express.json is mounted on THIS route only. Globally it would swallow the
// raw upload body in tracks.js and the login form's urlencoded POST.
authRouter.post('/auth/resume', express.json({ limit: '1kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (token && verifyDeviceToken(token)) {
    issueSession(req, res);
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ error: 'Invalid or expired device token.' });
});

// A body that is malformed or over the 1kb limit is just a failed login attempt
// as far as the visitor is concerned - send them back to the form instead of an
// Express stack trace. Scoped to this router, so app errors are unaffected.
// /auth/* is called by fetch(), never by a form, so it gets JSON instead: a
// redirect to an HTML page is a useless answer to a background request.
authRouter.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (req.path.startsWith('/auth/')) {
    res.status(400).set('Cache-Control', 'no-store').json({ error: 'The request could not be read.' });
    return;
  }
  res.redirect('/login?error=1');
});

// --- middleware ---------------------------------------------------------

// Reachable without a session: the login flow itself, plus the handful of brand
// assets the login page links to. Everything else - including /, the app's JS
// and CSS, /api/*, /audio/* and /covers/* - sits behind the gate.
//
// /sw.js and /manifest.webmanifest are here for a non-obvious reason: the
// browser fetches both with credentials OMITTED, so they 401 even for a
// logged-in user, and service worker registration then fails outright - killing
// the offline shell. Neither file contains anything private (the manifest is a
// name and some colours; sw.js is cache logic), and everything they go on to
// request still needs the cookie, so opening them costs nothing. The service
// worker also never intercepts /api/ or /audio/, so no library data or audio
// ever lands in its cache.
//
// /auth/resume is open for the same reason as /login: it is how a device with
// no cookie gets one. It still demands a validly signed device token, so being
// open costs nothing. /auth/device-token is deliberately NOT here - it hands
// out a credential and must stay behind the gate.
const OPEN_PATHS = new Set([
  '/login',
  '/logout',
  '/auth/resume',
  '/favicon.ico',
  '/sw.js',
  '/manifest.webmanifest',
]);
const OPEN_PREFIXES = ['/icons/'];

// These carry data, not pages: answer them with JSON so fetch() and the <audio>
// element get a clean error instead of a login page pretending to be a track.
const DATA_PREFIXES = ['/api/', '/audio/', '/covers/'];

function isOpen(pathname) {
  if (OPEN_PATHS.has(pathname)) return true;
  return OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isDataRequest(pathname) {
  return DATA_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function looksLikeNavigation(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // A request for the app root or for an .html file is a page by definition, no
  // matter what headers it carries. Header sniffing alone is not enough: curl
  // and other non-browser clients send neither Sec-Fetch-* nor an html Accept,
  // and answering their "GET /" with a JSON 401 hides the gate rather than
  // showing it. Subresources (JS modules, CSS) never take this branch, so they
  // still get the 401 they need.
  if (req.path === '/' || req.path.endsWith('.html')) return true;
  if (req.headers['sec-fetch-mode'] === 'navigate') return true;
  if (req.headers['sec-fetch-dest'] === 'document') return true;
  return String(req.headers.accept || '').includes('text/html');
}

export function requireAuth(req, res, next) {
  if (isOpen(req.path) || hasValidSession(req)) {
    next();
    return;
  }

  if (!isDataRequest(req.path) && looksLikeNavigation(req)) {
    res.set('Cache-Control', 'no-store');
    res.redirect('/login');
    return;
  }

  // Data endpoints and subresources (JS modules, CSS, the manifest) get a status
  // code rather than a redirect - an HTML login page served as a JS module or an
  // audio stream is a far more confusing failure than a plain 401.
  res.status(401).set('Cache-Control', 'no-store').json({ error: 'Unauthorized' });
}

export default requireAuth;
