# Third-party notices

This integration ports to JavaScript the knowledge of the local API of the
Slide curtain motors held by the following project: the paths of the API
(`/rpc/Slide.GetInfo`, `Slide.SetPos`, `Slide.Stop`, `Slide.Calibrate`), the
`pos` value (0 open, 1 closed), the fields of GetInfo, and the API v1 HTTP
Digest authentication (user `user`, the device code as password, MD5 with qop
`auth`, the unauthenticated first request that also detects API v2). No file is
copied, and nothing of it is installed at runtime. It is distributed under the
Apache License, Version 2.0, the same licence as this repository, whose full
text is in the `LICENSE` file (copied into the image); its repository holds no
NOTICE file.

## goslide-api

<https://github.com/ualex73/goslide-api> (main branch, commit 5dac98b of
2025-11-23; `setup.py` 0.7.3), by Alexander Kuiper (author named in its
`setup.py`), the library of the Slide integration of Home Assistant. Its
`LICENSE` file is the Apache License 2.0 text, whose appendix keeps the
placeholders as they are:

```
Copyright [yyyy] [name of copyright owner]

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

Changes: the logic was rewritten in JavaScript for Node.js (`src/slide/`), with
bounded answers, a single deadline per call, and the device code never logged.
The cloud API of the library (deprecated) is not ported.

## LM1LC3N7/gladys-warema and gladys-ismartgate

`src/publisher.js` (from gladys-warema), `src/slide/http.js` (adapted from
gladys-ismartgate) and the structure of `src/app.js`, `src/config.js` and
`src/store.js` (after gladys-ismartgate) come from integrations of the same
author, under the Apache License 2.0 of this repository (the `LICENSE` file).
