// HonorBox webhook relay — Val Town / plain Node variant.
//
// Same relay as relay-cloudflare.mjs (see that file or webhook-mode/README.md
// for what it does and does not do), in the shape the other free tier speaks:
//
//   Val Town (free, no card):  create an HTTP val, paste this file, set the
//     three environment variables below in the val's settings. Val Town calls
//     the default export with a standard Request and serves the Response.
//
//   Plain Node ≥ 20 (any box you already run):  `node relay-node.mjs` starts
//     an HTTP server on PORT (default 8787) wrapping the same handler. Put it
//     behind TLS (Stripe requires https endpoints).
//
// Environment (set in Val Town's env settings / the process environment):
//   STRIPE_WEBHOOK_SECRET  whsec_... from your Stripe webhook endpoint
//   GITHUB_TOKEN           fine-grained PAT: ops repo ONLY, Contents: R/W
//   GITHUB_REPO            "you/yourstore-ops"
// Optional:
//   GITHUB_EVENT_TYPE      dispatch event type (default "honorbox_sale")
//   PORT                   plain-Node listen port (default 8787)
//
// The verification/dispatch core is intentionally identical to the Cloudflare
// file — both are covered by the same test vectors in
// scripts/test/dispatch.test.js, so they cannot drift apart silently.

const encoder = new TextEncoder();

// --- Stripe signature verification -----------------------------------------
// Header: `Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=...]`. The signed
// payload is `${t}.${rawBody}`, HMAC-SHA256 keyed with the endpoint's signing
// secret (the whsec_... string used as-is). Multiple v1 entries appear while
// a secret is being rolled — any one match is a pass. Timestamps outside the
// tolerance window are rejected to blunt replay of a captured request.

export function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d+$/.test(v)) out.t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) out.v1.push(v.toLowerCase());
  }
  return out;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyStripeSignature(rawBody, header, secret, opts = {}) {
  const toleranceSeconds = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Date.now() / 1000;
  const { t, v1 } = parseSignatureHeader(header);
  if (!secret || t === null || v1.length === 0) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${rawBody}`)));
  return v1.some((sig) => constantTimeEqual(mac, hexToBytes(sig)));
}

// --- GitHub dispatch --------------------------------------------------------

// Events worth waking the fulfiller for; everything else is acked and dropped.
const RELEVANT = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

// Same 10-char hashed ref the ledger uses — a workflow run can be matched to
// its ledger row without the raw session id appearing anywhere.
async function sessionRef(sessionId) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(sessionId));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
}

// No buyer data crosses this bridge: the workflow re-reads the truth from
// Stripe's API via the normal poller logic. The payload only says "a sale
// happened, go look".
export async function buildDispatch(event, eventType = 'honorbox_sale') {
  const session = (event.data && event.data.object) || {};
  return {
    event_type: eventType,
    client_payload: {
      event: event.type,
      livemode: !!event.livemode,
      created: event.created || null,
      ref: session.id ? await sessionRef(session.id) : null,
    },
  };
}

export async function handleWebhook(request, env) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  if (!env.STRIPE_WEBHOOK_SECRET || !env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return new Response('relay not configured', { status: 500 });
  }

  const rawBody = await request.text();
  const ok = await verifyStripeSignature(
    rawBody, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET
  );
  if (!ok) return new Response('bad signature', { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('bad json', { status: 400 }); }
  // `event?.` because a signed body of literal `null` parses to null and would
  // otherwise throw here — a 1101 from the Worker and a Stripe retry loop for a
  // request that can never succeed. Stripe does not send that, so this is
  // robustness rather than a hole, but the relay now takes real money traffic.
  if (!RELEVANT.includes(event?.type)) return new Response('ignored', { status: 200 });

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'honorbox-relay',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(await buildDispatch(event, env.GITHUB_EVENT_TYPE || 'honorbox_sale')),
  });
  // 204 = dispatched. Anything else → 502 so Stripe retries the webhook —
  // Stripe's retry schedule is this relay's reliability layer, for free.
  if (res.status !== 204) return new Response(`github dispatch failed: ${res.status}`, { status: 502 });
  return new Response('dispatched', { status: 200 });
}

// --- Platform adapters ------------------------------------------------------

function readEnv() {
  const get = (name) =>
    typeof Deno !== 'undefined' ? Deno.env.get(name) : process.env[name];
  return {
    STRIPE_WEBHOOK_SECRET: get('STRIPE_WEBHOOK_SECRET'),
    GITHUB_TOKEN: get('GITHUB_TOKEN'),
    GITHUB_REPO: get('GITHUB_REPO'),
    GITHUB_EVENT_TYPE: get('GITHUB_EVENT_TYPE'),
  };
}

// Val Town HTTP val entry point (also what the plain-Node server wraps).
export default async function relay(request) {
  return handleWebhook(request, readEnv());
}

// Plain-Node bootstrap: only when this file itself is `node relay-node.mjs`.
// Parse-safe on Val Town/Deno (never executes there); inert under `import`.
if (typeof Deno === 'undefined' && typeof process !== 'undefined' && process.argv[1]) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { createServer } = await import('node:http');
    const port = Number(process.env.PORT || 8787);
    createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers: { 'stripe-signature': req.headers['stripe-signature'] || '' },
            body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
          });
          const response = await relay(request);
          res.statusCode = response.status;
          res.end(await response.text());
        } catch (err) {
          res.statusCode = 500;
          res.end('relay error'); // detail stays in the server log, not the wire
          console.error(err);
        }
      });
    }).listen(port, () => console.log(`honorbox relay listening on :${port}`));
  }
}
