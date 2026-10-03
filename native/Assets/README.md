# macOS brand assets

The native app uses **Sovereign of Heavens and Code**: a serious, majestic
celestial sovereign inspired by Hoyoverse aesthetic (Genshin / Honkai), crowned
with glowing crystalline spires, rune-etched celestial code halo, and cosmic
starlight indigo mantle. The character's solemn gaze and divine crown anchor
**HEAV3NS-CODE** as an authoritative, elegant developer workspace.

This replaces the previous cloud/code, folder/conversation, and signal identities.
The dimensional Dock icon carries genuine alpha transparency and macOS continuous
corner radius with a subtle crown spire accent. In-app controls retain semantic AppKit
colors and SF Symbols; the identity does not override the user's accent color.

| Asset | Purpose |
| --- | --- |
| `AppIcon.icns` | Dock, Finder, app switcher, and system application identity |
| `AppIcon.iconset/` | Ten native representations: 16, 32, 128, 256, and 512 points, each at 1× and 2× |
| `AppIcon-Master.png` | Original 1024 × 1024 generated sovereign master, with alpha transparency |
| `AppIcon.svg` | Flat vector icon companion |
| `BrandMark.svg` / `BrandMark.png` | Standalone mark; PNG is 512 × 512 with transparency |
| `../Sources/Heav3nsCode/Resources/Brand/AppIcon.png` | 1024 × 1024 welcome and development-run icon |
| `../Sources/Heav3nsCode/Resources/Brand/BrandMarkTemplate.pdf` | Resolution-independent monochrome template for AppKit tinting |
| `Archive/Cloud-Code/` | Previous cloud/code master, vector companions, and provenance |
| `Archive/Signal/` | Prior signal artwork and wallpaper studies; not part of the active app identity |
| `Archive/Workspace-Conversation/` | Previous folder/conversation master, vector companions, and prompt |

The master is an original built-in `image_gen` output. The requested 1024 × 1024
image was returned at 1254 × 1254; native exports are resampled to their exact
required dimensions with alpha preserved. The flat companion is authored vector
geometry and has genuinely transparent code apertures. The archive's
two wallpapers remain at their original 1672 × 941 dimensions and are not bundled.

Full generation prompts and icon origin are in [`provenance.json`](provenance.json).
The PNGs also embed their prompt or origin under `impeccable:prompt`.

## Rebuild icons

From the repository root on macOS:

```sh
swift -module-cache-path build/swift-module-cache scripts/build-native-assets.swift
npm run desktop:build
```

The exporter resamples the saved master, draws the flat companions from shared
vector commands, exports the template PDF, and invokes Apple's `iconutil`. It
requires no graphics dependency or model API. It embeds origin metadata on every
PNG export, including regeneration. Changing the dimensional artwork requires
updating the master and its recorded generation prompt.

`Info.plist` points to `AppIcon.icns`. The desktop build copies the `.icns` and
SwiftPM resource bundle into `Contents/Resources` before signing. `BrandAssets`
loads the packaged bundle there and uses `Bundle.module` for SwiftPM runs/tests.
The welcome image is decorative for accessibility; the heading carries its text.

The `.icns` packaging supports the app's macOS 14 baseline. This is a conventional
static icon, not an Icon Composer layered Liquid Glass asset. See Apple's
[app icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons).
