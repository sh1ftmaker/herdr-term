// Shared-secret gate. This bridge relays keystrokes into a live shell, so an
// unauthenticated public origin is a remote shell for anyone with the URL.
// Set HERDR_TERM_TOKEN to pin a token; HERDR_TERM_NO_AUTH=1 disables the gate
// (only sane when the bridge is bound to loopback).

import crypto from 'node:crypto';

export const AUTH_DISABLED = process.env.HERDR_TERM_NO_AUTH === '1';
export const TOKEN = AUTH_DISABLED
  ? null
  : process.env.HERDR_TERM_TOKEN || crypto.randomBytes(24).toString('base64url');
export const COOKIE = 'herdr_term';

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

function cookieToken(header = '') {
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Accepts ?t= (first visit, then upgraded to a cookie) or the cookie itself.
export function checkRequest(req, url) {
  if (AUTH_DISABLED) return { ok: true, viaQuery: false };
  const fromQuery = url.searchParams.get('t');
  if (fromQuery && safeEqual(fromQuery, TOKEN)) return { ok: true, viaQuery: true };
  const fromCookie = cookieToken(req.headers.cookie);
  if (fromCookie && safeEqual(fromCookie, TOKEN)) return { ok: true, viaQuery: false };
  return { ok: false, viaQuery: false };
}

export const setCookieHeader = () =>
  `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
