/**
 * The sign-in gate (docs/11).
 *
 * An AIUI agent has no home screen — a page only appears when the host model
 * dispatches it, or when the app navigates to it. So sign-in is reached two ways,
 * never "always on":
 *
 *   1. Command — the wearer says "sign in" and the host model opens
 *      pages/signin (its <script def> description makes it dispatchable).
 *   2. Gate — the wearer opens ANY page (calendar, face) with no stored token,
 *      and that page redirects to sign-in first. This helper is that gate.
 *
 * Each entry page calls `requireSignin(wx)` at the very top of onLoad:
 *
 *     if (requireSignin(wx)) return;   // redirected to sign-in; stop here
 *
 * It is inert unless AUTH.required is true, so the demo is unchanged by default.
 */
import { AUTH } from '../config.js';
import { createStore, wxBackend } from './store.js';

/**
 * @param {object} wx
 * @param {string} [utterance] what the wearer said, carried through to the
 *   sign-in card. "Kavi sync" said while signed out must still mean "finish the
 *   sign-in I approved on my phone" — dropping it here would lose that.
 * @returns {boolean} true if it redirected to sign-in (the caller must `return`).
 */
export function requireSignin(wx, utterance) {
  if (!AUTH.required) return false;

  const store = createStore(wxBackend(wx));
  const saved = store.read(AUTH.tokenKey);
  if (saved && saved.token) return false;   // already signed in

  try {
    // redirectTo replaces the current page, so Back does not return to a page
    // the wearer was never allowed to see.
    const said = String(utterance || '');
    wx.redirectTo({
      url: '/pages/signin/signin' + (said ? '?utterance=' + encodeURIComponent(said) : ''),
    });
  } catch (error) {
    /* the harness may not navigate; on-device this routes to sign-in */
  }
  return true;
}
