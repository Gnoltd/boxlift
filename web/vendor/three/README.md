# three.js (vendored) — THIRD_PARTY

| File | Source | Licence |
|---|---|---|
| `three.module.min.js`, `three.core.min.js` | npm `three@0.185.1`, `build/` (ES module build; `three.module.min.js` imports `./three.core.min.js`) | MIT, © 2010-2026 three.js authors (`LICENSE`) |
| `OrbitControls.js` | npm `three@0.185.1`, `examples/jsm/controls/OrbitControls.js` (imports the bare specifier `three`, mapped by the import map in `web/index.html`) | MIT, same |

Used only by the web demo's 3D point-cloud screen (`web/viewer/`). Copied unchanged, served from the demo's own origin (no CDN at runtime).
Homepage: https://threejs.org · https://github.com/mrdoob/three.js

Update: `npm pack three@<version>`, copy the same four files, update the version here and in `tests/web_build.test.js` if needed.

SHA-256 (0.185.1):

```
86bcee248b64f44bcfc23c331ae74619061957d59cab040171dcb6fb5900beb6  three.module.min.js
05b2609338c76cd65daf74f3ac515bc9a5045e1b3b33edc07d8c9bd55250fa90  three.core.min.js
faabb4e8dfd9235ee4a9fd7c9a3d75f90f1689dbd4944bd6fd32117dacec5f93  OrbitControls.js
8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc  LICENSE
```
