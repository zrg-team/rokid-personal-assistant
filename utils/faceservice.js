/**
 * Client for the Supabase Edge Functions that do the face work.
 *
 * Deliberately thin. The functions decide who someone is and what to say about
 * them; this file only moves bytes. Everything here is `fetch` + JSON + base64,
 * the same three things utils/composio.js relies on, because those are what the
 * QuickJS runtime on the glasses actually provides — no Supabase SDK, which
 * expects a browser or Node and would not load here.
 *
 * The photo travels as base64 inside a JSON body rather than as a binary body:
 * JSON is the one request shape proven to survive the Ink `fetch` bridge, and
 * the ~33% size penalty is irrelevant next to the round trip.
 */

import { toBase64 } from './bytes.js';

const DEFAULT_TIMEOUT_MS = 20000;

function friendly(error, host) {
  const text = String((error && error.message) || error || '');

  // The realistic failures on glasses are a dead wifi link or a project URL
  // that was never filled in — so say that, rather than reading a stack trace
  // out loud to someone wearing the thing.
  if (/timed out/i.test(text)) return 'Supabase did not answer in time.';
  if (/fetch|network|failed|refused|ECONN|Unable/i.test(text)) {
    return 'Cannot reach ' + host + '.';
  }
  return text || 'The face service failed.';
}

export function createFaceService(config) {
  const projectUrl = String((config && config.projectUrl) || '').replace(/\/+$/, '');
  const apiKey = (config && config.apiKey) || '';
  const ownerId = (config && config.ownerId) || 'default';
  const ownerToken = (config && config.ownerToken) || '';
  // Low-privilege app-identity key. Sent only when set; the server's guard()
  // enforces it only when APP_KEY_VALUES is configured. Not a secret (ships in
  // the .aix) — a noise filter + rotation lever, layered on the device token.
  const appKey = (config && config.appKey) || '';
  // The signed-in wearer's device token. When present, the function scopes faces
  // to that wearer (their own people), instead of the shared `default` bucket.
  const deviceToken = (config && config.deviceToken) || '';
  const timeoutMs = (config && config.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const base = projectUrl + '/functions/v1/';

  const configured = Boolean(projectUrl && apiKey && projectUrl.indexOf('YOUR-PROJECT-REF') === -1);

  /**
   * `AbortController` is not in the verified AIUI surface and `setTimeout` is
   * not on every build, so the deadline is best-effort: race a timer when there
   * is one, and otherwise just wait.
   */
  function withDeadline(promise) {
    if (typeof setTimeout !== 'function') return promise;
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
    ]);
  }

  function headers() {
    const h = {
      'content-type': 'application/json',
      // Edge Functions want both: `apikey` gets past the gateway, the bearer
      // token identifies the caller to the function itself.
      apikey: apiKey,
      authorization: 'Bearer ' + apiKey,
      'x-owner-id': ownerId,
    };
    // The device token scopes faces to the signed-in wearer (their own people).
    if (deviceToken) h['x-device-token'] = deviceToken;
    // Present only for a multi-wearer backend without sign-in; proves this
    // caller may act as `ownerId`.
    if (ownerToken) h['x-owner-token'] = ownerToken;
    // The app-identity key, when configured (covers both face and face-people).
    if (appKey) h['x-app-key'] = appKey;
    return h;
  }

  /**
   * HTTP 546 is the edge runtime saying an invocation exceeded its resource
   * budget. It happens when loading the models and running inference land in
   * the same request, on an instance that was cold — so retrying once, on the
   * instance the failed call just warmed, is the fix rather than a workaround.
   */
  const WORKER_LIMIT = 546;

  async function call(fn, options, attempt) {
    if (!configured) {
      throw new Error('Supabase is not configured. Set FACE.projectUrl and FACE.apiKey in config.js.');
    }

    let response;
    try {
      response = await withDeadline(
        fetch(base + fn, {
          method: (options && options.method) || 'POST',
          headers: headers(),
          body: options && options.body ? JSON.stringify(options.body) : undefined,
        })
      );
    } catch (error) {
      throw new Error(friendly(error, projectUrl));
    }

    if (response.status === WORKER_LIMIT && !attempt) {
      return call(fn, options, 1);
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON — fall through to the raw prefix below */
    }

    if (!response.ok) {
      const detail = (parsed && parsed.error) || text.slice(0, 200) || ('HTTP ' + response.status);
      // A device token the backend rejects means this device was revoked or
      // signed out — not a face-service fault. Say so in the words the pages
      // already route on, so the wearer is sent to sign-in rather than shown a
      // recognition error they cannot act on.
      if (/signed out/i.test(detail)) {
        const signedOut = new Error('Signed out — say “Kavi sign in”.');
        signedOut.reason = 'signed-out';
        throw signedOut;
      }
      throw new Error('Face service: ' + detail);
    }
    return parsed;
  }

  return {
    configured,
    projectUrl,

    /**
     * Who is in this photo?
     * @param {Uint8Array} bytes  JPEG straight from the camera
     * @param {object} [context]  { rows } — today's agenda, for the tie-in
     */
    identify(bytes, context) {
      return call('face', {
        body: { mode: 'identify', image: toBase64(bytes), context: context || {} },
      });
    },

    /**
     * Remember a face under a name.
     *
     * `bytes` may be null. Every spoken command is a fresh page, so the photo
     * taken for "who is this" is gone by the time the wearer says "remember her
     * as Tracy" — the service keeps the last capture for a few minutes and uses
     * it when no photo arrives.
     */
    remember(bytes, options) {
      const it = options || {};
      return call('face', {
        body: {
          mode: 'remember',
          image: bytes ? toBase64(bytes) : undefined,
          name: it.name,
          note: it.note,
          email: it.email,
          id: it.id,
        },
      });
    },

    /**
     * Load the models before they are needed.
     *
     * Called when the page opens, so the ~3 s cold start overlaps the time the
     * wearer spends aiming. Failures are ignored on purpose: this is an
     * optimisation, and the capture path handles a cold instance on its own.
     */
    warm() {
      return call('face', { body: { warmup: true } }).catch(() => null);
    },

    people() {
      return call('face-people', { method: 'GET' });
    },

    /**
     * Attach or correct what the wearer knows about someone.
     *
     * No photo involved: "note that he runs the security review" is about a
     * person already in the memory, not about whoever is in front of the
     * camera right now.
     */
    annotate(id, fields) {
      const it = fields || {};
      return call('face-people', {
        body: { id, name: it.name, note: it.note, email: it.email },
      });
    },

    /** Delete someone and every vector stored for them. */
    forget(id) {
      return call('face-people?id=' + encodeURIComponent(id), { method: 'DELETE' });
    },

    async count() {
      try {
        const result = await this.people();
        // `| 0` is not decoration. A number out of JSON.parse is a double, and
        // Ink renders it as "1.0"; the agenda's count only looked right because
        // it came from an array length, which is already an integer.
        return ((result && result.count) || 0) | 0;
      } catch {
        // The header count is decoration; never let it block the capture path.
        return 0;
      }
    },
  };
}
