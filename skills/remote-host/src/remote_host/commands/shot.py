"""Screenshots of a remote Mac, taken by the Snipaste already running there.

Why Snipaste and not `screencapture`: macOS grants Screen Recording to an app,
and a command started over ssh belongs to sshd — `screencapture` there fails
with "could not create image from display" (tested 2026-09-23). Snipaste's CLI
only messages the Snipaste running in the logged-in session, which holds the
permission from everyday use, so the capture happens inside that app. The Brewfile
installs it on every Mac.

`snip --full` captures the bounding box of all displays (three screens here:
11456x5120). `--screen N` crops one display out of it with `sips`, from the
display frames AppKit reports; when those cannot be read, the whole capture is
returned and remote-host says why. The image is shrunk to a JPEG on the host before it
travels — a full capture is several MB of PNG.
"""

import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

from agentkit.remote.ssh import SSH_OPTS, run_remote

from .core import host_of

SNIPASTE = os.environ.get("REMOTE_HOST_SNIPASTE", "/Applications/Snipaste.app/Contents/MacOS/Snipaste")
MARK = "__REMOTE_HOST_SHOT__="

#: Display frames in points, origin bottom-left, one "x,y,w,h,scale" per line.
SCREENS_JXA = (
    'ObjC.import("AppKit"); var s=$.NSScreen.screens, o=[]; '
    'for (var i=0;i<s.count;i++){var f=s.objectAtIndex(i).frame; '
    'o.push([f.origin.x,f.origin.y,f.size.width,f.size.height,s.objectAtIndex(i).backingScaleFactor].join(","))} '
    'o.join("\\n")'
)


def crop_box(frames, index):
    """Pixel box (top, left, height, width) of display `index` inside the
    full capture, or None. The capture is the union of all frames at one
    scale; with mixed scales the geometry is not known, so no crop."""
    if not 0 <= index < len(frames):
        return None
    scales = {f[4] for f in frames}
    if len(scales) != 1:
        return None
    scale = scales.pop()
    min_x = min(f[0] for f in frames)
    max_y = max(f[1] + f[3] for f in frames)
    x, y, w, h, _ = frames[index]
    return (round((max_y - (y + h)) * scale), round((x - min_x) * scale), round(h * scale), round(w * scale))


def shot_script(max_edge=2400, screen=None, png=False, snipaste=SNIPASTE):
    s = shlex.quote(snipaste)
    app = shlex.quote(snipaste.split("/Contents/MacOS/")[0]) if "/Contents/MacOS/" in snipaste else s
    script = (
        f"S={s}\n"
        f'[ -x "$S" ] || {{ echo "remote-host: Snipaste is not installed here (brew install --cask snipaste)" >&2; exit 127; }}\n'
        # By full path, not name: the running app is exactly this binary.
        'if ! pgrep -f -- "$S" >/dev/null; then\n'
        f"  open {app} 2>/dev/null\n"
        '  __i=0; until pgrep -f -- "$S" >/dev/null; do sleep 1; __i=$((__i+1)); '
        f'[ $__i -ge 15 ] && {{ echo "remote-host: Snipaste did not start (is anyone logged in?)" >&2; exit 1; }}; done; sleep 2\n'
        "fi\n"
        '__d="$HOME/.cache/remote-host/shots"; mkdir -p "$__d"; find "$__d" -type f -mmin +60 -delete 2>/dev/null\n'
        '__f="$__d/shot-$$.png"\n'
        # --block waits for the app to answer; a Snipaste that never got Screen
        # Recording never answers (alpha, first run, 2026-09-23), so the CLI is
        # bounded here instead of trusting it.
        '"$S" snip --full -o "$__f" --block 15 >/dev/null 2>&1 & __p=$!\n'
        '__i=0; until [ -s "$__f" ]; do sleep 0.5; __i=$((__i+1)); [ $__i -ge 40 ] && { '
        'kill $__p 2>/dev/null; '
        'echo "remote-host: Snipaste produced no image — nobody logged in, or Snipaste lacks Screen Recording '
        '(System Settings → Privacy & Security → Screen & System Audio Recording; grant it, then run this again)" >&2; exit 1; }; done\n'
        'sleep 0.3; kill $__p 2>/dev/null\n'
        # A capture taken without the permission is a flat desktop colour —
        # it comes back "successfully", so tell the caller what it is.
        '__flat=$(sips -Z 16 -s format bmp "$__f" --out "$__f.bmp" >/dev/null 2>&1 && '
        f'python3 -c {shlex.quote(_FLAT_PY)} "$__f.bmp" 2>/dev/null); rm -f "$__f.bmp"\n'
        '[ "$__flat" = flat ] && echo "remote-host: the capture is one flat colour — Snipaste probably lacks Screen Recording '
        '(System Settings → Privacy & Security → Screen & System Audio Recording), or the display is asleep" >&2\n'
    )
    if screen is not None:
        script += (
            f"__frames=$(osascript -l JavaScript -e {shlex.quote(SCREENS_JXA)} 2>/dev/null)\n"
            f'__box=$(printf "%s\\n" "$__frames" | python3 -c {shlex.quote(_CROP_PY)} {int(screen)} 2>/dev/null)\n'
            'if [ -n "$__box" ]; then\n'
            "  set -- $__box\n"
            '  sips -c "$3" "$4" --cropOffset "$1" "$2" "$__f" >/dev/null 2>&1 || echo "remote-host: crop failed — returning the whole capture" >&2\n'
            "else\n"
            f'  echo "remote-host: display geometry unavailable (screen {int(screen)}) — returning the whole capture" >&2\n'
            "fi\n"
        )
    if png:
        script += 'echo "' + MARK + '$__f"\n'
    else:
        script += (
            '__o="${__f%.png}.jpg"\n'
            f'if sips -Z {int(max_edge)} -s format jpeg -s formatOptions 70 "$__f" --out "$__o" >/dev/null 2>&1; '
            'then rm -f "$__f"; else __o="$__f"; fi\n'
            'echo "' + MARK + '$__o"\n'
        )
    return script


# Prints "flat" when a tiny BMP (sips -Z 16) has almost no colour spread:
# measured 2026-09-23, a no-permission capture spreads 6, a real desktop 55.
_FLAT_PY = (
    "import struct,sys\n"
    "b=open(sys.argv[1],'rb').read(); o=struct.unpack_from('<I',b,10)[0]\n"
    "w,h=struct.unpack_from('<ii',b,18); n=struct.unpack_from('<H',b,28)[0]//8; s=(w*n+3)&~3\n"
    "v=[b[o+r*s+c*n+k] for r in range(abs(h)) for c in range(w) for k in range(min(3,n))]\n"
    "print('flat' if v and max(v)-min(v)<16 else 'ok')\n"
)


# Reads "x,y,w,h,scale" lines on stdin; prints "top left height width" for argv[1].
_CROP_PY = (
    "import sys\n"
    "f=[tuple(float(v) for v in l.split(',')) for l in sys.stdin if l.strip()]\n"
    "i=int(sys.argv[1])\n"
    "s={x[4] for x in f}\n"
    "if 0<=i<len(f) and len(s)==1:\n"
    "    k=s.pop(); mx=min(x[0] for x in f); my=max(x[1]+x[3] for x in f); x,y,w,h,_=f[i]\n"
    "    print(round((my-(y+h))*k), round((x-mx)*k), round(h*k), round(w*k))\n"
)


def cmd_screenshot(args):
    host = host_of(args)
    done = run_remote(host, shot_script(args.max, args.screen, args.png), capture="stdout")
    lines = [l for l in done.stdout.decode(errors="replace").splitlines() if l.startswith(MARK)]
    if done.returncode or not lines:
        return done.returncode or 1
    remote = lines[-1][len(MARK):]
    local = Path(args.output).expanduser() if args.output else (
        Path.home() / ".cache" / "remote-host" / "shots" / f"{host}-{time.strftime('%Y%m%d-%H%M%S')}{Path(remote).suffix}")
    local.parent.mkdir(parents=True, exist_ok=True)
    got = subprocess.run(["scp", "-q", *SSH_OPTS, "--", f"{host}:{remote}", str(local)]).returncode
    run_remote(host, f"rm -f {shlex.quote(remote)}\n", capture=True)
    if got:
        print(f"remote-host: could not copy {remote} from {host}", file=sys.stderr)
        return got
    print(local)
    return 0
