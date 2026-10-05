# Example project notes for agents

This example shows how generated media is expected to live in a Remotion project and how
the `hf` CLI is used around it. It performs no generation and no network access.

## Layout

```
examples/
├── AGENTS.md
├── shots.json
└── remotion-consumption.tsx
```

A real project keeps generated media beside the shot metadata:

```
projects/demo/
├── keyframes/           # approved source stills
├── assets/
│   └── shot-003/
│       ├── video.mp4
│       └── generation.json
└── shots.json
```

## Rules

- Generated assets are produced by `hf image` / `hf video` / `hf speak` and are always
  accompanied by `generation.json`. Never hand-edit media or invent an asset entry.
- Commit `shots.json` and the manifests; treat the media itself per the project's asset
  policy.
- Only shots with `"status": "approved"` are composed. `generated` means "exists and
  verified, not yet reviewed".
- Source (`staticFile`) paths in scene code point at local files only.
- Never place credentials in scene code, notes, or this file.

## Typical commands

```bash
# inventory what already exists
ls projects/demo/assets/*/generation.json

# validate a shot before paying
hf image --prompt "..." --preset landscape-hd --output projects/demo/assets/shot-003 --dry-run --json

# generate, then record the manifest path in shots.json
hf image --prompt "..." --preset landscape-hd --output projects/demo/assets/shot-003 --json
```

After a successful command, read `generation.json` and update the shot's `source.asset`
and `source.manifest`; set `status` to `generated`, then `approved` after review.
