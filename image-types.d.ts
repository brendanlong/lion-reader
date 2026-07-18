// Static-image module declarations (`import hero from "./foo.png"` →
// `StaticImageData`). These normally come from `next/image-types/global`, which
// Next wires into the generated, git-ignored `next-env.d.ts` only during a
// build. CI runs `tsc --noEmit` WITHOUT a build, so `*.png` imports (the demo
// article hero/OG images under src/app/(public)/demo/articles/images/) would
// otherwise fail with TS2307. Referencing the same Next types here — in a
// committed file — makes them resolve with or without a build.
/// <reference types="next/image-types/global" />
