# VinylField 0.15.1 — Sleeve Edition + bilingual lyrics

Base: `vinylfield-apk-build` / `a19589e` (2026-10-10 22:01 Asia/Shanghai), packaged version 0.15.0.

Refines the album-derived listening room with serif titles, clearer lyric hierarchy, restrained record lighting, coordinated paper panels, 44px menu targets and short-screen gesture hints. Adds timestamp-aligned platform Chinese translations under original lyrics, with readable subtitles, shared line navigation and an explicit missing-translation state. Native Java, cloud routing, Album Identity and Pressing Studio remain unchanged.

The source ZIP preserves the existing CI format. `changes-0.15.1.patch` provides a readable source diff and can be applied in an extracted 0.15.0 project with `git apply`.

Verified: debug APK build; every packaged UI asset matches tested source; original WAV interaction and record gestures on four theme/viewport combinations; 100-track queues on three sizes; playback-clock suite; 7 translation alignment tests; controlled native/network bilingual display on 1280x720, 850x393 and 390x844. Independent review findings on subtitle matching and touch/readability were repaired and rechecked.

Not verified: live NetEase account/translation availability, physical Android fonts, GPU performance, soft keyboard and Bluetooth controls. Screenshots use local demo content or synthetic translation fixtures. This is a debug build, not a production-signed release.
