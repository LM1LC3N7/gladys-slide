# Slide curtains

This integration connects Gladys to **your Slide curtain motors** (Innovation in
Motion) through their **local API**. Each Slide becomes a **curtain** in the
**Discovery** tab of Gladys: open, close, stop, position, and a calibration
button. Everything stays on your local network: the cloud of Slide is not used.
Unofficial, not affiliated with Innovation in Motion.

> **Development version (0.1).** Written from the local API published by the
> maker and the goslide-api library, and tested against simulated Slides only:
> it has **never been tested with a real Slide** yet. Your feedback is welcome
> on the GitHub repository.

## What you get

| Feature      | In Gladys                                                                  |
| ------------ | -------------------------------------------------------------------------- |
| Open / close | open, close, **stop** the curtain                                          |
| Position     | 0 % = closed, 100 % = open; read at the interval you choose, and commanded |
| Calibrate    | a button that starts the calibration, **off by default** (see Options)     |

A Slide is **never** a switch: a "turn everything off" scene does not close
it. It is a "curtain": a "close the curtains" of a scene, Google, Alexa,
HomeKit or an assistant (MCP) closes it, as expected.

## Requirements

- One or more Slides on the same local network as Gladys, with their **local
  API turned on** in the Slide app.
- The IP address of each Slide, preferably fixed (reserved in your router).
- For a Slide on an older firmware (**API v1**): its 8-character **device
  code**, printed on the Slide. Recent Slides (**API v2**) have no password:
  anyone on your network can use them, with or without Gladys. Keep them on a
  trusted network.

## Installation

1. In Gladys, open the **Slide curtains** integration, **Configuration** tab.
2. Type the **addresses** of your Slides, separated by commas (8 at most), like
   `192.168.1.40, 192.168.1.41`.
3. Only for Slides on API v1: type their **codes**, in the **same order** as
   the addresses, separated by commas; leave the place empty for a Slide on API
   v2. For example, with the addresses above and only the second Slide on API
   v1: `,ABCD1234`. This field is kept by Gladys in its database, never shown
   again, and the code is only sent to that Slide on your network.
4. Save, then press **Test the connection**: the state of each Slide is shown.
5. Open the **Discovery** tab and add your Slides.

## Options

- **Read interval** (30 s by default, 10 to 3600 s): how often the position of
  each Slide is read. After a command, the Slide is also read a few times while
  the curtain moves (2, 8, 20 and 45 s).
- **Allow calibration** (off by default): the "Calibrate" button runs the
  curtain from one end to the other to learn its travel again. While the option
  is off, the button is refused; it is read again right before sending.
- **Language of the feature names**: French or English.

## How the commands are sent

- **Open, close, a position, calibrate**: Gladys first reads the identity (MAC
  address) of the Slide at that address. If another Slide answers there (an
  address given to another one by your router), the command is refused and
  nothing is sent. The command leaves within 3.5 s, or it is refused.
- **Stop** always leaves at once: without waiting, even during a pause asked by
  the Slide, and even right after a restart of the integration. It cancels the
  moves of that Slide not sent yet.
- A command that may have left without a clear answer is reported "sent,
  without confirmation", and the Slide is read again; never sent again by
  itself.
- A position is **confirmed** only by a read equal to the position asked. If
  the curtain does not reach it (an obstacle, a hand on the curtain), the badge
  of the Slide turns orange.

## Security and privacy

- Gladys only talks to the addresses typed, in plain HTTP on your local
  network; redirects are never followed, no cloud is used.
- The device codes are never written to the logs, to `/data` nor to a message.
  A refused code stops that Slide for good: Gladys never tries it again by
  itself. Fix the code then save, or press **Test the connection** for one new
  try.
- A "429" or a server error of a Slide pauses it (1 minute to 6 hours), and the
  pause outlives a restart. After a failure, Gladys never asks a Slide more
  often than the read interval.

## Troubleshooting

- **"Unreachable"**: check the IP address (no `.local` name, the container does
  not resolve them), the Wi-Fi of the Slide, and that its local API is on.
- **"Asks for its device code"**: this Slide is on API v1; type its code at the
  same place in the list as its address.
- **"Not found at the addresses typed"**: the address of a Slide changed; type
  the new one, its device and history are kept.
- **Position reversed**: tell us on the GitHub repository.

## Credits

Logic ported from [goslide-api](https://github.com/ualex73/goslide-api)
(Apache-2.0), the library of the Slide integration of Home Assistant. Slide is
a trademark of Innovation in Motion; this project is not affiliated with
Innovation in Motion.
