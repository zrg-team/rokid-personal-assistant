/**
 * The phone sign-in page, served by the `pair` function on GET.
 *
 * It runs in an ordinary mobile browser — no app to install. It signs the wearer
 * in with Supabase (email one-time code by default; enable Google in the Supabase
 * dashboard and it works the same way), then calls the function's `approve`
 * action with the user's token. `functions.invoke` attaches that token as the
 * Authorization header, which is how the function knows a real person approved.
 *
 * Everything here is public: the anon key is meant to ship to browsers, and the
 * page can touch nothing directly — the tables are behind RLS with no policies.
 */
export function verifyPage(supabaseUrl: string, anonKey: string, code: string): string {
  const boot = JSON.stringify({ url: supabaseUrl, anon: anonKey, code });
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — People Memory</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#000; color:#e6f2e8; font:16px/1.5 -apple-system,system-ui,sans-serif;
         display:flex; justify-content:center; padding:28px 18px; }
  .card { width:100%; max-width:420px; border:2px solid rgba(64,255,94,.6); border-radius:14px; padding:22px; }
  h1 { font-size:18px; margin:0 0 4px; color:#40ff5e; }
  p { color:#9fbfa8; margin:6px 0 16px; font-size:14px; }
  label { display:block; font-size:12px; color:#9fbfa8; margin:14px 0 5px; }
  input { width:100%; background:#000; color:#e6f2e8; border:1px solid #2b6b3a; border-radius:9px;
          padding:12px; font-size:16px; }
  button { width:100%; margin-top:16px; background:#0b160d; color:#40ff5e; border:2px solid #40ff5e;
           border-radius:10px; padding:13px; font-size:16px; font-weight:600; }
  button:disabled { opacity:.5; }
  .word { font-size:26px; font-weight:700; letter-spacing:1px; color:#40ff5e; text-align:center;
          border:1px dashed rgba(64,255,94,.5); border-radius:10px; padding:16px; margin:10px 0; }
  .msg { margin-top:14px; font-size:14px; min-height:20px; }
  .msg.bad { color:#ff9d8f; }
  .hide { display:none; }
</style></head>
<body>
  <div class="card">
    <h1>Link your glasses</h1>
    <p>Sign in, then approve the pairing your glasses are showing.</p>

    <div id="step-code">
      <label>Code from your glasses</label>
      <input id="code" placeholder="green-tiger-42" autocomplete="off" autocapitalize="none" />
      <label>Your email</label>
      <input id="email" type="email" placeholder="you@example.com" autocomplete="email" />
      <button id="send">Send me a code</button>
    </div>

    <div id="step-otp" class="hide">
      <label>Enter the code we emailed you</label>
      <input id="otp" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" />
      <button id="verify">Verify &amp; approve</button>
    </div>

    <div id="step-done" class="hide">
      <p>On your glasses you should see this word. Check it matches, then press the temple to finish.</p>
      <div class="word" id="confirm">—</div>
    </div>

    <div class="msg" id="msg"></div>
  </div>

<script type="module">
  import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  const BOOT = ${boot};
  const sb = createClient(BOOT.url, BOOT.anon);
  const $ = (id) => document.getElementById(id);
  const msg = (t, bad) => { const m = $('msg'); m.textContent = t || ''; m.className = 'msg' + (bad ? ' bad' : ''); };
  if (BOOT.code) $('code').value = BOOT.code;

  $('send').addEventListener('click', async () => {
    const email = $('email').value.trim();
    if (!email) return msg('Enter your email.', true);
    if (!$('code').value.trim()) return msg('Enter the code from your glasses.', true);
    $('send').disabled = true; msg('Sending…');
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    $('send').disabled = false;
    if (error) return msg(error.message, true);
    $('step-code').classList.add('hide'); $('step-otp').classList.remove('hide');
    msg('Check your email for a 6-digit code.');
  });

  $('verify').addEventListener('click', async () => {
    const email = $('email').value.trim();
    const token = $('otp').value.trim();
    const user_code = $('code').value.trim();
    if (!token) return msg('Enter the emailed code.', true);
    $('verify').disabled = true; msg('Verifying…');
    const v = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (v.error) { $('verify').disabled = false; return msg(v.error.message, true); }

    // Now signed in — approve the pairing. invoke() attaches the user's token.
    const { data, error } = await sb.functions.invoke('pair', { body: { action: 'approve', user_code } });
    $('verify').disabled = false;
    if (error || !data || data.ok === false) {
      return msg((data && data.error) || (error && error.message) || 'Could not approve this code.', true);
    }
    $('step-otp').classList.add('hide'); $('step-done').classList.remove('hide');
    $('confirm').textContent = data.confirm_word;
    msg('Approved. Finish on your glasses.');
  });
</script>
</body></html>`;
}
