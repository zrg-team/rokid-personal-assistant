# How an AIUI agent runs on the glasses

*Companion to [doc 09](09-aiui-agent-flow.md). Doc 09 is how you build the agent. This shows what actually happens on the glasses, as pictures.*

## The whole thing in one picture

```
        the wearer asks something
                  |
                  v
      +-----------------------------+
      |   the glasses' assistant     |
      |  reads what each screen does |
      +-----------------------------+
                  |   picks the screen that fits
                  v
      +-----------------------------+
      |      your answer screen      |
      |   opens with the details     |
      +-----------------------------+
                  |   asks a server for the answer
                  v
      +-----------------------------+
      |   green card  +  spoken line |
      +-----------------------------+
                  |   wearer looks away
                  v
            the card sleeps
```

There is no home screen. Nothing shows until the wearer asks for something.

## What is on the glasses, and what is not

The glasses are the eyes, ears, and screen. The heavy thinking happens on servers.

```
      ON THE GLASSES                       OUT ON SERVERS
   +------------------+                 +---------------------+
   |  show the card   | ---- ask -----> |  Composio           |
   |  take a photo    |                 |   (your calendar)   |
   |  listen / speak  | <-- answer ---- |  Supabase           |
   |  remember a bit  |                 |   (face matching)   |
   +------------------+                 +---------------------+
```

## What the card looks like

A small card, one shade of green on black (that is all the display shows).

```
  +-------------------------------------+
  |  Tue  Jul 28                     4  |   <- day + how many events
  | ----------------------------------- |
  |  09:30   Standup                    |
  |  12:00   Lunch with Tracy           |
  |  14:00   Design review              |
  |  17:40   1:1 with Kevin             |
  +-------------------------------------+
        speaks: "You have 4 events today."
```

## Simulation 1 - "What's on my calendar today"

The wearer says it. The card shows the last one it had, instantly, then quietly refreshes.

```
  step 1  - opens, shows the cached day     step 2  - fresh events arrive
  +---------------------------+             +---------------------------+
  |  Tue  Jul 28          ... |             |  Tue  Jul 28           4  |
  | ------------------------- |    --->     | ------------------------- |
  |  (last calendar you saw)  |             |  09:30  Standup           |
  |                           |             |  12:00  Lunch with Tracy  |
  +---------------------------+             +---------------------------+
                                             speaks: "You have 4 events today."
```

No Google login happens on the glasses. Composio already holds it.

## Simulation 2 - "Who is this?"  then  "Remember her as Tracy"

```
  step 1                          step 2                          step 3
  wearer: "who is this"           the match comes back            wearer: "remember her as Tracy"
  +---------------------+         +---------------------+         +---------------------+
  |  Who is this        |         |  New face      [::] |         |  Tracy Lam     [::] |
  | ------------------- |  --->   | ------------------- |  --->   | ------------------- |
  |  Looking...         |         |  Say a name to      |         |  First view stored  |
  |                     |         |  remember them      |         |                     |
  +---------------------+         +---------------------+         +---------------------+
   takes a photo,                  shows a tiny                    saved under the name
   sends it to be matched          thumbnail  [::]                 speaks: "I will remember Tracy."
```

The trick in step 3: that is a brand-new screen, nothing was kept from step 2. But the server quietly held that last face for about **five minutes**, so the name just attaches to it. That is why the wearer never has to photograph the person twice.

(There is a short wait the very first time, because the face server takes a few seconds to warm up. That is why the screen starts warming it up the moment it opens, while the wearer is still aiming.)

## How the wearer starts a turn

```
  Usually:  wearer speaks  -->  assistant picks the right screen  -->  answer

  Directly: say "Kavi"      -->  mic opens
            touch the temple -->  mic opens   (ask again without the wake word)
```

You never build menus or buttons. Each screen just describes what it answers, and the assistant matches the question to it.

## What is real so far

```
  works today                                    not tried on real glasses yet
  ------------------------------------------     --------------------------------
  [x] screens draw (on the real runtime)         [ ] the real camera
  [x] calendar answer (live Composio)            [ ] the wake word
  [x] face matching (live, on test photos)       [ ] speaking out loud
                                                  [ ] the temple touch
                                                  [ ] the on-device AI
```

So the screens, the calendar, and the face matching all work. The parts that only exist on the physical glasses have not been confirmed on hardware yet. Read the pictures above as how it is *meant* to work, with those input pieces still to be tried on the device.

## A few real-world notes

```
  network   some Rokid models reach the internet through a paired phone,
            not directly. This agent assumes a direct link.

  privacy   camera and mic should switch on from a clear action,
            show they are on, and be easy to stop.

  bad wifi  the card keeps the last good answer with a quiet note,
            instead of showing an error.

  updates   publish a new version and the glasses quietly pick it up.
```

---

*Developer side - how these screens are built and packaged: [doc 09](09-aiui-agent-flow.md).*
