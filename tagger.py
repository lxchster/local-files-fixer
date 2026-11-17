#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tagger: match audio files to rows of a public Google-Sheets song tracker and write
title / artist / album / cover art into the files.

    python tagger.py "<tracker link>" "<folder>"            # preview only
    python tagger.py "<tracker link>" "<folder>" --apply    # write tags (backs up first)
    multiple trackers: separate links with a comma or a newline, e.g.
        python tagger.py "<link 1>,<link 2>" "<folder>"
    add --json for machine-readable output, --no-backup to skip backups, --era "Name" to force an era

Needs:  pip install mutagen
"""
import csv
import difflib
import html as htmlmod
import io
import json
import os
import re
import shutil
import sys
import unicodedata
import urllib.request
import datetime

UA = {"User-Agent": "Mozilla/5.0 (LocalFilesFixer tagger)"}
AUDIO_EXT = {".mp3", ".m4a", ".wav"}
MAIN_ARTIST = "Playboi Carti"   # used when a row has no "Artist - " prefix


def _get(url, binary=False, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


# ------------------------------------------------------------------ tracker
def parse_link(link):
    m = re.search(r"/spreadsheets/d/([\w-]+)", link)
    if not m:
        raise ValueError("That doesn't look like a Google Sheets link.")
    g = re.search(r"[#&?]gid=(\d+)", link)
    return m.group(1), (g.group(1) if g else "0")


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def era_key(s):
    return norm(s)   # "Whole Lotta Red [V2]" and "Whole Lotta Red V2" both -> wholelottaredv2


_EMOJI = re.compile(
    "[🀀-🫿←-⇿⌀-⏿①-⓿■-➿⤀-⥿"
    "⬀-⯿〰〽㊗㊙︀-️‍⃣󠀠-󠁿]")


def strip_emoji(s):
    return re.sub(r"[ 	]{2,}", " ", _EMOJI.sub("", s or "")).strip()


def clean_era(s):
    s = strip_emoji(s)
    return re.sub(r"\s+", " ", re.sub(r"\[(V\d+)\]", r"\1", s)).strip()


def strip_lead(s):
    """Drop leading emoji / status symbols and trailing asterisks."""
    s = s.strip()
    i = 0
    while i < len(s) and not (s[i].isalnum() or s[i] in "([$@'\"#&"):
        i += 1
    s = s[i:].strip()
    return s.rstrip("*").strip()


def split_people(txt):
    out = []
    for p in re.split(r",|&|\band\b|\bx\b(?=\s)", txt):
        p = p.strip()
        if p and p not in out:
            out.append(p)
    return out


def _is_tracker_word(word):
    """True for 'tracker'/'trackers' once accents and stylised Unicode letters (e.g. 'Trackër',
    fullwidth or mathematical-alphabet letters) are folded back to plain ASCII."""
    plain = unicodedata.normalize("NFKD", word)
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    plain = re.sub(r"[^a-z]", "", plain.lower())
    return plain in ("tracker", "trackers")


def clean_artist_name(s):
    """Drop a stray 'Tracker'/'Trackers' word (any accented or stylised spelling) some sheet
    titles or rows carry alongside the artist."""
    words = [w for w in (s or "").split() if not _is_tracker_word(w)]
    return " ".join(words).strip(" -|:")


_AKA = re.compile(
    r"(?:also\s+known\s+as|a\.?k\.?a\.?|alternately\s+(?:titled|known\s+as)|alternatively\s+(?:titled|known\s+as)"
    r"|previously\s+(?:titled|known\s+as)|originally\s+(?:titled|named|called)|(?:was\s+)?(?:also\s+)?(?:titled|named|called))"
    r"\s*[:\-]?\s*[\"\u201c\u2018']([^\"\u201d\u2019'\n]{2,60})[\"\u201d\u2019']", re.I)


def find_alt_names(lines, notes, base_title):
    """Preferred-name choices: the parenthesised names under the features, else 'also known as' in the notes."""
    alts = []
    for l in lines[1:]:
        if re.match(r"^\(\s*(feat|ft|with|prod|ref|remix|cover)\b", l, re.I):
            continue
        m = re.fullmatch(r"\((.+)\)", l)
        if not m or re.search(r"\b(feat|prod)\.", m.group(1), re.I):
            continue
        for part in re.split(r"\s*,\s*", m.group(1)):
            part = part.strip(" \"'*")
            if part and part.lower() != base_title.lower() and part not in alts:
                alts.append(part)
    if not alts:
        for m in _AKA.finditer(notes or ""):
            part = m.group(1).strip()
            if part and part.lower() != base_title.lower() and part not in alts:
                alts.append(part)
    return alts


def parse_name_cell(cell, notes=""):
    """-> dict(title, artists[list], key_with_artist, key)"""
    lines = [l.strip() for l in strip_emoji(cell).replace("\r", "").split("\n") if l.strip()]
    first = strip_lead(lines[0]) if lines else ""
    rest = " ".join(lines[1:])
    prefix = None
    m = re.match(r"^(.+?)\s+-\s+(.+)$", first)
    if m:
        prefix, first = m.group(1).strip(), m.group(2).strip()
    # version: [V1] -> V1 ; [V?] dropped ; other bracket text -> plain words
    ver = None
    vm = re.search(r"\[\s*(V\d+)\s*\]", first, re.I)
    if vm:
        ver = vm.group(1).upper()
    base = re.sub(r"\[\s*V\d*\??\s*\]", "", first, flags=re.I)
    base = re.sub(r"\[([^\]]*)\]", r"\1", base)
    base = re.sub(r"\s+", " ", base).strip().rstrip("*").strip()
    title = f"{base} {ver}" if ver else base
    feats = []
    for fm in re.finditer(r"\((?:feat\.?|ft\.?|with)\s+([^)]*)\)", rest, re.I):
        feats += split_people(fm.group(1))
    artists = []
    for a in (split_people(prefix) if prefix else ([MAIN_ARTIST] if MAIN_ARTIST else [])) + feats:
        a = clean_artist_name(a)
        if a and a.lower() not in [x.lower() for x in artists]:
            artists.append(a)
    if prefix and MAIN_ARTIST and MAIN_ARTIST.lower() not in [x.lower() for x in artists] and re.search(re.escape(MAIN_ARTIST), rest, re.I):
        artists.append(MAIN_ARTIST)
    alts = [f"{a} {ver}" if ver else a for a in find_alt_names(lines, notes, base)]
    return {
        "title": title, "base": base, "ver": ver, "artists": artists, "alts": alts,
        "key": norm(title), "key_artist": norm((prefix or "") + title),
        "alt_keys": [norm(a) for a in alts],
    }


def parse_len(s):
    m = re.match(r"^\s*(\d+):(\d{2})(?::(\d{2}))?\s*$", s or "")
    if not m:
        return None
    a, b, c = int(m.group(1)), int(m.group(2)), m.group(3)
    return a * 3600 + b * 60 + int(c) if c else a * 60 + b


SKIP_TABS = ("art", "merch", "interview", "video", "tour", "social", "key", "buys", "tracklist",
             "compilation", "performance", "album copies", "fakes", "fan edit", "stem")


def parse_song_rows(rows):
    if not rows:
        return []
    hdr = [h.split("\n")[0].strip().lower() for h in rows[0]]

    def col(*names, default=None):
        for i, h in enumerate(hdr):
            if any(h.startswith(n) for n in names):
                return i
        return default
    c_name = col("name")
    if c_name is None:
        return []
    c_era = 0
    c_len = col("track length", "length")
    c_notes = col("notes")
    out = []
    for r in rows[1:]:
        if len(r) <= c_name or not r[c_name].strip() or not r[c_era].strip():
            continue
        p = parse_name_cell(r[c_name], r[c_notes] if c_notes is not None and len(r) > c_notes else "")
        if not p["title"]:
            continue
        if "\n" in r[c_era].strip() or re.search(r"Total (Full|Released)|OG File", r[c_era]):
            continue  # an era header row (its first cell is a stats block), not a song
        p["era"] = strip_emoji(r[c_era]).strip()
        p["len"] = parse_len(r[c_len]) if c_len is not None and len(r) > c_len else None
        p["raw"] = r[c_name].split("\n")[0]
        p["main_artist"] = MAIN_ARTIST
        out.append(p)
    return out


def list_tabs(sid):
    """[(gid, name)] of every tab, from the sheet's public HTML view."""
    try:
        h = _get(f"https://docs.google.com/spreadsheets/d/{sid}/htmlview", timeout=60)
    except Exception:
        return []
    return [(m.group(2), m.group(1).replace("\\x26", "&"))
            for m in re.finditer(r'items\.push\(\{name: "([^"]*)".*?gid: "(\d+)"', h)]


def sheet_artist(sid):
    """Guess the artist from the sheet's title, e.g. 'Playboi Carti Tracker [MAIN] - Google Drive'."""
    try:
        h = _get(f"https://docs.google.com/spreadsheets/d/{sid}/htmlview", timeout=60)
        t = htmlmod.unescape(re.search(r"<title>(.*?)</title>", h, re.S).group(1))
    except Exception:
        return ""
    t = re.sub(r"\s*-\s*Google (Drive|Sheets).*$", "", t)
    t = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", strip_emoji(t))
    t = re.sub(r"\b(song|songs|music|unreleased|leaks?|the|official|spreadsheet|sheet|tracker|trackers|archive|database|\d{4})\b", " ", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip(" -|:")


def load_tracker(link, progress=None, all_tabs=True, artist=None):
    global MAIN_ARTIST
    sid, gid = parse_link(link)
    say = progress or (lambda s: None)
    MAIN_ARTIST = clean_artist_name((artist or "").strip() or sheet_artist(sid) or MAIN_ARTIST) or MAIN_ARTIST
    say("Downloading tracker rows...")
    csv_txt = _get(f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?tqx=out:csv&gid={gid}")
    rows = list(csv.reader(io.StringIO(csv_txt)))
    if not rows:
        raise RuntimeError("The tracker tab came back empty (is the sheet shared publicly?).")
    songs = parse_song_rows(rows)
    order = [x for i, x in enumerate(e["era"] for e in songs) if i == 0 or x != songs[i - 1]["era"]]
    if all_tabs:
        tabs = [(g, n) for g, n in list_tabs(sid) if g != gid and not any(k in strip_emoji(n).lower() for k in SKIP_TABS)]
        for i, (g, n) in enumerate(tabs):
            say(f"Reading other tabs ({i + 1}/{len(tabs)}): {strip_emoji(n)}...")
            try:
                t = _get(f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?tqx=out:csv&gid={g}")
                songs += parse_song_rows(list(csv.reader(io.StringIO(t))))
            except Exception:
                pass
    say(f"{len(songs)} tracker rows. Looking up album covers...")
    covers = load_covers(sid, gid, order)
    return {"songs": songs, "covers": covers, "sid": sid, "gid": gid, "artist": MAIN_ARTIST,
            "tabs": [g for g, _ in list_tabs(sid)] if all_tabs else [gid], "scanned": {gid}}


def split_links(s):
    """'<link1>, <link2>\\n<link3>' -> ['<link1>', '<link2>', '<link3>']"""
    if not isinstance(s, str):
        return [l.strip() for l in s if l and l.strip()]
    return [l.strip() for l in re.split(r"[\n,]+", s) if l.strip()]


def load_trackers(links, progress=None, all_tabs=True, artist=None):
    """Load one or more tracker links and merge them into a single tracker (songs from every
    sheet, each still tagged with that sheet's own artist for album-artist purposes)."""
    links = split_links(links)
    if not links:
        raise ValueError("No tracker link given.")
    say = progress or (lambda s: None)
    songs, covers, sources, artists = [], {}, [], []
    for i, link in enumerate(links):
        lead = f"[{i + 1}/{len(links)}] " if len(links) > 1 else ""
        one = load_tracker(link, (lambda s, lead=lead: say(lead + s)) if progress else None, all_tabs, artist)
        songs += one["songs"]
        for k, v in one["covers"].items():
            covers.setdefault(k, v)
        sources.append({"sid": one["sid"], "gid": one["gid"], "tabs": one["tabs"], "scanned": one["scanned"]})
        a = clean_artist_name(one["artist"])
        if a and a not in artists:
            artists.append(a)
    return {"songs": songs, "covers": covers, "sources": sources, "artist": ", ".join(artists)}


def load_covers(sid, gid, era_order=None):
    """Era cover images live in the tab's HTML view: every era header row carries the cover image
    (the sheet just shows it squashed). Eras whose name is only part of a banner image are paired
    up with the song rows' era names by order."""
    covers = {}
    try:
        h = _get(f"https://docs.google.com/spreadsheets/d/{sid}/htmlview/sheet?headers=true&gid={gid}", timeout=120)
    except Exception:
        return covers
    def cell_text(c):
        return htmlmod.unescape(re.sub(r"<[^>]+>", "\n", c.replace("<br>", "\n")))

    pending = None   # a header whose era name is only inside a banner image: take it from the next song row
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if len(cells) < 2:
            continue
        is_head = "Total Full" in cells[0] or "Total Released" in cells[0]
        if not is_head:
            if pending is not None:
                era = next((l.strip() for l in cell_text(cells[0]).split("\n") if l.strip()), "")
                if era and not re.search(r"\d+ (Single|Total|OG)", era):
                    covers.setdefault(era_key(strip_emoji(era)), {"era": strip_emoji(era), "url": pending})
                    pending = None
            continue
        pending = None
        era = next((l.strip() for l in cell_text(cells[1]).split("\n") if l.strip()), "")
        cover = None
        for c in cells[2:6]:
            m = re.search(r'<img src="([^"]+sheets-images-rt[^"]+)"', c)
            if m:
                cover = re.sub(r"=w\d+-h\d+$", "=s1200", m.group(1))
        if not cover:
            continue
        if era:
            covers.setdefault(era_key(strip_emoji(era)), {"era": strip_emoji(era), "url": cover})
        else:
            pending = cover
    return covers


def scan_covers(h, known, covers):
    """Any row that carries an image and names a known era gives that era its cover (first hit wins)."""
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", h, re.S):
        if "sheets-images-rt" not in tr:
            continue
        cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        era = None
        for c in cells:
            for line in htmlmod.unescape(re.sub(r"<[^>]+>", "\n", c.replace("<br>", "\n"))).split("\n"):
                k = era_key(strip_emoji(line))
                if k in known and k not in covers:
                    era = (k, strip_emoji(line).strip())
                    break
            if era:
                break
        if not era:
            continue
        urls = re.findall(r'<img src="([^"]+sheets-images-rt[^"]+)"', tr)
        urls.sort(key=lambda u: 1 if "=w425" in u else 0)
        if urls:
            covers[era[0]] = {"era": era[1], "url": re.sub(r"=w\d+-h\d+$", "=s1200", urls[0])}


_STOP = {"the", "with", "era", "collab", "collaboration", "collaborations", "and", "of", "a", "feat"}


def _tokens(s):
    return {w for w in re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", s).lower()) if w not in _STOP}


def find_cover(tracker, era):
    """Cover for an era: exact name, else the closest era/header name on the sheet."""
    covers = tracker["covers"]
    k = era_key(era)
    if k in covers:
        return covers[k]
    want = _tokens(era)
    best, score = None, 0.0
    for key, c in covers.items():
        have = _tokens(c["era"])
        if want and have:
            sc = len(want & have) / float(len(want | have))
        else:
            sc = 0.0
        sc = max(sc, difflib.SequenceMatcher(None, k, key).ratio() - 0.2)
        if sc > score:
            best, score = c, sc
    return best if score >= 0.5 else None


def ensure_covers(tracker, eras):
    """Make sure every era in `eras` has a cover; look through the other tabs of each loaded
    sheet if needed."""
    known = {era_key(e) for e in eras}
    covers = tracker["covers"]
    for src in tracker.get("sources", []):
        if known <= set(covers):
            break
        for g in [src["gid"]] + [x for x in src.get("tabs", []) if x != src["gid"]]:
            if known <= set(covers):
                break
            if g in src["scanned"] and g != src["gid"]:
                continue
            try:
                h = _get(f"https://docs.google.com/spreadsheets/d/{src['sid']}/htmlview/sheet?headers=true&gid={g}", timeout=120)
            except Exception:
                continue
            src["scanned"].add(g)
            scan_covers(h, known, covers)


# ------------------------------------------------------------------ matching
def file_stem_info(path):
    stem = os.path.splitext(os.path.basename(path))[0]
    stem = strip_emoji(unicodedata.normalize("NFC", stem))
    stem = strip_lead(stem.replace("_", "*") if stem.rstrip().endswith("_") else stem)
    stem = re.sub(r"^\d+[-.]?\d*\s+", "", stem)  # leading track numbers like "01 " / "1-02 "
    v = re.sub(r"\[\s*(V\d+)\s*\]", r"\1", stem, flags=re.I)
    v = re.sub(r"\[([^\]]*)\]", r"\1", v)
    return {"stem": stem, "key": norm(v)}


def audio_length(path):
    try:
        from mutagen import File
        m = File(path)
        return m.info.length if m is not None else None
    except Exception:
        return None


def _strip_ver(k):
    return re.sub(r"v\d+$", "", k)


def _overlaps(a, b, min_len=4):
    """True if one of a/b contains the other - e.g. a file name padded with a track number or a
    tracker title padded with '(Full Version)'. Too short to be meaningful below min_len."""
    if not a or not b or len(a) < min_len or len(b) < min_len:
        return a == b
    return a in b or b in a


def match_file(path, tracker, era_hint=None):
    info = file_stem_info(path)
    dur = audio_length(path)
    songs = tracker["songs"]
    key = info["key"]
    cands = [s for s in songs if key in (s["key"], s["key_artist"])]
    how = "name"
    if not cands:
        cands = [s for s in songs if key in s.get("alt_keys", [])]
        if cands:
            how = "alternate name"
    if not cands:  # same name without a version number on either side
        nov = _strip_ver(key)
        cands = [s for s in songs if nov and nov in (_strip_ver(s["key"]), _strip_ver(s["key_artist"]))]
        how = "name (version differs)"
        if not cands:
            cands = [s for s in songs if nov and any(nov == _strip_ver(k) for k in s.get("alt_keys", []))]
            if cands:
                how = "alternate name (version differs)"
    if not cands:  # the song title is inside the file name, or the file name is inside the title
        cands = [s for s in songs if _overlaps(key, s["key"]) or _overlaps(key, s["key_artist"])
                 or any(_overlaps(key, k) for k in s.get("alt_keys", []))]
        if cands:
            how = "name contains / is within the tracker title"
    if not cands:
        keys = {}
        for s in songs:
            keys.setdefault(s["key"], s)
            keys.setdefault(s["key_artist"], s)
            for k in s.get("alt_keys", []):
                keys.setdefault(k, s)
        close = difflib.get_close_matches(key, list(keys), n=3, cutoff=0.86)
        cands = [keys[k] for k in close]
        how = "close name"
    if not cands:
        return None, "no song with that name on the tracker", None

    def score(s):
        sc = 0.0
        if era_hint and era_key(s["era"]) == era_hint:
            sc -= 1000
        if dur and s["len"]:
            sc += min(abs(dur - s["len"]), 60)
        elif s["len"] is None:
            sc += 30
        if key not in (s["key"], s["key_artist"], *s.get("alt_keys", [])):
            sc += 5
        return sc
    cands.sort(key=score)
    best = cands[0]
    note = how
    if dur and best["len"]:
        d = abs(dur - best["len"])
        note += f", length {int(dur//60)}:{int(dur%60):02d} vs tracker {best['len']//60}:{best['len']%60:02d}"
        if d > 6:
            note += " (differs)"
    if len({(c["era"], c["title"], tuple(c["artists"])) for c in cands if score(c) == score(best)}) > 1:
        note += f", {len(cands)} similar rows - picked first"
    return best, note, dur


def list_audio(folder):
    out = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d != "__MACOSX"]
        for f in sorted(files):
            if f.startswith("._"):
                continue
            if os.path.splitext(f)[1].lower() in AUDIO_EXT:
                out.append(os.path.join(root, f))
    return out


def plan(tracker, folder, era=None):
    """Build the tagging plan without touching any file."""
    folder = os.path.abspath(folder)
    hint = era_key(era) if era else era_key(os.path.basename(folder))
    items = []
    matched = [(p,) + match_file(p, tracker, hint) for p in list_audio(folder)]
    ensure_covers(tracker, {m[1]["era"] for m in matched if m[1]})
    for p, song, note, dur in matched:
        it = {"path": p, "rel": os.path.relpath(p, folder), "note": note}
        if song:
            era_name = clean_era(song["era"])
            cov = find_cover(tracker, song["era"])
            it.update(title=song["title"], alts=song.get("alts", []), artist=", ".join(song["artists"]), album=era_name,
                      album_artist=song.get("main_artist") or MAIN_ARTIST,
                      cover=cov["url"] if cov else None, matched=True)
        else:
            it.update(matched=False)
        items.append(it)
    return items


# ------------------------------------------------------------------ writing
_cover_cache = {}


def fetch_cover(url):
    if url not in _cover_cache:
        if os.path.isfile(url):          # a cover image chosen by hand
            data = open(url, "rb").read()
        else:
            data = _get(url, binary=True)
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            mime = "image/png"
        elif data[:2] == b"\xff\xd8":
            mime = "image/jpeg"
        else:
            raise RuntimeError("unsupported cover image format (use a JPG or PNG)")
        _cover_cache[url] = (data, mime)
    return _cover_cache[url]


_mutagen_checked = False


def _ensure_mutagen():
    """Install the mutagen package on the fly (once per run), so nobody has to run pip by hand."""
    global _mutagen_checked
    if _mutagen_checked:
        return
    try:
        import mutagen  # noqa: F401
    except ImportError:
        import subprocess
        base = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check"]
        for extra in (["--user"], []):  # --user fails inside a venv; plain install fails outside one
            try:
                subprocess.run(base + extra + ["mutagen"], check=True, capture_output=True)
                import importlib
                importlib.invalidate_caches()
                break
            except Exception:
                continue
    _mutagen_checked = True


def write_tags(item):
    _ensure_mutagen()
    from mutagen import File
    from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TPE2, TALB, APIC
    from mutagen.mp4 import MP4, MP4Cover
    from mutagen.wave import WAVE
    path, ext = item["path"], os.path.splitext(item["path"])[1].lower()
    cover = fetch_cover(item["cover"]) if item.get("cover") else None
    album_artist = item.get("album_artist") or MAIN_ARTIST
    if ext == ".m4a":
        m = MP4(path)
        if m.tags is None:
            m.add_tags()
        m["\xa9nam"], m["\xa9ART"], m["\xa9alb"], m["aART"] = [item["title"]], [item["artist"]], [item["album"]], [album_artist]
        if cover:
            m["covr"] = [MP4Cover(cover[0], MP4Cover.FORMAT_PNG if cover[1] == "image/png" else MP4Cover.FORMAT_JPEG)]
        m.save()
        return
    if ext == ".mp3":
        try:
            t = ID3(path)
        except ID3NoHeaderError:
            t = ID3()
    else:
        w = WAVE(path)
        if w.tags is None:
            w.add_tags()
        t = w.tags
    for fid in ("TIT2", "TPE1", "TPE2", "TALB"):
        t.delall(fid)
    t.add(TIT2(encoding=3, text=item["title"]))
    t.add(TPE1(encoding=3, text=item["artist"]))
    t.add(TPE2(encoding=3, text=album_artist))
    t.add(TALB(encoding=3, text=item["album"]))
    if cover:
        t.delall("APIC")
        t.add(APIC(encoding=3, mime=cover[1], type=3, desc="Cover", data=cover[0]))
    if ext == ".mp3":
        t.save(path, v2_version=3)
    else:
        w.save()


def default_backup_root(folder):
    folder = os.path.abspath(folder)
    st = datetime.datetime.now().strftime("%Y-%m-%d %H%M%S")
    return os.path.join(os.path.dirname(folder), f"{os.path.basename(folder)} - tag backup {st}")


def apply_cover(items, path):
    """Use one image the user picked as the cover for every matched file."""
    if path:
        for it in items:
            if it.get("matched"):
                it["cover"] = path


def apply_overrides(items, overrides):
    """A string override renames a matched file; a {title, artist, album} override hand-tags a
    file the tracker couldn't match (title is required, artist/album may be left blank)."""
    for it in items:
        o = (overrides or {}).get(it["rel"])
        if not o:
            continue
        if isinstance(o, str):
            if it.get("matched"):
                it["title"] = o
            continue
        title = (o.get("title") or "").strip()
        if not title:
            continue
        it["title"] = title
        it["artist"] = (o.get("artist") or "").strip()
        it["album"] = (o.get("album") or "").strip()
        it["matched"] = True


def apply(items, folder, backup=True, log=None):
    log = log or print
    root = default_backup_root(folder) if backup else None
    ok = bad = 0
    for it in items:
        if not it.get("matched"):
            continue
        try:
            if root:
                dst = os.path.join(root, it["rel"])
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(it["path"], dst)
            write_tags(it)
            ok += 1
            log(f"TAGGED  {it['rel']} -> {it['artist']} - {it['title']} [{it['album']}]" + ("" if it.get("cover") else " (no cover found)"))
        except Exception as e:
            bad += 1
            log(f"FAILED  {it['rel']} - {e}")
    return {"ok": ok, "bad": bad, "backup": root if ok and root else None}


# ------------------------------------------------------------------ CLI
def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    era = None
    if "--era" in argv:
        era = argv[argv.index("--era") + 1]
        args = [a for a in args if a != era]
    if len(args) < 2:
        print(__doc__)
        return 2
    if "--overrides" in argv:
        args = [a for a in args if a != argv[argv.index("--overrides") + 1]]
    if "--cover" in argv:
        args = [a for a in args if a != argv[argv.index("--cover") + 1]]
    if "--artist" in argv:
        artist = argv[argv.index("--artist") + 1]
        args = [a for a in args if a != artist]
    else:
        artist = None
    link_arg, folder = args[0], args[1]
    as_json = "--json" in flags
    tr = load_trackers(link_arg, None if as_json else (lambda s: print(s, file=sys.stderr)), artist=artist)
    items = plan(tr, folder, era)
    if "--overrides" in argv:
        apply_overrides(items, json.loads(argv[argv.index("--overrides") + 1]))
    if "--cover" in argv:
        apply_cover(items, argv[argv.index("--cover") + 1])
    result = {"items": items, "artists": [a for a in tr["artist"].split(", ") if a]}
    if "--apply" in flags:
        result["result"] = apply(items, folder, "--no-backup" not in flags, (lambda s: None) if as_json else print)
    if as_json:
        print(json.dumps(result, ensure_ascii=False))
    elif "--apply" not in flags:
        for it in items:
            if it["matched"]:
                print(f"{it['rel']}\n    -> {it['artist']} - {it['title']}  |  {it['album']}  |  cover: {'yes' if it['cover'] else 'NO'}  ({it['note']})")
            else:
                print(f"{it['rel']}\n    -> NO MATCH ({it['note']})")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main(sys.argv[1:]))
