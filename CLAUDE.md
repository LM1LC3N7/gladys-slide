# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It bridges Slide curtain motors through their local HTTP API (logic ported
from goslide-api, Apache-2.0).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "STOP"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png (800×534) in plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/app.js                        SlideApp: lifecycle, reads, commands, badges, status, test
src/slide/client.js               GetInfo, SetPos, Stop, Calibrate; API v1 Digest / v2
src/slide/digest.js               the Digest challenge (bounded, linear) and its answer
src/slide/http.js                 one POST on node:http: deadline, size cap, beforeSend
src/slide/errors.js               errors by kind, `sent` / `answered`
src/lane.js                       one request at a time per Slide, moves before reads
src/devices.js                    answers -> Gladys devices, identity, ids (pure)
src/publisher.js                  states within 300/min
src/store.js                      /data/slide-state.json: pauses, blocks, identities, last read
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       texts in English and French
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
scripts/cover.mjs                 generates cover.png
test/                             node --test, against the SDK's fake Gladys, fake Slides
                                  and a simulated Slide on 127.0.0.1 (never the network)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Safety rules of this integration

- A Slide is a `curtain`, never `switch`/`binary`.
- STOP is never blocked: no lane, no identity read, through a pause or a block
  (one try), before the first read (identity kept in /data); it cancels the
  moves not sent yet. Never put it behind anything.
- A move or a calibration is decided on the identity read just before it (a
  DHCP lease may give the address to another Slide); an identity that cannot
  be read refuses the move but is never "another Slide". Calibration only with
  `allow_calibration`, read again right before the request leaves.
- Sent within 3.5 s or refused; a request that may have left is never told
  "not sent"; never retried by the integration; the ack never waits for a
  publication to Gladys. A position is confirmed only by a read equal to it.
- The device codes never reach a log, /data, a status nor an error. A refused
  code is final (salted fingerprint of the REFUSED code only): never retried
  by itself, lifted by another code or a success of the Test button.
- Never read sooner than the interval except the reads after a command; the
  last read time is written to /data before the reads (at most once a minute).
  A reconnection to Gladys (`connected`) clears no pause nor block and reads
  nothing.
- Answers are bounded (16 KB, the challenge 1 KB), parsed linearly and copied
  key by key; ids from the network are only Map keys.

## Rules

- **External ids are forever.** Built with `gladys.externalIds('slide', mac)`:
  the MAC address of GetInfo, else the digits of `slide_id`; never a name nor
  an address. Gladys keys devices, their history, scenes and dashboards on
  them. The same goes for every key users store: manifest `config_schema`,
  `actions`, feature keys.
- **A device published again never loses a feature** (`app.publishDevices`
  merges the features of `gladys.devices`).
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree (never a pinned value).
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language. Gladys
  does not encrypt its configuration: never write that it does.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network. No Bluetooth.
