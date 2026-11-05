# Sony XQZ-IV01 Vlog Monitor — protocol notes

Reverse-engineering notes for the **Sony XQZ-IV01 Vlog Monitor** (sold for Xperia
PRO-I / 1 IV / 5 IV / 1 V / 5 V / 1 VI), based on the decompiled Sony camera apps
and on-hardware USB/DisplayPort tests.

## Summary

The monitor combines three independent functions over one USB-C cable:

1. **DisplayPort Alt-Mode sink** — 3.5″, 1280×720@60. The phone renders the camera
   preview into an Android `Presentation` on it.
2. **Vendor USB control device `054c:0e48`** — bulk ASCII protocol: `show` enables
   the DP sink/panel, `stop` disables it, `flip` reports the FLIP button.
3. **USB Audio Class codec `054c:0e49`** (VIA Labs) — 48 kHz/16-bit stereo mic
   input; only enumerates when `show` is active **and** a mic is plugged.

No video or PCM goes over the `0e48` bulk channel.

## Video path

The apps use the normal Android external-display API; there is no encoder,
`MediaCodec`, `MediaProjection`, or `VirtualDisplay` for the monitor.

```
Camera HAL -> SurfaceTexture (GL_TEXTURE_EXTERNAL_OES) -> GLSurfaceView
  -> Presentation window on the DP display -> SurfaceFlinger
  -> USB-C DisplayPort Alt Mode -> LCD
```

Key classes:

| Area | Class |
|---|---|
| Display selection / Presentation | `view/fragment/ExternalDisplayFragment`, `PresentationFragment` |
| Preview rendering / flip | `view/widget/ExternalDisplaySurfaceView` |
| Camera surface switch | `view/FragmentController#switchSurfaceForExternalDisplay` |
| Overlay (REC, battery, audio level) | `view/fragment/ExternalDisplayUiFragment` |

The app hides the phone viewfinder while the external display is active; the
camera preview is redirected to the monitor's surface.

### `show` gates the DP link

The monitor is **invisible to the host until `show` is sent**. `show` keeps the
sink alive for **1.000 s**; the app repeats it every **400 ms**.

Measured with one `show` and no repeat:

| t | Event |
|---|---|
| 0.000 s | `show` written; `disp_on` received |
| 0.345 s | `card1-DP-1` becomes `connected`, 1280×720 |
| 1.000 s | `disp_off` received (watchdog expired) |
| 1.143 s | `card1-DP-1` becomes `disconnected` (HPD low) |

`stop` produces `disp_off` and drops the link immediately. Consequently
`DisplayManager.getDisplays(DISPLAY_CATEGORY_PRESENTATION)` is empty until the
heartbeat runs — which is why the monitor only works with apps that know to send
`show`.

EDID (128 bytes, read while connected): EDID 1.3, manufacturer **NXP**, product
`0x3460`, preferred timing **1280×720@60** (74.25 MHz), strings `SONY Xperia` /
`Moni Extende `.

## USB control protocol (`054c:0e48`)

* Full-speed USB 2.0, one vendor-specific interface (`0xff/0x01/0x01`),
  bulk OUT `0x02` + bulk IN `0x81`, 16-byte max packets. No HID/audio/interrupt
  endpoint. Device is bus-powered (100 mA).
* The apps claim interface 0 directly; the device appears behind the monitor's
  internal TI TUSB2036 hub (port 1).

Commands are raw ASCII, no terminator:

| Direction | Message | Meaning |
|---|---|---|
| phone → monitor | `show` | enable DP sink/panel; refresh at least once per second |
| phone → monitor | `stop` | disable DP sink/panel |
| monitor → phone | `disp_on` / `disp_off` | state/ACK for `show` / `stop` (apps ignore) |
| monitor → phone | `flip` | FLIP button pressed |

The app sends `show` immediately on USB connect and every 400 ms while running;
`stop` on pause/disconnect. RX is decoded as UTF-8 and split on `\r` (the real
device sends bare 4–5 byte strings), then handled by
`subdisplay/UsbConnectionManager` / `UsbResponseListener`.

On `flip`, the app advances `CommonSettings.DISP_FLIP` (ORIGINAL / HORIZONTAL /
VERTICAL / HV) and mirrors/rotates the GL preview and overlay.

### Monitor-local controls

The ON/OFF switch and brightness button are local hardware. Brightness cycles
High → Boost → Low → Mid; there is no brightness command in the APKs. Only FLIP
is reported over USB.

## Audio path (`054c:0e49`)

With `show` active and a 3.5 mm mic plugged into the monitor, a second USB device
enumerates behind the internal hub (port 2):

| Field | Value |
|---|---|
| VID:PID | `054c:0e49` |
| Manufacturer / product | **VIA Labs, Inc.** / `XQZ-IV01` |
| Interfaces | 0 Audio Control, 2 Audio Streaming, 3 HID |
| Format | 2 ch, S16_LE, **48 kHz**, 16-bit |
| Audio endpoint | isochronous IN `0x8a`, 196-byte packets |
| HID endpoint | interrupt IN `0x82` |

ALSA exposes it as card `XQZIV01`; normal capture works
(`arecord -D plughw:CARD=XQZIV01,DEV=0 -c 2 -r 48000 -f S16_LE`).

Gating (measured):

| `show` | mic plugged | `0e49` present |
|---|---|---|
| off | off | no |
| off | on | no |
| on | off | no |
| on | on | **yes** |

The app accepts external mics of `AudioDeviceInfo` type 3/11/22; the `0e49`
UAC device matches the USB types (11/22). It then switches the audio source to
**`UNPROCESSED` (9)**, selects the device with
`AudioRecord`/`MediaRecorder.setPreferredDevice()`, and sends
`AudioManager.setParameters("somc_selfie_accessary=true")` to Sony's audio HAL.
The mic is digitized by this codec; no PCM travels on the `0e48` channel.

## Compatibility gate

Stock apps enable the feature only when:

1. the USB device is `054c:0e48`;
2. exactly one `DISPLAY_CATEGORY_PRESENTATION` display exists;
3. `mIsSelfieAccessorySupported` is true. This is derived from Sony's camera HAL
   capability `SONYMOBILE_CONTROL_SENSITIVITY_LIMIT`
   (`util/capability/PlatformCapability.java`).

The community “Xperia 1 VIII Vlog Monitor” mod simply forces that flag true; the
VID/PID check is unchanged. There is no security chip or cryptographic handshake.

## Working third-party enabler

`spike/` contains a small release-signed Android app (**XQZ Enabler 1.1**).
Version 1.0 was confirmed on a **Galaxy S23** and a **Sony Xperia 1 V**; 1.1
changes the reconnect/retry/UI paths and has not yet been re-tested on hardware.

- requests USB permission for `054c:0e48`;
- sends `show` every 400 ms from a foreground service;
- handles USB attach so a replug can reconnect when the app is the default
  handler (“Always open XQZ Enabler”); otherwise pick the app in the USB
  chooser or tap Start;
- retries transient USB failures with capped backoff;
- provides a Quick Settings tile with running/waiting state;
- lets the phone OS mirror the screen (including the Camera app) to the monitor.

With DeX auto-start off, the S23 treats the monitor as a normal 1280×720 secondary
display and mirrors the screen. On the Xperia 1 V, Android mirrors the screen
directly. No MediaProjection or Sony code is used.
APK: `spike/XQZEnabler.apk`; instructions in `spike/README.md`.

Caveat: this relies on the phone OS mirroring the screen to the external display.
Other Android vendors may show a desktop mode or need a MediaProjection fallback.

## Reimplementation blueprint

1. Open `054c:0e48`, claim interface 0, find the bulk IN/OUT pair, request USB
   permission.
2. Start the heartbeat **before** waiting for the display: send `show` every
   400 ms. Then wait for a single `DISPLAY_CATEGORY_PRESENTATION` display
   (~350 ms after the first `show`).
3. Create a `Presentation` on it and render the camera preview (GLSurfaceView +
   `SurfaceTexture`, or hand the surface to Camera2). Mirror/rotate as needed.
4. Read the bulk IN asynchronously; on `flip`, rotate/mirror the preview.
5. For audio, keep `show` active with a mic plugged; let Android enumerate the
   `0e49` UAC device, select it as the preferred input, and use `UNPROCESSED`.
6. On teardown send `stop` and expect `disp_off` plus display removal.

`tools/xqz_probe.py` (Python/pyusb, Linux/Android) and `tools/xqz_probe` (C#,
Windows) implement the control channel (descriptor dump, heartbeat, `flip`
printing, optional duration). They only touch `0e48`; audio is the separate
`0e49` device. On Windows, bind `0e48` to WinUSB (e.g. with Zadig) first. The
`Build xqz_probe` workflow publishes NativeAOT `xqz_probe.exe` artifacts for
`win-x64` and `win-arm64`; to build locally run
`dotnet publish tools/xqz_probe/XqzProbe.csproj -c Release -r win-x64` (.NET 10 SDK).

`tools/xqz_probe_usbip.mjs` (Node.js 18+, no dependencies) does the same on
Windows without Zadig: it is a user-space USB/IP client that talks to
[usbipd-win](https://github.com/dorssel/usbipd-win) on TCP port 3240 (no WSL
involved). Share the device once from an elevated prompt (`usbipd list`, then
`usbipd bind --busid <BUSID>`); while the script runs usbipd-win captures the
device, and releases it back to Windows on exit. `--list` shows the devices
usbipd-win exports; `--host`/`--port`/`--busid` override discovery. Tests run
against a mock usbipd server: `node --test tools/xqz_probe_usbip.test.mjs`.

## Hardware verification

```sh
# Control device
lsusb -d 054c:0e48 -v

# Keep the DP link alive (sends show every 400 ms)
sudo python3 -u tools/xqz_probe.py --duration 30
# or on Windows, with the device bound to WinUSB:
# xqz_probe.exe --duration 30
# or on Windows via usbipd-win (after `usbipd bind --busid <BUSID>`):
# node tools\xqz_probe_usbip.mjs --duration 30

# While that runs:
cat /sys/class/drm/card*-DP-*/status
sudo cat /sys/class/drm/card1-DP-1/edid > /tmp/dp1.bin && edid-decode /tmp/dp1.bin

# Audio (requires show running AND a mic plugged)
lsusb -d 054c:0e49 -v
arecord -D plughw:CARD=XQZIV01,DEV=0 -c 2 -r 48000 -f S16_LE -d 2 /tmp/mic.wav
```

## Tested against

| App | Package | Version | SHA-256 |
|---|---|---|---|
| Videography Pro | `jp.co.sony.mc.videopro` | 1.4.2.A.0.5 | `ab6d3887805b54b80869c2f5ebfe54ff37c49e6b79cf2a776a9e113b07f423db` |
| Photography Pro | `com.sonymobile.photopro` | 1.7.2.A.0.9 | `b4ea03d5355f40f8644db8b0fc62a642025c0cb3da7070446256db9cfd8274c6` |

The APKs, decompiled sources, and kernel/device-tree checkouts are local analysis
artifacts and are not committed (proprietary and/or large).

## Legal

The APKs are Sony proprietary software. This work was done locally for
interoperability; no Sony code or binaries are redistributed. Reverse engineering
for interoperability is generally permitted (e.g. EU Software Directive Art. 6,
US DMCA §1201(f)); check your jurisdiction.
