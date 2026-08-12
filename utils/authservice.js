/**
 * Client for the `pair` Edge Function — the device sign-in flow (docs/11).
 *
 * Deliberately thin, exactly like utils/faceservice.js: `fetch` + JSON, because
 * those are what the QuickJS runtime on the glasses actually provides. The
 * function does all the real work; this only moves the four messages of the
 * handshake.
 *
 *   start(deviceUid) → { deviceCode, deviceUid, userCode, verificationUrl, intervalMs }
 *   poll(deviceCode) → { status: 'pending'|'approved'|'claimed'|'expired', confirmWord? }
 *   claim(deviceCode)→ { status: 'claimed', token, ownerId }  (after the wearer confirms)
 *   check(token)     → { ok, ownerId }                        (is a stored token still good?)
 */

const DEFAULT_TIMEOUT_MS = 15000;

function friendly(error, host) {
  const text = String((error && error.message) || error || '');
  if (/timed out/i.test(text)) return 'Sign-in server did not answer in time.';
  if (/fetch|network|failed|refused|ECONN|Unable/i.test(text)) return 'Cannot reach ' + host + '.';
  return text || 'Sign-in failed.';
}

export function createAuthService(config) {
  const projectUrl = String((config && config.projectUrl) || '').replace(/\/+$/, '');
  const apiKey = (config && config.apiKey) || '';
  // Low-privilege app-identity key; sent only when set. See utils/faceservice.js.
  const appKey = (config && config.appKey) || '';
  const timeoutMs = (config && config.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const endpoint = projectUrl + '/functions/v1/pair';

  const configured = Boolean(projectUrl && apiKey && projectUrl.indexOf('YOUR-PROJECT-REF') === -1);

  // Same best-effort deadline as faceservice: no AbortController on this runtime,
  // and setTimeout is not on every build, so race a timer only when there is one.
  function withDeadline(promise) {
    if (typeof setTimeout !== 'function') return promise;
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
    ]);
  }

  async function call(body, bearer) {
    if (!configured) {
      throw new Error('Sign-in is not configured. Set AUTH.projectUrl and AUTH.apiKey in config.js.');
    }
    let response;
    try {
      response = await withDeadline(
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: apiKey,
            // A device token when we have one (check), otherwise the anon key so
            // the request clears the functions gateway.
            authorization: 'Bearer ' + (bearer || apiKey),
            // The app-identity key, when configured. Only the POST handshake
            // carries it; the pair GET web routes cannot send a custom header.
            ...(appKey ? { 'x-app-key': appKey } : {}),
          },
          body: JSON.stringify(body),
        })
      );
    } catch (error) {
      throw new Error(friendly(error, projectUrl));
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* fall through */
    }
    if (!response.ok && !(parsed && parsed.status)) {
      const detail = (parsed && parsed.error) || text.slice(0, 200) || ('HTTP ' + response.status);
      throw new Error(detail);
    }
    return parsed || {};
  }

  return {
    configured,
    verificationBase: endpoint,

    /**
     * Begin a pairing.
     *
     * @param {string} [deviceUid] the secret these glasses were issued the first
     *   time they paired. Sending it back is what keeps the wearer's people
     *   memory across a sign-out: the backend resolves it to the tenant they
     *   already have instead of opening an empty one. Omit it on a device that
     *   has never paired — the response carries the one to store from then on.
     */
    async start(deviceUid) {
      const r = await call(deviceUid
        ? { action: 'start', device_uid: deviceUid }
        : { action: 'start' });
      return {
        deviceCode: r.device_code,
        deviceUid: r.device_uid || deviceUid || '',
        userCode: r.user_code,
        verificationUrl: r.verification_url,
        // Full, tappable link (code baked in) — clickable in the Hi Rokid app.
        link: r.link || r.verification_url,
        intervalMs: ((r.interval || 3) * 1000),
      };
    },

    async poll(deviceCode) {
      const r = await call({ action: 'poll', device_code: deviceCode });
      return { status: r.status, confirmWord: r.confirm_word || '' };
    },

    async claim(deviceCode) {
      const r = await call({ action: 'claim', device_code: deviceCode });
      return { status: r.status, token: r.token || '', ownerId: r.owner_id || '' };
    },

    /** Verify a token we already hold; catches a device revoked from the web. */
    async check(token) {
      if (!token) return { ok: false };
      try {
        const r = await call({ action: 'check' }, token);
        return { ok: Boolean(r.ok), ownerId: r.owner_id || '' };
      } catch (error) {
        // A definite "signed out" (the function's 401) means the token was
        // revoked or expired — sign out. Anything else is a network blip, and
        // must NOT sign the wearer out, so treat it as still-valid-but-offline.
        const msg = String((error && error.message) || error);
        if (/signed out|no token/i.test(msg)) return { ok: false };
        return { ok: true, offline: true };
      }
    },
  };
}
