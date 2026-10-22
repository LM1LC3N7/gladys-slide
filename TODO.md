# TODO — Slide curtains v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test` (Node
  22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session (one
  post per wave in /t/10385).

## Status

- [x] **Milestone 1 — core** (2026-10-22): local API client (GetInfo, SetPos,
      Stop, Calibrate; API v2 and v1 Digest), up to 8 Slides, one curtain each
      (open, close, stop, position, calibration behind an option), identity
      check before each move, STOP outside the lane, follow-up reads, position
      confirmation, refused code final, 429/5xx pause, last read time and
      identities in /data, Test button, en/fr, docs, cover. Tested against
      simulated Slides only.
- [ ] **Milestone 2 — real Slide**: run against a real Slide (API v1 and v2)
      and compare with the Slide app (see "To check"); turn the answers
      (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: Touch&Go as a read-only state (its change is a
      configuration of the Slide: never a switch), an "invert position" option
      if a real Slide needs it, the calibration time as a parameter.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real Slide

- The answer of SetPos, Stop and Calibrate (goslide-api expects a non-empty
  JSON; any 2xx is taken as accepted here).
- Whether GetInfo always gives `mac`, and its format (`slide_id` is the
  fallback of the identity rule).
- `pos` during a move and at the ends (a hair outside 0..1 is clamped; far
  outside is taken as unknown); whether 0 is open on every curtain setup
  (`slide_setup` middle/left/right).
- The time a Slide takes to answer (2 s per read here, the Digest exchange
  included), and how long a full travel takes (follow-up reads at 2, 8, 20,
  45 s).
- The Digest challenge of API v1 (realm, qop, opaque) and whether a Slide on
  API v1 answers several connections at once (a STOP goes on its own
  connection while a read may run).
- That the local API must be turned on in the Slide app, and where.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-slide:0.1.0`):
  the first patch release gives 0.1.1.
- **goslide-api (Apache-2.0)** is ported, not run (Python): `GoSlideLocal`
  only. Its cloud API (`api.goslide.io`, marked deprecated in its README) is
  not ported: local only, `transports: ["local"]`. Credited in
  THIRD_PARTY_NOTICES.md, copied into the image.
- **Curtain, not shutter**: a Slide moves a curtain on a rail; the core's
  `curtain` category has the same `state`/`position` types as `shutter`, and
  voice assistants treat it as a curtain. Never `switch`/`binary`. No unit
  (the core lists none for `curtain`).
- **Position**: Gladys 100 = open = Slide `pos` 0; Gladys 0 = closed = `pos` 1;
  commands rounded to 2 decimals.
- **Identity rule** (frozen: it fixes the external ids): the MAC address of
  GetInfo, lower case without separators; else the 12 digits of `slide_id`;
  neither: the Slide is not published ("identity cannot be read"), and read
  again at the next interval. `ext:<selector>:slide:<mac>`.
- **Addresses and codes**: one text field of addresses (8 at most) and one
  secret field of codes in the same order (an empty place for API v2). A
  config save that changes neither restarts nothing and reads nothing.
- **API version found by itself**: every call goes first without
  authentication; 200 = API v2; 401 with a Digest challenge = API v1 (nothing
  done), answered with the code within the same deadline. A 401 without a
  usable challenge is "not a Slide". Two requests per call on API v1, as
  goslide-api (a fresh nonce each time, nc 00000001).
- **Refused code**: final (lesson of lot 12): never retried by itself; kept in
  /data with the salted fingerprint of the refused code only; lifted by
  another code (even typed while stopped) or a success of the Test button
  (which tries once, never sooner than the interval). A missing code on API v1
  is the same block. A 401 on a command never blocks (the reads decide).
- **Calibration** is not in the list of sensitive commands, but it moves the
  curtain over its whole travel unasked: behind `allow_calibration` (off by
  default), checked on arrival, after the identity read and in beforeSend.
- **Open and close are plain moves** (a curtain): no option. **STOP is the
  protective command**: outside the lane, no identity read (stopping another
  Slide after a DHCP swap is harmless), through a pause or a block (one try),
  cancels the moves not sent yet; a move whose first byte left before the
  STOP arrived is followed by a second STOP once it is answered.
- **Identity read before each move or calibration** (GetInfo, at most 2 s,
  leaving 300 ms for the request); a read of another MAC refuses and updates
  the address of both Slides; an unreadable identity refuses the move (nothing
  sent) but changes nothing.
- **Confirmation**: a 2xx to SetPos is "accepted" (the ack says success); the
  position is confirmed only by a read within 2 % of it; after the last
  follow-up read (45 s) a position not reached shows on the badge until the
  curtain moves or a new command. A request that may have left without an
  answer: "sent, without confirmation", badge degraded until confirmed.
- **One lane per Slide** (one request at a time, moves before reads; reads
  hold it 2 s at most); Slides are read side by side.
- **Reads**: the last read time is written to /data before the reads, at most
  once a minute; after a restart the next read waits that minute more.
  Follow-up reads after a command are the only reads sooner than the interval
  (never during a pause or a block).
- **Pauses** (429, 5xx) per Slide, 1 min to 6 h (Retry-After honoured within
  the bounds), never shorter than the interval; STOP still goes through.
- **No Touch&Go switch in v1**: it changes the configuration of the Slide.
