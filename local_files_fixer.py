#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Local Files Fixer
=================
Pick a music folder. The app scans every .mp3 / .m4a in it for the hidden problems that make
Spotify's "Local files" grey out, refuse to match between your PC / Mac / phone, or disagree
about how long a song is - then fixes them.

What it looks for (all of these were found and fixed in a real library):

  MP3  - A hidden "length header" frame at the start of the file that PCs, Macs and phones
         count differently. It is flagged when the header frame's bitrate doesn't match the
         audio, or when the song's length sits within a hair of a whole second.
         FIX: remove that header frame (it contains no audio; nothing audible changes).
         Variable-bitrate (Xing) files are left alone - they need their header.

  M4A  - A gapless-playback tag (iTunSMPB) that contradicts the song's real length, e.g. says
         115 s on a 203 s song. Macs read that tag, Windows ignores it, so the two disagree.
         FIX: rewrite the three numbers in that tag. Nothing else in the file changes.

  Mac leftovers - .DS_Store files, "__MACOSX" folders and "._something.mp3" files (tiny
         Mac metadata files that can appear as broken tracks).
         FIX: removed (moved to the backup folder when backup is on).

  Optional - M4A gapless tag that is off by a frame or two (not known to cause problems).

Everything is done on a safe path: new file written beside the original, checked, original
backed up, then swapped in. Needs only Python 3 (standard library), tkinter for the window.

Command line (no window):
    python local_files_fixer.py "D:\\Music\\local files" --scan
    python local_files_fixer.py "D:\\Music\\local files" --fix [--no-backup] [--minor]
"""
import datetime
import math
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import threading

APP_TITLE = "Local Files Fixer"

# --------------------------------------------------------------------------------------
# Categories
# --------------------------------------------------------------------------------------
CAT_MP3, CAT_M4A, CAT_JUNK, CAT_MINOR = "mp3", "m4a", "junk", "minor"
CATEGORY_LABELS = {
    CAT_MP3: "MP3 length header",
    CAT_M4A: "M4A gapless tag",
    CAT_JUNK: "Mac leftovers",
    CAT_MINOR: "Minor tag tidy-up (optional)",
}
CATEGORY_DEFAULT_ON = {CAT_MP3: True, CAT_M4A: True, CAT_JUNK: True, CAT_MINOR: False}


class Issue:
    __slots__ = ("cat", "path", "rel", "problem", "fix", "kind")

    def __init__(self, cat, path, rel, problem, fix, kind):
        self.cat, self.path, self.rel, self.problem, self.fix, self.kind = cat, path, rel, problem, fix, kind


class ScanResult:
    def __init__(self):
        self.issues = []
        self.n_mp3 = 0
        self.n_m4a = 0
        self.errors = []

    @property
    def n_audio(self):
        return self.n_mp3 + self.n_m4a


# --------------------------------------------------------------------------------------
# MP3
# --------------------------------------------------------------------------------------
_BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
_SR_V1 = [44100, 48000, 32000]


def parse_frame_header(b, p=0):
    """MPEG-1 Layer III frame header at b[p:p+4], or None."""
    if p < 0 or p + 4 > len(b):
        return None
    b0, b1, b2, b3 = b[p], b[p + 1], b[p + 2], b[p + 3]
    if b0 != 0xFF or (b1 & 0xFE) != 0xFA:
        return None
    bri, sri, pad = b2 >> 4, (b2 >> 2) & 3, (b2 >> 1) & 1
    if bri in (0, 15) or sri == 3:
        return None
    kbps, sr = _BR_V1_L3[bri], _SR_V1[sri]
    return {"kbps": kbps, "sr": sr, "size": 144 * kbps * 1000 // sr + pad,
            "mono": (b3 >> 6) == 3, "crc": (b1 & 1) == 0}


def id3v2_end(head10):
    if len(head10) < 10 or head10[:3] != b"ID3":
        return 0
    s = head10[6:10]
    n = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]
    return 10 + n + (10 if head10[5] & 0x10 else 0)


def parse_mp3_head(buf, base):
    """buf = file bytes starting at offset `base` (the end of the ID3v2 tag).
    Returns a dict describing the first audio frame / length header, or None."""
    first = None
    for i in range(0, min(len(buf) - 4, 8192)):
        if buf[i] != 0xFF:
            continue
        h = parse_frame_header(buf, i)
        if not h:
            continue
        nxt = i + h["size"]
        if nxt + 4 <= len(buf):
            h2 = parse_frame_header(buf, nxt)
            if not h2 or h2["sr"] != h["sr"]:
                continue
        first = i
        break
    if first is None:
        return None
    h = parse_frame_header(buf, first)
    side = 17 if h["mono"] else 32
    xo = first + 4 + (2 if h["crc"] else 0) + side
    tag = bytes(buf[xo:xo + 4])
    info = {"ffo": base + first, "hdr": h, "tag": tag, "frames": None, "delay": None, "padding": None, "next_kbps": None}
    if tag in (b"Info", b"Xing") and xo + 8 <= len(buf):
        fl = struct.unpack(">I", buf[xo + 4:xo + 8])[0]
        p = xo + 8
        if fl & 1:
            info["frames"] = struct.unpack(">I", buf[p:p + 4])[0]
            p += 4
        if fl & 2:
            p += 4
        if fl & 4:
            p += 100
        if fl & 8:
            p += 4
        enc = bytes(buf[p:p + 9]).decode("latin-1", "replace")
        if enc[:4] in ("LAME", "Lavc", "Lavf", "Lame") and p + 24 <= len(buf):
            d3 = buf[p + 21:p + 24]
            delay, padding = (d3[0] << 4) | (d3[1] >> 4), ((d3[1] & 0xF) << 8) | d3[2]
            if 0 <= delay <= 3000 and 0 <= padding <= 5000:
                info["delay"], info["padding"] = delay, padding
        nxt = parse_frame_header(buf, first + h["size"])
        info["next_kbps"] = nxt["kbps"] if nxt else None
    return info


def _mmss(sec):
    sec = int(sec)
    return "%d:%02d" % (sec // 60, sec % 60)


def mp3_problems(info):
    """List of human-readable problems for a CBR 'Info' length header (empty = fine)."""
    if not info or info["tag"] != b"Info":
        return []  # no header, or a VBR (Xing) header that must stay
    out = []
    h = info["hdr"]
    if info["next_kbps"] and info["next_kbps"] != h["kbps"]:
        out.append("length-header frame is %d kbps but the audio is %d kbps, so apps read different lengths" % (h["kbps"], info["next_kbps"]))
    n = info["frames"]
    if n:
        sr = h["sr"]
        reads = [n * 1152 / sr, (n + 1) * 1152 / sr]
        if info["delay"] is not None:
            reads.append((n * 1152 - info["delay"] - info["padding"]) / sr)
        fl = sorted({math.floor(x) for x in reads})
        if len(fl) > 1:
            out.append("length is %.2f s, just under a whole second, so apps can show %s or %s" % (
                reads[0], _mmss(fl[0]), _mmss(fl[-1])))
    return out


def scan_mp3(path):
    with open(path, "rb") as f:
        start = id3v2_end(f.read(10))
        f.seek(start)
        buf = f.read(16384)
    info = parse_mp3_head(buf, start)
    probs = mp3_problems(info)
    return probs


def fix_mp3(path):
    """Returns (new_bytes, message) or raises ValueError with the reason it was left alone."""
    with open(path, "rb") as f:
        data = f.read()
    start = id3v2_end(data[:10])
    info = parse_mp3_head(data[start:start + 16384], start)
    if not info or info["tag"] != b"Info":
        raise ValueError("no CBR length header found")
    ffo, size = info["ffo"], info["hdr"]["size"]
    if parse_frame_header(data, ffo + size) is None:
        raise ValueError("the frame after the header isn't valid audio")
    new = data[:ffo] + data[ffo + size:]
    end = len(new) - (128 if new[-128:-125] == b"TAG" else 0)
    p, n, rates = ffo, 0, set()
    while p + 4 <= end:
        hh = parse_frame_header(new, p)
        if not hh:
            break
        rates.add(hh["kbps"])
        n += 1
        p += hh["size"]
    if n == 0 or len(rates) != 1 or p < end:
        raise ValueError("audio isn't constant-bitrate or has unexpected data after it")
    return new, "removed the %d kbps length-header frame (%d bytes); %d audio frames untouched" % (
        info["hdr"]["kbps"], size, n)


# --------------------------------------------------------------------------------------
# M4A
# --------------------------------------------------------------------------------------
def _children(buf, s, e):
    p = s
    while p + 8 <= e:
        sz, typ = struct.unpack(">I4s", buf[p:p + 8])
        hl = 8
        if sz == 1:
            sz = struct.unpack(">Q", buf[p + 8:p + 16])[0]
            hl = 16
        elif sz == 0:
            sz = e - p
        if sz < hl or p + sz > e:
            return
        yield typ, p, hl, sz
        p += sz


def _find(buf, s, e, path):
    for typ, p, hl, sz in _children(buf, s, e):
        if typ == path[0]:
            if len(path) == 1:
                return p, hl, sz
            r = _find(buf, p + hl, p + sz, path[1:])
            if r:
                return r
    return None


def parse_m4a(path):
    size = os.path.getsize(path)
    moov = None
    with open(path, "rb") as f:
        pos = 0
        while pos + 8 <= size:
            f.seek(pos)
            h = f.read(16)
            if len(h) < 8:
                break
            bs, typ = struct.unpack(">I4s", h[:8])
            hl = 8
            if bs == 1 and len(h) >= 16:
                bs, hl = struct.unpack(">Q", h[8:16])[0], 16
            elif bs == 0:
                bs = size - pos
            if bs < hl:
                break
            if typ == b"moov":
                f.seek(pos)
                moov = (pos, f.read(bs), hl)
                break
            pos += bs
    if not moov:
        return None
    base, mb, mhl = moov
    ms, me = mhl, len(mb)
    mv = _find(mb, ms, me, [b"mvhd"])
    if not mv:
        return None
    p = mv[0]
    if mb[p + 8] == 1:
        ts, du = struct.unpack(">IQ", mb[p + 28:p + 40])
    else:
        ts, du = struct.unpack(">II", mb[p + 20:p + 28])
    res = {"mvhd": du / ts if ts else 0.0, "mts": None, "N": None, "smpb": None, "span": None, "text": None}
    for typ, tp, thl, tsz in _children(mb, ms, me):
        if typ != b"trak":
            continue
        hd = _find(mb, tp + thl, tp + tsz, [b"mdia", b"hdlr"])
        if hd and bytes(mb[hd[0] + 16:hd[0] + 20]) != b"soun":
            continue
        md = _find(mb, tp + thl, tp + tsz, [b"mdia", b"mdhd"])
        st = _find(mb, tp + thl, tp + tsz, [b"mdia", b"minf", b"stbl", b"stts"])
        if not md or not st:
            continue
        q = md[0]
        mts = struct.unpack(">IQ", mb[q + 28:q + 40])[0] if mb[q + 8] == 1 else struct.unpack(">I", mb[q + 20:q + 24])[0]
        cnt = struct.unpack(">I", mb[st[0] + 12:st[0] + 16])[0]
        tot, q = 0, st[0] + 16
        for _ in range(cnt):
            c, d = struct.unpack(">II", mb[q:q + 8])
            tot += c * d
            q += 8
        res["mts"], res["N"] = mts, tot
        break
    ud = _find(mb, ms, me, [b"udta", b"meta"])
    if ud:
        il = _find(mb, ud[0] + ud[1] + 4, ud[0] + ud[2], [b"ilst"])
        if il:
            for t, ip, ih, isz in _children(mb, il[0] + il[1], il[0] + il[2]):
                if t != b"----":
                    continue
                name = data = None
                for t2, p2, h2, s2 in _children(mb, ip + ih, ip + isz):
                    if t2 == b"name":
                        name = bytes(mb[p2 + h2 + 4:p2 + s2]).decode("utf-8", "replace")
                    elif t2 == b"data":
                        data = (p2 + h2 + 8, p2 + s2)
                if name == "iTunSMPB" and data:
                    text = bytes(mb[data[0]:data[1]]).decode("utf-8", "replace")
                    tk = text.split()
                    try:
                        res["smpb"] = (int(tk[1], 16), int(tk[2], 16), int(tk[3], 16))
                        res["span"] = (base + data[0], base + data[1])
                        res["text"] = text
                    except (ValueError, IndexError):
                        pass
                    break
    return res


def m4a_problem(i):
    """Returns (category, text) or None."""
    if not i or not i["smpb"] or not i["N"] or not i["mts"]:
        return None
    pr, pad, valid = i["smpb"]
    ts = i["mts"]
    diff = valid / ts - i["mvhd"]
    if abs(diff) > 0.3:
        return CAT_M4A, ("gapless tag says %.1f s but the song is %.1f s long (Macs read the tag, Windows ignores "
                         "it, so they disagree)" % (valid / ts, i["mvhd"]))
    gap = i["N"] - (valid + pr + pad)
    if gap != 0:
        return CAT_MINOR, "gapless tag doesn't add up - off by %d audio frame(s) (%.0f ms)" % (
            abs(gap) // 1024 or 1, abs(gap) / ts * 1000)
    return None


def plan_m4a_tag(i, minor):
    """New (priming, padding, valid) for the tag, or None."""
    N, ts = i["N"], i["mts"]
    pr0, pad0, _ = i["smpb"]
    if minor:
        v = N - pr0 - pad0
        return (pr0, pad0, v) if v > 0 else None
    pr = pr0 if 1024 <= pr0 <= 4096 else 2112
    first = pad0 if 0 <= pad0 < 2048 else 0
    for strict in (True, False):
        for pd in [first] + list(range(0, 1024, 8)):
            v = N - pr - pd
            if v <= 0:
                continue
            reads = [i["mvhd"], N / ts, (N - 2112) / ts, v / ts, (N - pr) / ts]
            if len({math.floor(x) for x in reads}) == 1 and (not strict or len({round(x) for x in reads}) == 1):
                return pr, pd, v
    return None


def fix_m4a(path, minor):
    """Returns (new_bytes, message) or raises ValueError."""
    i = parse_m4a(path)
    if not i or not i["smpb"] or not i["span"]:
        raise ValueError("no gapless tag found")
    plan = plan_m4a_tag(i, minor)
    if not plan:
        raise ValueError("couldn't work out safe tag values")
    with open(path, "rb") as f:
        data = bytearray(f.read())
    s, e = i["span"]
    text = data[s:e].decode("utf-8")
    toks = list(re.finditer(r"\S+", text))
    chars = list(text)
    for idx, val in zip((1, 2, 3), plan):
        a, b = toks[idx].span()
        rep = "%0*X" % (b - a, val)
        if len(rep) != b - a:
            raise ValueError("new value doesn't fit the tag")
        chars[a:b] = list(rep)
    new_text = "".join(chars)
    if len(new_text.encode("utf-8")) != e - s:
        raise ValueError("tag length would change")
    new = bytearray(data)
    new[s:e] = new_text.encode("utf-8")
    pr0, pad0, v0 = i["smpb"]
    return bytes(new), "gapless tag %.1f s -> %.1f s (song is %.1f s); only those 3 numbers changed" % (
        v0 / i["mts"], plan[2] / i["mts"], i["mvhd"])


def verify_m4a(tmp_path, original_path, minor):
    a, b = parse_m4a(original_path), parse_m4a(tmp_path)
    if not b or not b["smpb"]:
        raise ValueError("verification: tag unreadable after the change")
    pr, pad, v = b["smpb"]
    if v + pr + pad != b["N"]:
        raise ValueError("verification: tag still doesn't add up")
    if a["mvhd"] != b["mvhd"] or a["N"] != b["N"]:
        raise ValueError("verification: file structure changed")
    if not minor:
        ts = b["mts"]
        reads = [b["mvhd"], b["N"] / ts, (b["N"] - 2112) / ts, v / ts]
        if len({math.floor(x) for x in reads}) != 1:
            raise ValueError("verification: lengths still disagree")


def verify_mp3(tmp_path):
    with open(tmp_path, "rb") as f:
        start = id3v2_end(f.read(10))
        f.seek(start)
        info = parse_mp3_head(f.read(16384), start)
    if not info or info["tag"] in (b"Info", b"Xing"):
        raise ValueError("verification: header frame still present")


# --------------------------------------------------------------------------------------
# Folder scan / fix
# --------------------------------------------------------------------------------------
def is_appledouble(path):
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"\x00\x05\x16\x07"
    except OSError:
        return False


def list_audio_and_junk(root):
    audio, junk = [], []
    for dp, dn, fn in os.walk(root):
        for d in list(dn):
            if d == "__MACOSX":
                junk.append((os.path.join(dp, d), "dir"))
                dn.remove(d)
        for f in fn:
            full = os.path.join(dp, f)
            if f == ".DS_Store":
                junk.append((full, "ds"))
            elif f.startswith("._") and is_appledouble(full):
                junk.append((full, "ad"))
            elif os.path.splitext(f)[1].lower() in (".mp3", ".m4a"):
                audio.append(full)
    return audio, junk


JUNK_TEXT = {
    "dir": ("'__MACOSX' folder - leftover Mac metadata from unzipping", "Remove the folder"),
    "ds": (".DS_Store - Mac folder-settings file", "Remove the file"),
    "ad": ("Mac '._' companion file - not audio, and it can show up as a broken track if it's named like a song",
           "Remove the file"),
}


def scan_folder(root, progress=None):
    res = ScanResult()
    audio, junk = list_audio_and_junk(root)
    total = len(audio)
    for path, kind in junk:
        txt, fx = JUNK_TEXT[kind]
        res.issues.append(Issue(CAT_JUNK, path, os.path.relpath(path, root), txt, fx, "junk-" + kind))
    for n, path in enumerate(audio, 1):
        rel = os.path.relpath(path, root)
        if progress:
            progress(n, total, rel)
        try:
            if path.lower().endswith(".mp3"):
                res.n_mp3 += 1
                probs = scan_mp3(path)
                if probs:
                    res.issues.append(Issue(CAT_MP3, path, rel, "; ".join(probs),
                                            "Remove the length-header frame", "mp3"))
            else:
                res.n_m4a += 1
                pr = m4a_problem(parse_m4a(path))
                if pr:
                    cat, txt = pr
                    res.issues.append(Issue(cat, path, rel, txt, "Correct the gapless tag numbers",
                                            "m4a-minor" if cat == CAT_MINOR else "m4a"))
        except Exception as ex:  # keep scanning
            res.errors.append("%s: %s" % (rel, ex))
    res.issues.sort(key=lambda x: (list(CATEGORY_LABELS).index(x.cat), x.rel.lower()))
    return res


def default_backup_root(root):
    root = os.path.abspath(root.rstrip("\\/"))
    parent, name = os.path.split(root)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H-%M-%S")
    if not name:
        return os.path.join(root, "Local Files Fixer backup " + stamp)
    return os.path.join(parent, "%s - backup %s" % (name, stamp))


def fix_issue(issue, root, backup_root):
    """Fix one issue. Returns a short success message; raises on failure (file left unchanged)."""
    path = issue.path
    if issue.kind.startswith("junk-"):
        if backup_root:
            dst = os.path.join(backup_root, issue.rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(path, dst)
            return "moved to backup"
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        return "deleted"
    if issue.kind == "mp3":
        new, msg = fix_mp3(path)
        verifier = lambda tmp: verify_mp3(tmp)
    else:
        minor = issue.kind == "m4a-minor"
        new, msg = fix_m4a(path, minor)
        verifier = lambda tmp: verify_m4a(tmp, path, minor)
    tmp = path + ".fixing"
    try:
        with open(tmp, "wb") as f:
            f.write(new)
        verifier(tmp)
        if backup_root:
            dst = os.path.join(backup_root, issue.rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(path, dst)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return msg


def open_in_file_manager(path):
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:
        pass


# --------------------------------------------------------------------------------------
# Window
# --------------------------------------------------------------------------------------
def run_gui(initial_folder=None):
    import tkinter as tk
    import tkinter.font as tkfont
    from tkinter import ttk, filedialog, messagebox

    win = sys.platform.startswith("win")
    mac = sys.platform == "darwin"
    if win:
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass

    # ---- palette: Spotify-style near-black with green glow ----
    BG, PANEL, PANEL2, TRACK = "#090c0a", "#121815", "#1b2420", "#222d28"
    BORDER, BORDER_HI = "#26332c", "#1f7a46"
    TEXT, MUTED = "#ffffff", "#9aaaa1"
    G1, G2 = "#1aa84b", "#3be67f"          # gradient ends (green -> bright green)
    GOOD, WARN = "#1ed760", "#fbbf24"
    STRIPE, SELECT = "#0f1512", "#1d4a31"
    OFF, OFF_T = "#161f1b", "#55655c"
    FAM = "Segoe UI" if win else ("Helvetica Neue" if mac else "Helvetica")

    def mix(a, b, t):
        pa = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
        pb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
        return "#%02x%02x%02x" % tuple(int(x + (y - x) * t) for x, y in zip(pa, pb))

    def pill(cv, x1, y1, x2, y2, col):
        r = (y2 - y1) / 2.0
        cv.create_oval(x1, y1, x1 + 2 * r, y2, fill=col, outline=col)
        cv.create_oval(x2 - 2 * r, y1, x2, y2, fill=col, outline=col)
        cv.create_rectangle(x1 + r, y1, x2 - r, y2 + 1, fill=col, outline=col)

    def gradient_pill(cv, x1, y1, x2, y2, c1, c2, lift=0.0, span=None):
        """Pill filled with a horizontal gradient."""
        h = y2 - y1
        r = h / 2.0
        span = span or max(x2 - x1, 1)
        col = lambda x: mix(mix(c1, c2, min(max((x - x1) / span, 0), 1)), "#ffffff", lift)
        cv.create_oval(x1, y1, x1 + h, y2, fill=col(x1), outline=col(x1))
        cv.create_oval(x2 - h, y1, x2, y2, fill=col(x2), outline=col(x2))
        x = x1 + r
        while x < x2 - r:
            nx = min(x + 3, x2 - r)
            cv.create_rectangle(x, y1, nx + 1, y2 + 1, fill=col(x), outline=col(x))
            x = nx

    class RoundButton(tk.Canvas):
        """Pill button: gradient for primary, outlined for secondary, with a smooth hover fade."""

        def __init__(self, parent, text, command, kind="secondary", bg=BG, padx=26, height=42, state="normal"):
            self._font = tkfont.Font(family=FAM, size=10, weight="bold")
            self._padx = padx
            super().__init__(parent, width=self._font.measure(text) + padx * 2, height=height, bg=bg,
                             highlightthickness=0, bd=0)
            self._text, self._cmd, self._kind, self._state = text, command, kind, state
            self._t = self._goal = 0.0
            self.bind("<Enter>", lambda e: self._go(1.0))
            self.bind("<Leave>", lambda e: self._go(0.0))
            self.bind("<ButtonRelease-1>", self._click)
            self.bind("<Configure>", lambda e: self._draw())
            self._apply_cursor()
            self._draw()

        def _apply_cursor(self):
            tk.Canvas.configure(self, cursor="hand2" if self._state == "normal" else "arrow")

        def _go(self, goal):
            self._goal = goal if self._state == "normal" else 0.0
            self._step()

        def _step(self):
            if abs(self._goal - self._t) < 0.02:
                self._t = self._goal
                self._draw()
                return
            self._t += (self._goal - self._t) * 0.35
            self._draw()
            self.after(16, self._step)

        def _click(self, e):
            if self._state == "normal" and 0 <= e.x <= self.winfo_width() and 0 <= e.y <= self.winfo_height():
                self._cmd()

        def _draw(self):
            self.delete("all")
            w, h = self.winfo_width(), self.winfo_height()
            if w < 4:
                w, h = int(self["width"]), int(self["height"])
            on = self._state == "normal"
            if not on:
                pill(self, 1, 1, w - 1, h - 1, OFF)
                fg = OFF_T
            elif self._kind == "primary":
                gradient_pill(self, 1, 1, w - 1, h - 1, G1, G2, lift=0.16 * self._t)
                fg = "#03140a"
            else:
                pill(self, 1, 1, w - 1, h - 1, mix(BORDER, BORDER_HI, self._t))
                pill(self, 2, 2, w - 2, h - 2, mix(PANEL2, "#26352d", self._t))
                fg = TEXT
            self.create_text(w / 2, h / 2, text=self._text, fill=fg, font=self._font)

        def configure(self, cnf=None, **kw):
            if "state" in kw:
                self._state = kw.pop("state")
                self._t = self._goal = 0.0
                self._apply_cursor()
            if "text" in kw:
                self._text = kw.pop("text")
                tk.Canvas.configure(self, width=self._font.measure(self._text) + self._padx * 2)
            if kw or cnf:
                tk.Canvas.configure(self, cnf, **kw)
            self._draw()

        config = configure

        def cget(self, key):
            return self._state if key == "state" else tk.Canvas.cget(self, key)

    class GradBar(tk.Canvas):
        """Slim progress bar with a blue -> violet gradient fill."""

        def __init__(self, parent, bg=BG, height=10):
            super().__init__(parent, height=height, bg=bg, highlightthickness=0, bd=0)
            self._max, self._val = 100.0, 0.0
            self.bind("<Configure>", lambda e: self._draw())

        def configure(self, cnf=None, **kw):
            if "maximum" in kw:
                self._max = float(kw.pop("maximum"))
            if "value" in kw:
                self._val = float(kw.pop("value"))
            if kw or cnf:
                tk.Canvas.configure(self, cnf, **kw)
            self._draw()

        config = configure

        def __getitem__(self, k):
            return self._max if k == "maximum" else self._val if k == "value" else tk.Canvas.cget(self, k)

        def _draw(self):
            self.delete("all")
            w, h = self.winfo_width(), int(tk.Canvas.cget(self, "height"))
            if w < 8:
                return
            pill(self, 0, 0, w, h - 1, TRACK)
            fw = int(w * min(self._val / self._max, 1.0)) if self._max else 0
            if fw > h:
                gradient_pill(self, 0, 0, fw, h - 1, G1, G2, span=w)

    class GradTitle(tk.Canvas):
        def __init__(self, parent, plain, fancy, size=30):
            f = tkfont.Font(family=FAM, size=size, weight="bold")
            w = f.measure(plain + fancy) + 8
            super().__init__(parent, width=w, height=f.metrics("linespace") + 8, bg=BG, highlightthickness=0, bd=0)
            self.create_text(2, 4, text=plain, anchor="nw", fill=TEXT, font=f)
            x = 2 + f.measure(plain)
            total = max(f.measure(fancy), 1)
            done = 0
            for ch in fancy:
                self.create_text(x + done, 4, text=ch, anchor="nw", fill=mix(G1, G2, done / total), font=f)
                done += f.measure(ch)

    def round_rect(cv, x1, y1, x2, y2, r, **kw):
        r = max(1, min(r, (x2 - x1) / 2.0, (y2 - y1) / 2.0))
        pts = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2, x2 - r, y2, x1 + r, y2,
               x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]
        return cv.create_polygon(pts, smooth=True, **kw)

    class RoundBox(tk.Canvas):
        """Rounded read-only field / tag with text."""

        def __init__(self, parent, text="", textvariable=None, height=42, fill=PANEL2, outline=BORDER, fg=TEXT,
                     font=None, bg=PANEL, padx=18, radius=14, autosize=False):
            self._font = font or tkfont.Font(family=FAM, size=10)
            if not isinstance(self._font, tkfont.Font):
                self._font = tkfont.Font(font=self._font)
            self._fill, self._outline, self._fg, self._padx, self._r = fill, outline, fg, padx, radius
            self._var = textvariable
            self._text = text
            w = (self._font.measure(text) + padx * 2) if autosize else 100
            super().__init__(parent, width=w, height=height, bg=bg, highlightthickness=0, bd=0)
            if self._var is not None:
                self._var.trace_add("write", lambda *a: self._draw())
            self.bind("<Configure>", lambda e: self._draw())
            self._draw()

        def _draw(self):
            self.delete("all")
            w, h = self.winfo_width(), self.winfo_height()
            if w < 4:
                return
            round_rect(self, 1, 1, w - 1, h - 1, self._r, fill=self._fill, outline=self._outline)
            txt = self._var.get() if self._var is not None else self._text
            self.create_text(self._padx, h / 2, text=txt, anchor="w", fill=self._fg, font=self._font)

    class Card(tk.Frame):
        """Rounded panel. Put children straight into it (grid/pack) like a normal Frame."""

        def __init__(self, parent, glow=False, radius=20):
            bg = parent.cget("bg")
            super().__init__(parent, bg=bg, bd=0, highlightthickness=0)
            self._r, self._outline = radius, (BORDER_HI if glow else BORDER)
            self._cv = tk.Canvas(self, bg=bg, highlightthickness=0, bd=0)
            self._cv.place(x=0, y=0, relwidth=1, relheight=1)
            self.bind("<Configure>", self._redraw)

        def _redraw(self, e):
            self._cv.delete("all")
            if e.width > 4 and e.height > 4:
                round_rect(self._cv, 1, 1, e.width - 1, e.height - 1, self._r, fill=PANEL, outline=self._outline)

    def card(parent, glow=False):
        return Card(parent, glow)

    def small_caps(parent, text, bg=PANEL, fg=MUTED):
        return tk.Label(parent, text=text.upper(), bg=bg, fg=fg, font=(FAM, 8, "bold"))

    def dark_titlebar(window):
        if not win:
            return
        try:
            import ctypes
            window.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(window.winfo_id())
            val = ctypes.c_int(1)
            for attr in (20, 19):
                ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(val), ctypes.sizeof(val))
        except Exception:
            pass

    class App:
        def __init__(self, root):
            self.root = root
            self.q = queue.Queue()
            self.folder = None
            self.issues = []
            self.busy = False
            self.last_backup = None
            self._target = self._shown = 0.0
            root.title(APP_TITLE)
            root.configure(bg=BG)
            root.geometry("1200x960")
            root.minsize(980, 720)
            self._style()
            self._build()
            dark_titlebar(root)
            root.after(80, self._poll)
            root.after(16, self._anim)
            if initial_folder and os.path.isdir(initial_folder):
                self.set_folder(initial_folder)

        # ---------- look ----------
        def _style(self):
            s = ttk.Style()
            try:
                s.theme_use("clam")
            except tk.TclError:
                pass
            s.configure("Dark.Treeview", background=PANEL, fieldbackground=PANEL, foreground=TEXT, rowheight=34,
                        borderwidth=0, relief="flat", font=(FAM, 10))
            s.layout("Dark.Treeview", [("Treeview.treearea", {"sticky": "nswe"})])
            s.map("Dark.Treeview", background=[("selected", SELECT)], foreground=[("selected", "#ffffff")])
            s.configure("Dark.Treeview.Heading", background=PANEL2, foreground=MUTED, relief="flat", borderwidth=0,
                        padding=(12, 9), font=(FAM, 9, "bold"))
            s.map("Dark.Treeview.Heading", background=[("active", PANEL2)])
            s.configure("Dark.Vertical.TScrollbar", troughcolor=PANEL, background=BORDER, bordercolor=PANEL,
                        lightcolor=BORDER, darkcolor=BORDER, arrowcolor=MUTED, relief="flat", gripcount=0)
            s.map("Dark.Vertical.TScrollbar", background=[("active", BORDER_HI)])
            s.configure("Dark.TCheckbutton", background=PANEL, foreground=TEXT, focuscolor=PANEL, font=(FAM, 10))
            s.map("Dark.TCheckbutton", background=[("active", PANEL)], foreground=[("active", "#ffffff")],
                  indicatorbackground=[("selected", G1), ("!selected", PANEL2)],
                  indicatorforeground=[("selected", "#ffffff")], upperbordercolor=[("!selected", BORDER_HI)],
                  lowerbordercolor=[("!selected", BORDER_HI)])

        # ---------- layout ----------
        def _build(self):
            r = self.root
            P = 26
            r.columnconfigure(0, weight=1)
            r.rowconfigure(5, weight=1)

            head = tk.Frame(r, bg=BG)
            head.grid(row=0, column=0, sticky="ew", padx=P, pady=(22, 8))
            RoundBox(head, text="  ".join("SPOTIFY LOCAL FILES"), height=30, fill=BG, outline=BORDER_HI, fg="#b9f5d0",
                     font=tkfont.Font(family=FAM, size=8, weight="bold"), bg=BG, padx=16, radius=15,
                     autosize=True).pack(anchor="w")
            GradTitle(head, "Local Files ", "Fixer").pack(anchor="w", pady=(8, 0))
            tk.Label(head, bg=BG, fg=MUTED, font=(FAM, 11), justify="left", anchor="w",
                     text="Clean, safe repairs for the hidden problems that make local files grey out or fail to "
                          "match between your PC, Mac and phone.").pack(anchor="w", pady=(2, 0))

            fc = card(r, glow=True)
            fc.grid(row=1, column=0, sticky="ew", padx=P, pady=(10, 6))
            fc.columnconfigure(1, weight=1)
            RoundButton(fc, "Choose folder…", self.choose, "primary", bg=PANEL).grid(row=0, column=0, padx=16, pady=14)
            self.path_var = tk.StringVar(value="No folder chosen yet")
            RoundBox(fc, textvariable=self.path_var, height=42, bg=PANEL, radius=16).grid(
                row=0, column=1, sticky="ew", pady=14)
            self.scan_btn = RoundButton(fc, "Scan again", self.scan, "secondary", bg=PANEL, state="disabled")
            self.scan_btn.grid(row=0, column=2, padx=16, pady=14)

            tiles = tk.Frame(r, bg=BG)
            tiles.grid(row=2, column=0, sticky="ew", padx=P, pady=6)
            self.tiles = {}
            for i, (key, label) in enumerate((("scanned", "Audio files scanned"), ("fix", "Need fixing"),
                                              ("junk", "Mac leftovers"), ("opt", "Optional tidy-ups"))):
                tiles.columnconfigure(i, weight=1, uniform="t")
                t = card(tiles)
                t.grid(row=0, column=i, sticky="ew", padx=(0 if i == 0 else 7, 0 if i == 3 else 7))
                small_caps(t, label).pack(anchor="w", padx=16, pady=(9, 0))
                num = tk.Label(t, text="–", bg=PANEL, fg=TEXT, font=(FAM, 20, "bold"))
                num.pack(anchor="w", padx=16)
                sub = tk.Label(t, text=" ", bg=PANEL, fg=MUTED, font=(FAM, 9))
                sub.pack(anchor="w", padx=16, pady=(0, 8))
                self.tiles[key] = (num, sub)

            oc = card(r)
            oc.grid(row=3, column=0, sticky="ew", padx=P, pady=6)
            small_caps(oc, "What to fix").grid(row=0, column=0, sticky="w", padx=18, pady=(11, 0), columnspan=8)
            self.cat_vars = {}
            for i, (c, label) in enumerate(CATEGORY_LABELS.items()):
                v = tk.BooleanVar(value=CATEGORY_DEFAULT_ON[c])
                self.cat_vars[c] = v
                ttk.Checkbutton(oc, text=label, variable=v, style="Dark.TCheckbutton").grid(
                    row=1, column=i, sticky="w", padx=(18, 10), pady=(7, 11))
            self.backup_var = tk.BooleanVar(value=True)
            ttk.Checkbutton(oc, variable=self.backup_var, style="Dark.TCheckbutton",
                            text="Back up originals (recommended)").grid(row=1, column=4, sticky="w", padx=(18, 10), pady=(7, 11))

            pf = tk.Frame(r, bg=BG)
            pf.grid(row=4, column=0, sticky="ew", padx=P, pady=(10, 4))
            pf.columnconfigure(0, weight=1)
            self.bar = GradBar(pf)
            self.bar.grid(row=0, column=0, sticky="ew")
            self.status = tk.StringVar(value="Choose a folder to begin.")
            self.status_lbl = tk.Label(pf, textvariable=self.status, bg=BG, fg=MUTED, font=(FAM, 10), anchor="w")
            self.status_lbl.grid(row=1, column=0, sticky="w", pady=(6, 0))

            rc = card(r)
            rc.grid(row=5, column=0, sticky="nsew", padx=P, pady=6)
            rc.columnconfigure(0, weight=1)
            rc.rowconfigure(0, weight=1)
            self.tree = ttk.Treeview(rc, columns=("file", "problem", "fix"), show="headings", selectmode="extended",
                                     style="Dark.Treeview", height=6)
            for c, t, w in (("file", "File", 270), ("problem", "Problem", 560), ("fix", "What the fix does", 230)):
                self.tree.heading(c, text=t, anchor="w")
                self.tree.column(c, width=w, anchor="w", stretch=True)
            sb = ttk.Scrollbar(rc, orient="vertical", command=self.tree.yview, style="Dark.Vertical.TScrollbar")
            self.tree.configure(yscrollcommand=sb.set)
            self.tree.grid(row=0, column=0, sticky="nsew", padx=(14, 0), pady=14)
            sb.grid(row=0, column=1, sticky="ns", pady=14, padx=(0, 10))
            self.tree.tag_configure("odd", background=PANEL)
            self.tree.tag_configure("even", background=STRIPE)
            self.tree.tag_configure("minor", foreground=MUTED)
            self.tree.tag_configure("junk", foreground=WARN)
            self.empty = tk.Label(rc, text="Choose a folder to scan.", bg=PANEL, fg=MUTED, font=(FAM, 12))
            self.empty.place(relx=0.5, rely=0.55, anchor="center")

            ab = tk.Frame(r, bg=BG)
            ab.grid(row=6, column=0, sticky="ew", padx=P, pady=(8, 6))
            self.fix_all_btn = RoundButton(ab, "Fix everything ticked above", self.fix_all, "primary", state="disabled")
            self.fix_all_btn.pack(side="left")
            self.fix_sel_btn = RoundButton(ab, "Fix selected rows only", self.fix_selected, "secondary", state="disabled")
            self.fix_sel_btn.pack(side="left", padx=10)
            self.open_bk_btn = RoundButton(ab, "Open backup folder", self.open_backup, "secondary", state="disabled")
            self.open_bk_btn.pack(side="right")

            lc = card(r)
            lc.grid(row=7, column=0, sticky="ew", padx=P, pady=(6, 6))
            lc.columnconfigure(0, weight=1)
            small_caps(lc, "Log").grid(row=0, column=0, sticky="w", padx=14, pady=(9, 0))
            self.log = tk.Text(lc, height=3, wrap="word", state="disabled", relief="flat", bd=0, bg="#070b09",
                               fg="#a9bbb0", insertbackground=TEXT,
                               font=("Consolas" if win else "Menlo" if mac else "Monospace", 9),
                               padx=10, pady=6, highlightthickness=0)
            self.log.grid(row=1, column=0, sticky="ew", padx=(12, 0), pady=(5, 10))
            ls = ttk.Scrollbar(lc, orient="vertical", command=self.log.yview, style="Dark.Vertical.TScrollbar")
            self.log.configure(yscrollcommand=ls.set)
            ls.grid(row=1, column=1, sticky="ns", padx=(0, 8), pady=(5, 10))
            self.log.tag_configure("ok", foreground=GOOD)
            self.log.tag_configure("skip", foreground=WARN)

            fs = card(r, glow=True)
            fs.grid(row=8, column=0, sticky="ew", padx=P, pady=(6, 22))
            feats = (("Safe backups", "Originals are saved before any change."),
                     ("Verified changes", "Every fix is checked before it is swapped in."),
                     ("Audio untouched", "Only hidden headers and tags change."),
                     ("Skips the unsure", "Odd files are left exactly as they are."))
            for i, (t, d) in enumerate(feats):
                fs.columnconfigure(i * 2, weight=1, uniform="f")
                f = tk.Frame(fs, bg=PANEL)
                f.grid(row=0, column=i * 2, sticky="ew", padx=14, pady=11)
                tk.Label(f, text=t, bg=PANEL, fg=TEXT, font=(FAM, 10, "bold")).pack(anchor="w")
                tk.Label(f, text=d, bg=PANEL, fg=MUTED, font=(FAM, 9), wraplength=230, justify="left").pack(anchor="w")
                if i < 3:
                    tk.Frame(fs, bg=BORDER, width=1).grid(row=0, column=i * 2 + 1, sticky="ns", pady=10)

        # ---------- helpers ----------
        def write_log(self, text):
            tag = "ok" if text.startswith("FIXED") else "skip" if text.startswith("SKIPPED") else ""
            self.log.configure(state="normal")
            self.log.insert("end", text + "\n", tag)
            self.log.see("end")
            self.log.configure(state="disabled")

        def set_bar(self, value, maximum=None):
            if maximum is not None:
                self.bar.configure(maximum=max(maximum, 1))
            self._target = float(value)
            if value == 0:
                self._shown = 0.0
                self.bar.configure(value=0)

        def _anim(self):  # eases the progress bar toward its target
            d = self._target - self._shown
            if abs(d) > 0.01:
                self._shown += d * 0.22
                self.bar.configure(value=self._shown)
            self.root.after(16, self._anim)

        def set_tile(self, key, number, sub, color=MUTED):
            num, lbl = self.tiles[key]
            num.configure(text=str(number))
            lbl.configure(text=sub, fg=color)

        def set_empty(self, text):
            if text:
                self.empty.configure(text=text)
                self.empty.place(relx=0.5, rely=0.55, anchor="center")
            else:
                self.empty.place_forget()

        def set_busy(self, busy):
            self.busy = busy
            self.scan_btn.configure(state="disabled" if (busy or not self.folder) else "normal")
            has = bool(self.issues) and not busy
            self.fix_all_btn.configure(state="normal" if has else "disabled")
            self.fix_sel_btn.configure(state="normal" if has else "disabled")
            ok_bk = bool(self.last_backup and os.path.isdir(self.last_backup)) and not busy
            self.open_bk_btn.configure(state="normal" if ok_bk else "disabled")

        # ---------- actions ----------
        def choose(self):
            if self.busy:
                return
            d = filedialog.askdirectory(title="Choose your music / local files folder",
                                        initialdir=self.folder or os.path.expanduser("~"))
            if d:
                self.set_folder(d)

        def set_folder(self, d):
            self.folder = os.path.abspath(d)
            self.path_var.set(self.folder)
            self.last_backup = None
            self.scan()

        def scan(self):
            if self.busy or not self.folder:
                return
            self.issues = []
            for i in self.tree.get_children():
                self.tree.delete(i)
            for k in self.tiles:
                self.set_tile(k, "–", " ")
            self.set_bar(0, 100)
            self.status_lbl.configure(fg=MUTED)
            self.status.set("Scanning…")
            self.set_empty("Scanning…")
            self.set_busy(True)
            threading.Thread(target=self._scan_worker, args=(self.folder,), daemon=True).start()

        def _scan_worker(self, folder):
            try:
                def prog(n, total, rel):
                    if n % 5 == 0 or n == total:
                        self.q.put(("progress", n, total, rel))
                self.q.put(("scan_done", scan_folder(folder, prog)))
            except Exception as ex:
                self.q.put(("error", "Scan failed: %s" % ex))

        def fix_all(self):
            self._start_fix([x for x in self.issues if self.cat_vars[x.cat].get()])

        def fix_selected(self):
            self._start_fix([self.issues[int(i)] for i in self.tree.selection()])

        def _start_fix(self, todo):
            if self.busy:
                return
            if not todo:
                messagebox.showinfo(APP_TITLE, "Nothing to fix there. Tick a category above or select some rows.")
                return
            backup = self.backup_var.get()
            bk_root = default_backup_root(self.folder) if backup else None
            if backup:
                msg = "Fix %d item(s)?\n\nThe original of every changed file will be saved in:\n%s" % (len(todo), bk_root)
            else:
                msg = ("Fix %d item(s) WITHOUT a backup?\n\nThe originals will be overwritten (or deleted) and can't "
                       "be recovered." % len(todo))
            if not messagebox.askyesno(APP_TITLE, msg, icon="question" if backup else "warning"):
                return
            self.last_backup = bk_root
            self.set_bar(0, len(todo))
            self.status_lbl.configure(fg=MUTED)
            self.status.set("Fixing…")
            self.set_busy(True)
            threading.Thread(target=self._fix_worker, args=(todo, bk_root), daemon=True).start()

        def _fix_worker(self, todo, bk_root):
            ok = bad = 0
            for n, issue in enumerate(todo, 1):
                try:
                    msg = fix_issue(issue, self.folder, bk_root)
                    ok += 1
                    self.q.put(("log", "FIXED   %s - %s" % (issue.rel, msg)))
                except Exception as ex:
                    bad += 1
                    self.q.put(("log", "SKIPPED %s - %s (file left unchanged)" % (issue.rel, ex)))
                self.q.put(("fix_progress", n, len(todo)))
            self.q.put(("fix_done", ok, bad))

        def open_backup(self):
            if self.last_backup and os.path.isdir(self.last_backup):
                open_in_file_manager(self.last_backup)

        # ---------- queue pump (UI thread) ----------
        def _poll(self):
            try:
                while True:
                    m = self.q.get_nowait()
                    k = m[0]
                    if k == "progress":
                        _, n, total, rel = m
                        self.set_bar(n, total)
                        self.status.set("Scanning %d / %d   %s" % (n, total, rel))
                    elif k == "scan_done":
                        self._show_results(m[1])
                    elif k == "log":
                        self.write_log(m[1])
                    elif k == "fix_progress":
                        self.set_bar(m[1])
                        self.status.set("Fixing %d / %d" % (m[1], m[2]))
                    elif k == "fix_done":
                        _, ok, bad = m
                        self.write_log("Done: %d fixed, %d skipped." % (ok, bad))
                        self.busy = False
                        self.set_busy(False)
                        self.scan()  # re-check so you can see what's left
                    elif k == "error":
                        self.write_log(m[1])
                        self.status.set(m[1])
                        self.set_empty(m[1])
                        self.set_busy(False)
            except queue.Empty:
                pass
            self.root.after(80, self._poll)

        def _show_results(self, res):
            self.issues = res.issues
            for i in self.tree.get_children():
                self.tree.delete(i)
            for idx, x in enumerate(res.issues):
                tags = ("even" if idx % 2 else "odd",) + ((x.cat,) if x.cat in ("minor", "junk") else ())
                self.tree.insert("", "end", iid=str(idx), values=(x.rel, x.problem, x.fix), tags=tags)
            counts = {c: sum(1 for x in res.issues if x.cat == c) for c in CATEGORY_LABELS}
            main = counts[CAT_MP3] + counts[CAT_M4A]
            self.set_tile("scanned", res.n_audio, "%d MP3  ·  %d M4A" % (res.n_mp3, res.n_m4a))
            self.set_tile("fix", main, "all clear" if not main else "MP3 + M4A problems", GOOD if not main else G1)
            self.set_tile("junk", counts[CAT_JUNK], "none found" if not counts[CAT_JUNK] else "safe to remove",
                          MUTED if not counts[CAT_JUNK] else WARN)
            self.set_tile("opt", counts[CAT_MINOR], "none found" if not counts[CAT_MINOR] else "off by default")
            if not res.issues:
                self.status.set("Scanned %d audio files (%d MP3, %d M4A) - no problems found." % (res.n_audio, res.n_mp3, res.n_m4a))
                self.status_lbl.configure(fg=GOOD)
                self.set_empty("✓  No problems found - this folder looks good.")
            else:
                self.status.set("Scanned %d audio files (%d MP3, %d M4A): %d need fixing, %d Mac leftovers, %d optional." % (
                    res.n_audio, res.n_mp3, res.n_m4a, main, counts[CAT_JUNK], counts[CAT_MINOR]))
                self.status_lbl.configure(fg=TEXT)
                self.set_empty(None)
            self.set_bar(self.bar["maximum"])
            for e in res.errors[:20]:
                self.write_log("Couldn't read %s" % e)
            self.write_log("Scan finished: %s" % self.status.get())
            self.busy = False
            self.set_busy(False)

    root = tk.Tk()
    root._app = App(root)
    root.mainloop()


# --------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------
def run_cli(args):
    folder = os.path.abspath(args.folder)
    res = scan_folder(folder)
    print("Scanned %d audio files (%d MP3, %d M4A)" % (res.n_audio, res.n_mp3, res.n_m4a))
    for x in res.issues:
        print("  [%s] %s - %s" % (CATEGORY_LABELS[x.cat], x.rel, x.problem))
    for e in res.errors:
        print("  could not read", e)
    print("%d issue(s)" % len(res.issues))
    if args.fix:
        todo = [x for x in res.issues if CATEGORY_DEFAULT_ON[x.cat] or (args.minor and x.cat == CAT_MINOR)]
        bk = None if args.no_backup else default_backup_root(folder)
        ok = bad = 0
        for x in todo:
            try:
                print("  FIXED  ", x.rel, "-", fix_issue(x, folder, bk))
                ok += 1
            except Exception as ex:
                print("  SKIPPED", x.rel, "-", ex)
                bad += 1
        print("fixed %d, skipped %d%s" % (ok, bad, "; backup in " + bk if bk and ok else ""))
    return 0


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Find and fix Spotify local-file problems in a folder.")
    ap.add_argument("folder", nargs="?", help="folder to scan (opens the window pre-filled; with --scan/--fix runs without a window)")
    ap.add_argument("--scan", action="store_true", help="scan only, print the results, no window")
    ap.add_argument("--fix", action="store_true", help="scan and fix, no window")
    ap.add_argument("--no-backup", action="store_true", help="with --fix: don't keep backups")
    ap.add_argument("--minor", action="store_true", help="with --fix: also fix the optional minor tag tidy-ups")
    args = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):  # odd characters in file names must never crash printing
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    if args.folder and (args.scan or args.fix):
        sys.exit(run_cli(args))
    run_gui(args.folder)


if __name__ == "__main__":
    main()
