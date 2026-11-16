# Local Files Fixer

Finds and fixes the hidden problems in `.mp3` / `.m4a` files that make Spotify **local files** grey out, refuse to play, or fail to match between your PC, Mac and phone.

Pick a folder, see exactly what's wrong, and fix it in one click. Originals are backed up first.

## What it fixes

| Problem | Why it breaks local files | Fix |
|---|---|---|
| **MP3 length header** | A hidden "Info" frame at the start of some MP3s is counted differently by different apps, so they disagree on the song's length (sometimes by a whole second, sometimes much more). Spotify includes the length in a local track's identity, so the playlist entry stops matching. | Remove that header frame. It holds no audio, so nothing audible changes. Variable-bitrate (Xing) files are never touched. |
| **M4A gapless tag** | An `iTunSMPB` tag that contradicts the song's real length. Macs read it and Windows ignores it, so the two disagree. | Rewrite the three numbers in that tag. Nothing else in the file changes. |
| **Mac leftovers** | `.DS_Store`, `__MACOSX` folders and `._` companion files can appear as broken tracks. | Remove them (moved to the backup folder). |
| **Minor tidy-up** *(optional, off by default)* | A gapless tag that is off by a frame or two. | Make the tag add up. |

## Safety

- Every change is written to a temporary file, verified, and only then swapped in.
- With **Back up originals** on (the default), each changed file is first copied to a `<folder> - backup <date time>` folder next to the one you chose.
- Anything that doesn't look exactly as expected is skipped and left untouched.

## Two versions

Both find and fix exactly the same things and produce byte-identical results.

### New look (Electron) - `electron-app/`

A rounded, Spotify-style window. Drag a folder onto it or use **Choose folder…**.

```bash
cd electron-app
npm install          # downloads Electron (a few hundred MB)
npx electron .       # opens the app
```

On Windows you can also double-click `Run Local Files Fixer (new look).bat` once `npm install` has run.

Command line, no window:

```bash
node electron-app/src/cli.js "D:\Music"            # list the problems
node electron-app/src/cli.js "D:\Music" --fix      # fix them (with backup)
# --no-backup skips backups, --minor includes the optional tidy-up
```

### Classic (Python) - `local_files_fixer.py`

A single file using only the Python 3 standard library plus tkinter.

```bash
python local_files_fixer.py
python local_files_fixer.py "D:\Music" --scan      # no window
python local_files_fixer.py "D:\Music" --fix
```

## How it was figured out

The fixes come from debugging a real library where tracks were greyed out in playlists on a second computer. In short: Spotify identifies a local file by its title, artist, album and **length in whole seconds**; when two apps compute a different length for the same file, the playlist entry stops matching. The scanner looks for the metadata that makes those lengths ambiguous.

## Notes

- Close Spotify first if a file can't be written.
- After fixing, restart Spotify, copy the fixed files to your other devices, and re-add the affected songs to your playlists.
- Not affiliated with Spotify.

## Main menu and Tag songs

Both apps now open on a main menu: **Fix local files** or **Tag songs**.

Tag songs matches each file to a public Google-Sheets song tracker (paste the link) by title and length, then writes title (versions as `V1`, `V2`), artist (features comma-separated), album (the era) and the era cover. It shows the matches first and backs up originals before writing. Needs `pip install mutagen`.

```bash
python tagger.py "<tracker link>" "D:\Music\folder"            # preview
python tagger.py "<tracker link>" "D:\Music\folder" --apply    # write tags
```
