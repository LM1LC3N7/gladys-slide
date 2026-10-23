# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- The second STOP sent after a move that was leaving is no longer sent when a
  move of that Slide was asked after the STOP (it would have stopped it).
- A move answered after a STOP no longer leaves a "position not reached" badge.
- A command refused because the configuration changed meanwhile says so,
  instead of "this Slide is not at any address".

## [0.1.1] - 2026-10-22

### Added

- Slide curtain motors over their local API (up to 8, by IP address): each
  Slide is a curtain of the Discovery tab, with open, close, stop and its
  position (read at a configurable interval, and after each command). Never a
  switch.
- API v2 (no password) and API v1 (HTTP Digest with the device code printed on
  the Slide), found by itself; the codes are typed as `address=code` pairs
  (matched by address, never by order), never logged nor kept in `/data`; an
  expired challenge (`stale`) or a 403 without a code is never taken as a
  refused code.
- Each Slide read at its own interval: changing the address or the code of one
  reads only that one at once; a cycle with nothing to read waits for the
  earliest end of a pause or next try, never loops; after a restart, a Slide
  read recently is shown connected until its first read.
- Only a recent position of a Slide that answers is published (never an old
  one dated anew).
- A calibration button, refused unless "Allow calibration" is on (read again
  right before the request leaves).
- Moves checked against the identity (MAC address) of the Slide at the address
  right before they leave; sent within 3.5 s or refused; "sent, without
  confirmation" once a request may have left; a position confirmed only by a
  read equal to it, the badge showing a position not reached.
- STOP at once, never behind another request, through a pause or a refused
  code, before the first read after a restart; it cancels the moves not sent
  yet, and is sent again after a move that was leaving.
- A refused device code stops that Slide for good (kept in `/data` as a salted
  fingerprint), until another code or a success of the Test button; a 429 or a
  5xx pauses it (1 minute to 6 hours, kept in `/data`); never read sooner than
  the interval, a restart included.
- A "Test the connection" button, English and French texts, the state of each
  Slide in the connection status.

[Unreleased]: https://github.com/LM1LC3N7/gladys-slide/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-slide/releases/tag/v0.1.1
