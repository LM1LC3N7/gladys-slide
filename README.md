# gladys-slide

[Gladys Assistant](https://gladysassistant.com) external integration for
**Slide** curtain motors (Innovation in Motion): each Slide becomes a Gladys
curtain of the Discovery tab (open, close, stop, position, calibration).
Gladys reads their position and controls them through the local API of the
Slide, on the local network only (plain HTTP; API v2 without a password, API v1
with the device code). The cloud of Slide is not used. Unofficial, not
affiliated with Innovation in Motion.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Development version.** Tested against simulated Slides only: it has
> never been tested with a real Slide yet. Feedback and bug reports are
> welcome in the [GitHub issues](https://github.com/LM1LC3N7/gladys-slide/issues).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SlideApp) ⇄ src/slide/client.js ⇄ POST http://<slide>/rpc/Slide.*
                                   ├─ src/lane.js       one request at a time per Slide, moves first
                                   ├─ src/devices.js    answers -> Gladys devices, ids (pure)
                                   ├─ src/publisher.js  states within 300/min
                                   └─ src/store.js      /data: pauses, refused codes, identities, last read
```

- **Protocol**: `POST /rpc/Slide.GetInfo` (identity, name, `pos` 0 open .. 1
  closed), `Slide.SetPos` (`{"pos": …}`), `Slide.Stop`, `Slide.Calibrate`. Every
  call goes first without authentication (API v2 answers it); a 401 with a
  Digest challenge (API v1, nothing done) is answered with the device code
  (user `user`, MD5, qop `auth`), within the same deadline.
- **Devices**: one `curtain` per Slide (`state` write-only, `position` 0 closed
  .. 100 open, a `button/push` calibration), never a `switch`. Identity rule
  (it fixes the external ids): the MAC address of GetInfo, else the digits of
  `slide_id`; `ext:<selector>:slide:<12 hex digits>`.
- **Commands**: a move or a calibration goes through the lane of its Slide,
  after a GetInfo that checks the identity at that address (DHCP); sent within
  3.5 s or refused; calibration behind `allow_calibration`, read again right
  before the request leaves. STOP goes at once, outside the lane, through a
  pause or a refused code (one try), works before the first read (identity kept
  in `/data`), cancels the moves not sent yet, and is sent again after a move
  that was leaving. "Sent, without confirmation" once a request may have left
  without an answer; a position is confirmed only by a read equal to it.
- **Reads**: every Slide at the configured interval (30 s by default), side by
  side, then 2, 8, 20 and 45 s after a command; never sooner than the interval
  otherwise (Test button, scan, reconnection, unchanged save, restart: the last
  read time is kept in `/data`, written at most once a minute and before the
  reads).
- **Failures**, per Slide: a code refused (or missing on API v1) is final and
  kept in `/data` with the salted fingerprint of the refused code (another code
  or a success of the Test button lifts it); a 429 or a 5xx pauses it (1 min to
  6 h, kept in `/data`); anything else retries after 30 s, 1, 2, 5 min, never
  sooner than the interval. A reconnection to Gladys publishes the status, the
  Discovery and the badges again, and reads nothing.

## Reused work

- [ualex73/goslide-api](https://github.com/ualex73/goslide-api) (Apache-2.0),
  the Python library of the Slide integration of Home Assistant: the local API
  (`GoSlideLocal`: paths, bodies, API v1 Digest authentication and the switch
  to v2) is **ported** to JavaScript (it cannot run in this Node container).
  Its deprecated cloud API is not used.
- [LM1LC3N7/gladys-warema](https://github.com/LM1LC3N7/gladys-warema) and
  [LM1LC3N7/gladys-ismartgate](https://github.com/LM1LC3N7/gladys-ismartgate),
  local bridges of the same author: the app structure, the HTTP layer, the
  state publisher, the store and the test helpers.

Notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), copied into the
image. The only runtime dependency is the Gladys SDK.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npm run cover                                   # cover.png, 800×534, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/helpers/fakeSlide.js` simulates Slides on API v1 and v2 behind the
`request` of the client for the app tests (mocked clock and timers);
`test/http.test.js` runs the real client against a simulated Slide on
127.0.0.1. See TODO.md, "To check on a real Slide".

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store.

## License

Apache-2.0 (see [LICENSE](LICENSE)); ported logic under Apache-2.0, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Slide is a trademark of
Innovation in Motion; this project is not affiliated with Innovation in Motion.
