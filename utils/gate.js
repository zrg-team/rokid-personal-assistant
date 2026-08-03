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
 * @returns {boolean} true if it redirected to sign-in (the caller must `return`).
 */
export function requireSignin(wx) {
  if (!AUTH.required) return false;

  const store = createStore(wxBackend(wx));
  const saved = store.read(AUTH.tokenKey);
  if (saved && saved.token) return false;   // already signed in

  try {
    // redirectTo replaces the current page, so Back does not return to a page
    // the wearer was never allowed to see.
    wx.redirectTo({ url: '/pages/signin/signin' });
  } catch (error) {
    /* the harness may not navigate; on-device this routes to sign-in */
  }
  return true;
}
