/**
 * SNOWFLOW — entry point.
 *
 * WebGL2 only, by design (this build; the original was WebGPU-only). Three.js
 * is a rasterizer here — no feature-detect branches: if the context or the
 * float render targets aren't there we say so once and stop.
 *
 * The boot itself lives in `mainInit.js`; this file is the module the page
 * loads and the last line of defence that turns a failed boot into a message
 * on the loading screen rather than a blank canvas.
 */

import * as loading from "./core/loading.js";
import { boot } from "./mainInit.js";

boot().catch((err) => {
 console.error(err);
 loading.fail("Startup failed — see console.");
});
