# 17 — The login flow, in ASCII

*Every part of Kavi's sign-in drawn as a diagram: the cast, the handshake, the
state machine, the card states, the branches that fail, and what ends up stored
where. Traced from the shipped code, not from the earlier plans — where docs
[11](11-aiui-on-glasses-login-flow.md) and [13](13-google-calendar-auth.md)
disagree with each other, this file follows what
`supabase/functions/pair/index.ts` and `pages/signin/signin.ink` actually do.*

---

## 0. The one-paragraph version

It is the **smart-TV login** (RFC 8628 device authorization, trimmed). The
glasses cannot host a browser or take typing, so they show a short word-code and
a link, the real login happens in a phone browser, and the glasses poll until
they can pick up a token. There is **no email, no password, no account signup**:
the device *is* the identity, and authorizing Google is a connection on top of
that — not the login itself. Which wearer a set of glasses belongs to is decided
by the `device_uid` they hold (§9a), so signing in a second time returns to the
same people memory rather than opening an empty one.

---

## 1. The cast

```
      GLASSES (Rokid, QuickJS + Ink)            PHONE (any browser, nothing installed)
   +---------------------------------+       +----------------------------------+
   |  pages/signin/signin.ink        |       |  Google's own consent screen     |
   |  utils/authservice.js           |       |  (reached via Composio OAuth)    |
   |  utils/gate.js  (requireSignin) |       |  + one line of plain text back   |
   |  wx storage: device token       |       +----------------------------------+
   +---------------------------------+                      |
                   |                                        |
                   |  POST  (anon key)                      |  GET  (302 / text)
                   v                                        v
      +--------------------------------------------------------------------+
      |            SUPABASE EDGE FUNCTION:  /functions/v1/pair             |
      |     start | poll | claim | approve | check      +  GET ?go / ?done  |
      +--------------------------------------------------------------------+
                   |                                        |
                   v                                        v
      +-------------------------------+        +---------------------------+
      |  postgres (RLS on, 0 policies)|        |  Composio  (holds the     |
      |   pairing_sessions            |        |  wearer's Google grant,   |
      |   devices                     |        |  keyed by owner_id)       |
      +-------------------------------+        +---------------------------+
```

Only the Edge Function (service-role key) can touch those tables. The glasses
carry the Supabase **anon** key purely to clear the functions gateway — it grants
no data access.

---

## 2. The whole flow at a glance

```
   wearer says "kavi sign in" / "kavi status"     OR   any page opens with no token
   (the wake word prefixes every command -- §7)                    |
                  |                                                |
                  +------------------------+-----------------------+
                                           v
                              +-------------------------+
                              |  pages/signin/signin    |
                              +-------------------------+
                                           |
                                  POST { action: 'start' }
                                           v
   +---------------------------------------------------------------------------+
   |  GLASSES SHOW:   a tappable link   +   a word-code (e.g. jade-delta-06)    |
   |  server made:    device_code (secret, glasses only)                        |
   |                  user_code   (public, human)                               |
   |                  owner_id    (the identity, minted here)                   |
   +---------------------------------------------------------------------------+
                  |                                          ^
                  |  wearer opens the link on a phone        |  poll every 3s
                  v                                          |  (device_code)
   +-------------------------------------------+             |
   |  PHONE -> 302 -> Google consent -> Allow   |            |
   |  Composio stores the grant under owner_id  |            |
   |  session status: pending -> approved       |            |
   +-------------------------------------------+             |
                  |                                          |
                  |  poll now answers 'approved' + confirm_word
                  v                                          |
   +---------------------------------------------------------------------------+
   |  BOTH SCREENS SHOW THE SAME WORD PAIR   ->  wearer compares  ->  presses   |
   +---------------------------------------------------------------------------+
                                           |
                                  POST { action: 'claim' }
                                           v
   +---------------------------------------------------------------------------+
   |  server: insert devices(owner_id, sha256(token)), session -> 'claimed'     |
   |  glasses: store { token, ownerId }  ->  redirectTo /pages/index/index      |
   +---------------------------------------------------------------------------+
```

---

## 3. The handshake, message by message

Time runs down. `==>` is a request, `<--` its response.

```
 GLASSES                    pair function                 PHONE            COMPOSIO/GOOGLE
    |                            |                          |                     |
    |== POST {action:'start'} ==>|                          |                     |
    |                            |-- mint owner_id (uuid)   |                     |
    |                            |-- device_code = 24B hex  |                     |
    |                            |-- user_code   = word-word-NN                   |
    |                            |-- confirm_word= word-word                      |
    |                            |-- insert pairing_sessions(status='pending',     |
    |                            |          device_hash=sha256(device_code))       |
    |<-- {device_code, user_code, link, expires_in:600, interval:3}                |
    |                            |                          |                     |
    | show link + user_code      |                          |                     |
    |                            |                          |                     |
    |== POST {action:'poll'} ===>|  status='pending'        |                     |
    |<-- {status:'pending'} -----|                          |                     |
    |         (repeat every 3s)  |                          |                     |
    |                            |<== GET ?go=user_code ====|                     |
    |                            |   look up session by user_code                 |
    |                            |   composio.authConfigId('googlecalendar')       |
    |                            |   composio.link(cfg, owner_id, back)  =========>|
    |                            |<------------------------- OAuth URL ------------|
    |                            |--- 302 Location: <google consent> ---->|        |
    |                            |                          |== Allow ===========>|
    |                            |                          |<-- redirect to back -|
    |                            |<== GET ?done=1&code=user_code ==========|       |
    |                            |   composio.status(owner_id) x5, 1.2s apart ====>|
    |                            |<------------------------- connected ------------|
    |                            |   UPDATE status='approved'                     |
    |                            |--- text: 'Signed in! ... word "jade-delta"' -->|
    |                            |                          |                     |
    |== POST {action:'poll'} ===>|  status='approved'       |                     |
    |<-- {status:'approved', confirm_word:'jade-delta'} ----|                     |
    |                            |                          |                     |
    | show word; wearer compares both screens and presses the temple              |
    |                            |                          |                     |
    |== POST {action:'claim'} ==>|  token = 32B hex                               |
    |                            |  INSERT devices(owner_id, sha256(token))       |
    |                            |  UPDATE status='claimed'                       |
    |<-- {status:'claimed', token, owner_id} ---|                                  |
    |                            |                          |                     |
    | store token, redirectTo index                                               |
```

The raw `token` crosses the wire **exactly once**, right here. Nothing stores it
in the clear — the database keeps only `sha256(token)`.

### Two shapes of the same link

`start` decides which link to print based on one server env var:

```
   CONNECT_PAGE_URL unset  ->  link = <pair>?go=<user_code>
                               tap -> 302 -> Google consent -> ?done=1 -> approved
                               (single service: calendar, and it approves for you)

   CONNECT_PAGE_URL set    ->  link = <hub>?code=<user_code>
                               tap -> connections hub, a list of services
                               each Connect -> connections.authorize -> Composio
                               a separate POST {action:'approve'} finishes the pairing
```

Both end at the same place: `status='approved'` with the `confirm_word` ready.
The `approve` action deliberately does **not** require any particular service to
be connected — face and text memory work with nothing authorized at all.

---

## 4. The session state machine

```
                          POST start
                              |
                              v
                        +-----------+
                        |  pending  |----- 10 min with no phone ---+
                        +-----------+                              |
                              |                                    |
       GET ?done=1  (Composio confirms connected)                  |
       or POST approve  (hub)                                      |
                              |                                    v
                              v                            +---------------+
                        +-----------+                      |    expired    |
                        | approved  |--- 10 min, unclaimed>|  (read-time   |
                        +-----------+                      |   check, and  |
                              |                            |   pg_cron     |
                        POST claim                         |   sweeps it)  |
                              |                            +---------------+
                              v                                    |
                        +-----------+                              v
                        |  claimed  |  terminal; never expires   deleted
                        +-----------+  (survives the sweep)
```

Note the asymmetry: `claimed` is exempt from both the expiry check and the
`purge_expired_pairings()` sweep, so a second `claim` on the same code answers
"already signed in" instead of vanishing.

---

## 5. What the glasses card shows, state by state

```
  status: 'starting'                       status: 'waiting'
  +-----------------------------+          +-----------------------------+
  | Sign in                     |          | Sign in                 ... |
  | --------------------------- |          | --------------------------- |
  |                             |          | Tap this on your phone      |
  |                             |          | https://<ref>.supabase.co/  |
  | Starting...                 |          |   functions/v1/pair?go=...  |
  +-----------------------------+          | or enter code               |
                                           |   jade-delta-06             |
     speaks nothing yet                    +-----------------------------+
                                             speaks: "tap the link on your
                                                      phone..."   polls 3s

  status: 'approved'                       status: 'signed-in'
  +-----------------------------+          +-----------------------------+
  | Sign in                     |          | Sign in                     |
  | --------------------------- |          | --------------------------- |
  | Your phone should show      |          | Signed in                   |
  |   brave-otter               |          |                             |
  | Matches? Press the temple.  |          | Press to continue.          |
  +-----------------------------+          +-----------------------------+

  status: 'failed'
  +-----------------------------+           one press means something different
  | Sign in                     |           in each state:
  | --------------------------- |
  | That code expired.          |             waiting   -> poll once now
  | Press to try again.         |             approved  -> claim the token
  +-----------------------------+             signed-in -> go to the app
                                              starting/failed -> start over
```

The URL is rendered at 11px on one line on purpose: the Ink CSS engine supports
neither `word-break` nor wrapping, so a longer host clips rather than wraps. Set
`PAIR_VERIFY_URL` to a short custom domain if that bites.

---

## 6. Why the confirm word exists

```
    Without it:  anyone who overhears "jade-delta-06" can open the link,
                 connect THEIR Google, and the glasses sign into their account.

    With it:     the word is revealed only after approval, on both screens,
                 and the pairing only completes on a press from the temple.

         GLASSES: brave-otter                    PHONE: brave-otter
                       \                            /
                        \___ same?  press once ____/
                                   |
                                   v
                         bound: this device <-> this owner_id
```

It is a human check against a confused-deputy attack, not a secret: it never
authorizes anything by itself, and it is useless without the `device_code` that
only the glasses hold.

---

## 7. Everything starts with "Kavi"

An AIUI agent has no home screen — a page appears only when the host model
dispatches it, or when the app navigates. **Every spoken command is prefixed with
the agent's coined wake word `Kavi`**, which is what makes it unmistakably this
agent's and not the built-in assistant's. The intended grammar is five commands:

```
   kavi start      / bat dau      -> show the sign-in card, begin a pairing
   kavi sync       / cap nhat     -> pick up the key after authorizing on the web
   kavi <provider> <action>       -> act on a connection through Composio
   kavi halo       / xin chao     -> who is this? (known -> recall, new -> save)
   kavi remember   / nho          -> attach a memory to the person in front of me
```

### The router, in the order it actually runs

`pages/index/index.ink → handleUtterance()` tries each matcher in this order and
takes the first hit:

```
   utterance ("kavi <something>")
        |
        v
   +--- fold(): lowercase, strip Vietnamese tone marks, d -> d ----------------+
   |     so "đăng nhập" and a toneless ASR "dang nhap" become the same string   |
   +---------------------------------------------------------------------------+
        |
        v
   +--- stripKavi(): drop a leading /^(k|c)a ?v(i|y)\b/ ----------------------+
   |     tolerates the ASR spellings kavi / kavy / cavi / ka vi                |
   +---------------------------------------------------------------------------+
        |
        v
   1. signinCommand  KAVI + (sign in|log in|dang nhap) ------> pages/signin
   2. statusCommand  status|connections|login|trang thai|ket noi -> pages/signin
   3. syncCommand    sync|refresh|update|cap nhat|dong bo ---> syncConnections()
   4. connectionCommand  <alias> from config.CONNECTIONS ----+
   |       calendar/lich/agenda -> stays here, action becomes the query
   |       gmail/mail/thu, slack -> pages/connection?slug=..&action=..
   5. faceCommand    remember .. as X | remember that .. | who is this ------> pages/face
   6. fallback ------------------------------------------> LLM planner (calendar)
```

Where the wake word is strictly required differs per matcher, which is worth
knowing when a command "works without saying Kavi":

```
   signinCommand ...... KAVI anchored at the start -- REQUIRED
   status / sync / connection .... stripKavi first -- optional, works either way
   faceCommand ........ raw unanchored regex ------- ignored entirely
```

### What each command maps to

All five are wired in `utils/planner.js`. The synonyms below are what the
matchers actually accept:

```
   command            matcher                what it accepts
   ----------------   --------------------   -------------------------------
   kavi start         signinCommand          start | begin | bat dau |
   / bat dau          statusCommand          khoi dong -- ANCHORED, so
                      -> pages/signin        "when does my flight start"
                                             stays a calendar question.
                                             Also: sign in | log in |
                                             dang nhap | status | connections
                                             | trang thai | ket noi

   kavi sync          syncCommand            sync | resync | refresh | reload
   / cap nhat         -> claim, then         | update | cap nhat | dong bo |
                         re-read connections lam moi.
                                             Claims a pairing that is waiting
                                             to be picked up (section 8a),
                                             THEN says which services are on.

   kavi <provider>    connectionCommand      aliases from config.CONNECTIONS,
   <action>           -> pages/connection    longest alias first, en + vi:
                         (calendar stays     calendar | lich | agenda,
                          on the agenda)     gmail | mail | thu, slack, ...

   kavi halo          faceCommand            hello | hallo | halo | xin chao
   / xin chao         'identify'             | chao -- and NOTHING after it,
                      -> pages/face          so "hello, what is on my
                                             calendar" still reaches the
                                             planner. Known face -> recall;
                                             nobody matched -> offer to enrol.
                                             Also: who is this | ai day |
                                             nguoi nay la ai | chup anh

   kavi remember      faceCommand            NAME: remember this as <x> |
   / nho              'remember' (name)      this is <x> | day la <x> |
                      'note'     (fact)      nho nguoi nay la <x> |
                      -> pages/face          ten (anh ay) la <x>
                                             FACT: remember that <x> |
                                             nho rang <x> | nho la <x> |
                                             ghi chu (rang) <x>
```

The name/fact split is the same in both languages: a person word makes it a
name (`nho nguoi nay la Minh`), its absence makes it a note (`nho la anh ay lam
bao mat`) — mirroring `remember this as X` versus `remember that X`.

### Folding, and why captures come out of the raw text

Matching runs on folded text so Vietnamese works with or without tone marks.
Captures cannot, or a name would come back stripped:

```
   raw       "kavi nho nguoi nay la Nguyễn Minh"
                |                       |
     fold ------+                       |   lowercase, strip marks, d -> d
                v                       |
   folded    "kavi nho nguoi nay la nguyen minh"
                |                       |
   match on folded ----------------+    |   the pattern fires here
                                   |    |
   slice the SAME offsets out of raw ---+   the capture is read here
                                   |
                                   v
                              "Nguyễn Minh"      <- casing and marks intact

   Safe because fold is length-preserving on precomposed (NFC) input: each
   Vietnamese letter decomposes to one base plus marks that are then dropped.
   faceCommand checks folded.length === raw.length before trusting the offsets
   and falls back to the folded capture if that ever stops holding.
```

### The wordless door

Speech is not the only way in. Any page that needs an identity calls the gate
first, so a wearer with no token never reaches a screen they cannot use:

```
   DOOR 1 -- spoken                       DOOR 2 -- the gate (no words at all)
   "kavi sign in" / "kavi status"         any page's onLoad:
        |                                   if (requireSignin(wx)) return;
        |  planner.js                            |
        |                                        |  utils/gate.js reads the token;
        v                                        v  none -> redirectTo signin
   +---------------------------------------------------------+
   |                pages/signin/signin.ink                   |
   +---------------------------------------------------------+

   redirectTo (not navigateTo) from the gate, so Back cannot return to a page
   the wearer was never allowed to see.
```

The gate is inert unless `AUTH.required` is true. It is **true** in the shipped
config (`config.js`), so a store build always gates.

---

## 8a. "Kavi sync" — picking the login up later

A pairing used to live only in the sign-in page's memory. Close that card while
walking to your phone and the code you were about to authorize was stranded:
reopening started a *fresh* pairing with a *different* code, and the one on the
phone screen was dead. The pairing is now persisted under `AUTH.pendingKey` the
moment it is created, and cleared the moment a token is issued.

```
   begin()  ---> store.write(AUTH.pendingKey, {deviceCode, userCode, link})
                                |
                                |   card closes, glasses come off, page unloads
                                v
   +--------------------------------------------------------------------------+
   |  the pairing survives; the code on the phone is still the live one        |
   +--------------------------------------------------------------------------+
                                |
         +----------------------+----------------------+
         |                                             |
   reopen the card                            say "kavi sync" / "cap nhat"
         |                                             |
         v                                             v
   resume(pending, false)                      resume(pending, true)
   poll it once:                               poll it once, and claim outright
     pending  -> show the code again,          (the wearer asking for it IS the
                 keep polling                   deliberate act; see the note)
     approved -> show the confirm word,
                 press to finish                       |
     expired  -> drop it, start fresh                  v
         |                                      token stored, pending cleared
         v
   the section-3 handshake, unchanged
```

The sync path reaches the sign-in card two ways, because a signed-out wearer is
never on the agenda page:

```
   host dispatches pages/signin with the utterance  --> onLoad reads it directly
   host dispatches pages/index while signed out ----> requireSignin forwards the
                                                      utterance on the redirect
   already signed in (or AUTH.required off) --------> index.claimPendingSignin()
                                                      runs inside syncConnections
```

> **The tradeoff, stated plainly.** Claiming on `sync` skips the confirm-word
> comparison of section 6. The press is replaced by the wearer deliberately
> saying "sync" while wearing the glasses — still a human act, but it no longer
> proves the phone that authorized is the phone in their hand. Reopening the card
> without saying "sync" keeps the full check. If that matters more than the
> convenience, make `resume()` ignore `finishNow` and always stop at the word.

---

## 8. Relaunch, offline, and revocation

Every launch of the sign-in page re-verifies a stored token before trusting it:

```
   onLoad
     |
     +-- no stored token ------------------------------> begin() a new pairing
     |
     +-- stored token -> POST {action:'check'} + Bearer <token>
                              |
                              |  server: owner_from_device_token(sha256(token))
                              |          UPDATE last_seen_at, WHERE NOT revoked
                              v
             +----------------+------------------+
             |                |                  |
          200 ok          401 "signed out"    network error
             |                |                  |
             v                v                  v
      stay signed in    wipe the token,   treat as STILL SIGNED IN
                        start a pairing    (offline: bad wifi must never
                                            sign the wearer out)
```

That middle branch is how a device revoked from the web learns it is out: the
`devices.revoked` flag makes the RPC return null, the function answers 401, and
the glasses drop the token on the next check.

---

## 9. What lives where, at rest

```
  ON THE GLASSES                          IN POSTGRES
  +--------------------------------+      +--------------------------------------+
  | wx storage                     |      | pairing_sessions                     |
  |                                |      |   device_hash  = sha256(device_code) |
  |  people-memory:device-token    |      |   user_code    (plain, it is public) |
  |   = { token, ownerId }         |      |   confirm_word (plain, it is public) |
  |                                |      |   status, owner_id, expires_at       |
  |  people-memory:pending-pairing |      +--------------------------------------+
  |   = { deviceCode, userCode,    |      | devices                              |
  |       link }                   |      |   owner_id                           |
  |   only while a sign-in is in   |      |   token_hash = sha256(token)         |
  |   flight; cleared on claim (8a)|      |   revoked, last_seen_at              |
  +--------------------------------+      +--------------------------------------+

  NOT on the glasses:                     RLS enabled, ZERO policies: anon and
   - no password                          authenticated can read nothing. Only
   - no Google token                      the Edge Function's service-role key
   - no service-role key                  reaches these rows.
   - no email address

  AT COMPOSIO
  +--------------------------------+      The device_code IS a secret, and it
  | the wearer's Google grant,     |      now sits in storage for up to 10
  | keyed by owner_id              |      minutes. It buys nothing on its own:
  +--------------------------------+      claiming still needs the session to
                                          have been approved from the phone.
```

Losing the glasses costs a revocable token, nothing more.

---

## 9a. The device is the tenant

`owner_id` used to be minted fresh inside `start` for every pairing. That made a
second sign-in on the same glasses open a **brand-new tenant**: the wearer's
people, faces and notes were still in the table, keyed to an id nothing would
ever ask for again. The glasses now carry a `device_uid` — issued by the backend
on the very first pairing, kept across sign-outs — and `start` resolves it back
to the owner they already have.

```
   FIRST EVER SIGN-IN                    LATER SIGN-IN ON THE SAME GLASSES
   start {}                              start { device_uid }
     |                                     |
     | no uid sent -> mint one             | sha256 -> owner_for_device_uid()
     v                                     v
   INSERT owners(id)  <- a new tenant    found: reuse that owner_id
     |                                     |
     v                                     v
   device_uid returned ONCE               the wearer's people are all still there
   glasses store it forever

   REVOKED DEVICE (lost, sold)
   owner_for_device_uid() ignores revoked rows
     -> the same hardware pairs again into a FRESH tenant,
        which is exactly what revoking is for.
```

Everything now hangs off that tenant, so forgetting a wearer is one statement:

```
   owners (id)  <-- the tenant
     |
     +--< devices           (owner_id, device_uid_hash, token_hash, revoked)
     +--< pairing_sessions  (owner_id, device_uid_hash)
     +--< people            (owner_id) --< face_embeddings (person_id)
     +--< recent_captures   (owner_id)
                    all FK ... ON DELETE CASCADE

   select forget_owner('<owner>');   -- people, vectors, capture buffer,
                                     -- devices and pairings, in one go
```

> `device_uid` is a secret, exactly like the token: whoever holds it can start a
> pairing *into that tenant*. It never leaves the glasses except over TLS to the
> `pair` function, and only its sha256 is stored. It is also the reason a claim
> **rotates** the existing device row instead of inserting a second — a partial
> unique index (`where not revoked`) keeps one live row per physical device, so
> an old token cannot stay valid alongside a new one.

---

## 10. Where it can fail, and what the wearer sees

```
  start
    |
    +-- AUTH.projectUrl/apiKey unset --> card: "Sign-in is not configured."
    |
    +-- 5 user_code collisions --------> 503 "could not start a pairing, try again"

  the ?go link
    |
    +-- code unknown / claimed / expired -> 410 "That sign-in link has expired.
    |                                            Start again on your glasses."
    +-- no Composio auth config ---------> 503 "Sign-in is not configured on the server."
    +-- Composio link() failed ----------> 502 "Could not start Google sign-in."

  the ?done return
    |
    +-- session unmatched --------------> 410 "That sign-in could not be matched."
    +-- already claimed ----------------> 200 "Those glasses are already signed in."
    +-- Composio still not connected ---> 409 "Google is still finishing up..."
    |     (after 5 tries, 1.2s apart -- the redirect can outrun the grant)
    +-- ok -----------------------------> 200 "Signed in! ... press the temple."

  poll / claim
    |
    +-- session gone or past expiry ----> status 'expired' -> card: "That code expired."
    +-- not approved yet ---------------> stays 'pending'  -> card keeps waiting
    +-- transient network error --------> swallowed; the card does not flinch

  every phone-facing response above is text/plain -- the functions domain forces
  text/plain + nosniff on this host, so there is deliberately no HTML page to
  render. The only rich screen in the whole flow is Google's own consent.
```

---

## 11. The numbers

```
  pairing code TTL .............. 600 s   (TTL_SECONDS)
  poll interval ................... 3 s   (POLL_INTERVAL_SECONDS, server-advised)
  request deadline ............... 15 s   (AUTH.timeoutMs, client-side race)
  device_code ................. 24 bytes  hex, crypto.getRandomValues
  device token ................ 32 bytes  hex, returned once, stored hashed
  user_code ................... word-word-NN from a 52-word list  (~2.7e5 combos)
  confirm_word ................ word-word from the same list      (~2.7e3 combos)
  Composio settle retries ......... 5 x 1.2 s after the OAuth redirect
  expired-session sweep ........... every 10 min via pg_cron, if available
```

---

## 12. Source map

```
  pages/signin/signin.ink        the card, its five states, polling, the press
  utils/authservice.js           start / poll / claim / check over fetch+JSON
  utils/gate.js                  requireSignin -- the no-token redirect
  utils/planner.js               fold / stripKavi, then signinCommand,
                                 statusCommand, syncCommand, connectionCommand,
                                 faceCommand -- the whole "Kavi ..." router (§7)
  config.js  (AUTH)              projectUrl, apiKey, tokenKey, pendingKey,
                                 required, devToken
  supabase/functions/pair/index.ts
                                 GET  ?go / ?done   (phone side)
                                 POST start / poll / claim / approve / check
  supabase/migrations/20260803100000_device_auth.sql
                                 pairing_sessions, devices,
                                 owner_from_device_token(), purge_expired_pairings()
  supabase/migrations/20260807000000_device_tenancy.sql
                                 owners (the tenant), FK+CASCADE from every
                                 memory table, devices.device_uid_hash,
                                 owner_for_device_uid(), forget_owner()   (§9a)
  supabase/config.toml           verify_jwt = false, declared per function so a
                                 fresh deploy serves the phone link at all
```

---

*Companions: [10](10-aiui-on-glasses-flow.md) is the everyday runtime flow after
sign-in; [11](11-aiui-on-glasses-login-flow.md) is the same login told
picture-first with screenshots from the real runtime;
[14](14-connections-architecture.md) covers what the wearer authorizes on top of
this identity; [16](16-connections-hub-plan.md) is the hub-link variant in §3.*
