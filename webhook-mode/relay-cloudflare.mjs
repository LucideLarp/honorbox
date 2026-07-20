// HonorBox webhook relay — Cloudflare Workers variant.
//
// Turns a Stripe webhook into a GitHub repository_dispatch so the ops repo's
// fulfillment workflow runs seconds after checkout instead of on the next
// poll. It does NO fulfillment itself and holds NO Stripe API key — all it
// can do is (a) check a webhook signature and (b) ask one GitHub repo to run
// a workflow. Zero dependencies; paste this one file and you're done.
//
// Deploy (free tier, no card):
//   1. dash.cloudflare.com → Workers & Pages → Create → paste this file
//   2. Worker → Settings → Variables and Secrets → add the three secrets below
//   3. Stripe Dashboard → Developers → Webhooks → Add endpoint: the worker's
//      URL, events `checkout.session.completed` and
//      `checkout.session.async_payment_succeeded` → copy the signing secret
//      into STRIPE_WEBHOOK_SECRET
//
// Secrets (Workers "secret" type — never in code, never in a repo):
//   STRIPE_WEBHOOK_SECRET  whsec_... from the Stripe endpoint you created
//   GITHUB_TOKEN           fine-grained PAT: ops repo ONLY, Contents: R/W
//                          (GitHub's minimum for repository_dispatch)
//   GITHUB_REPO            "you/yourstore-ops"
// Optional:
//   GITHUB_EVENT_TYPE      dispatch event type (default "honorbox_sale")
//
// Full guide + threat model: docs/instant-delivery.md in the HonorBox repo.

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

export default { fetch: handleWebhook };
