# @garmo/cli

**Bulk background removal, upscaling and AI product photos from the terminal.** Point it at a folder of product
photos and get a folder of results back: cut-outs on transparent, white or any color, 4K upscales, recolored
garments, new scenes and poses, model swaps and ghost-mannequin shots, for ten photos or a thousand.

```bash
npx @garmo/cli login                             # once: your Garmo API key, asked hidden
npx @garmo/cli remove-bg ./products/ -o ./clean/ --bg white --shadow
npx @garmo/cli upscale ./catalog/ --res 4k
npx @garmo/cli credits
```

Using it often? Install it once with `npm i -g @garmo/cli` and the command is just `garmo`:
`garmo remove-bg ./products/`. The examples below use that short form.

- **Safe to stop and repeat.** Ctrl+C, a crash or a closed laptop: run the same command again and it carries on.
  The same photo with the same settings is never charged twice.
- **Asks before it spends**, shows the credits first, and `--dry-run` sends nothing.
- **For scripts and AI agents:** `--json` prints one event per line; exit codes say what happened.
- **No dependencies, no install scripts, no telemetry.** Needs Node.js 20.3 or newer. macOS, Windows, Linux.

It uses the [Garmo API](https://garmo.studio/api/) and spends API credits (1 credit per image, 2 for a 4K upscale;
failed images are refunded). A free test key runs every command and returns your own photo, so you can try the
whole flow first. Get a key at [garmo.studio](https://garmo.studio/api/).

Full documentation: https://garmo.studio/api/docs/cli/

## Tools

| Command | What it does |
|---|---|
| `garmo generate` | New photos from one product photo: product shots in a setting, or worn by a model. |
| `garmo remove-bg` | Cut the product or model out: transparent, white or a color of your choice. |
| `garmo background` | Keep the subject, put it somewhere new: a studio color, an interior, a street or a surface. |
| `garmo color` | Recolor one garment to an exact hex color, keeping fabric, folds and print. |
| `garmo pose` | The same model, outfit and place in other poses: back, side, walking, seated and more. |
| `garmo model-swap` | Replace the person in an on-model photo, keeping outfit, pose, framing and light. |
| `garmo ghost` | Turn a garment photo into an invisible-mannequin product shot. |
| `garmo upscale` | Sharpen a product photo to 2048 or 4096 px, restoring fabric and material detail. |

### garmo generate

New photos from one product photo: product shots in a setting, or worn by a model.

| Flag | |
|---|---|
| `--prompt <value>` | What you want, in any language (setting, light, props, mood) |
| `--count <n>` | Images per photo, 1 to 4 (default 1) |
| `--model <value>` | Put it on a model: an id from `garmo models`, custom_<id>, or auto |
| `--category <clothing\|shoes\|jewelry>` | With --model: what the product is |
| `--scene <auto\|studio\|street\|editorial>` | With --model: the place |
| `--gender <female\|male>` | With --model auto: who wears it |
| `--ratio <3:4\|2:3\|1:1\|4:5\|9:16>` | Shape of the images (default 3:4) |

```bash
garmo generate dress.jpg --prompt "a sunlit stone colonnade" --count 2
garmo generate ./dresses/ --model auto --scene street
```

### garmo remove-bg

Cut the product or model out: transparent, white or a color of your choice.

| Flag | |
|---|---|
| `--bg <transparent\|white\|color>` | What it sits on (default transparent) |
| `--hex <value>` | The color with --bg color, like "#efe8dc" |
| `--shadow` | A soft contact shadow (white and color backgrounds) |

```bash
garmo remove-bg ./products/ -o ./clean/
garmo remove-bg "shoot/*.jpg" --bg white --shadow
```

### garmo background

Keep the subject, put it somewhere new: a studio color, an interior, a street or a surface.

| Flag | |
|---|---|
| `--scene <white\|beige\|grey\|sage\|lobby\|cafe\|gallery\|living\|paris\|terrace\|coast\|desert\|lake\|marble\|linen\|wood\|stone>` | Scene ids, comma-separated (see `garmo scenes`) |
| `--describe <value>` | Your own scene in words |
| `--scene-photo <value>` | A photo (file or https URL) of the place to use |
| `--format <same\|square\|portrait\|story>` | Shape of the result (default same) |

```bash
garmo background bag.jpg --scene white,cafe
garmo background ./looks/ --describe "a sunlit concrete loft" --format portrait
```

### garmo color

Recolor one garment to an exact hex color, keeping fabric, folds and print.

| Flag | |
|---|---|
| `--hex <value>` | The new color, like "#c8553d" (required) (required) |
| `--name <value>` | A name for the color, like terracotta |
| `--garment <value>` | Which garment when there are several, like dress |

```bash
garmo color dress.jpg --hex "#1f3a5f" --name navy
garmo color ./tees/ --hex c8553d --garment t-shirt
```

### garmo pose

The same model, outfit and place in other poses: back, side, walking, seated and more.

| Flag | |
|---|---|
| `--pose <standing\|three\|side\|back\|walking\|seated\|pockets\|leaning>` | Pose ids, comma-separated (see `garmo poses`) |
| `--framing <full\|knee\|waist>` | How much of the model is in frame (default full) |
| `--describe <value>` | A pose of your own in words |
| `--pose-photo <value>` | A photo (file or https URL) of someone in the pose |
| `--back-photo <value>` | Up to 2 photos of the real back of the garment (repeat the flag) |

```bash
garmo pose look.jpg --pose back,walking
garmo pose ./looks/ --pose side --framing knee
```

### garmo model-swap

Replace the person in an on-model photo, keeping outfit, pose, framing and light.

| Flag | |
|---|---|
| `--models <a,b>` | Model ids, comma-separated (see `garmo models`) (required) (required) |

```bash
garmo model-swap look.jpg --models amara,emma
```

### garmo ghost

Turn a garment photo into an invisible-mannequin product shot.

| Flag | |
|---|---|
| `--bg <value>` | The background in a few words (default a light studio) |

```bash
garmo ghost ./shirts/ --bg "pure white"
```

### garmo upscale

Sharpen a product photo to 2048 or 4096 px, restoring fabric and material detail.

| Flag | |
|---|---|
| `--res <2k\|4k>` | Long side: 2k = 2048 px, 4k = 4096 px (default 2k) |
| `--detail <enhanced\|natural>` | enhanced restores detail, natural only sharpens (default enhanced) |

```bash
garmo upscale ./catalog/ --res 4k -o ./hi-res/
```

## Photos in, files out

Give files, folders (`-r` for subfolders), patterns in quotes like `"shoot/**/*.jpg"` (expanded by garmo, also on
Windows), https URLs, or `-` to read paths from stdin. JPEG, PNG and WebP up to 12 MB. Results go to `-o`
(default `./garmo-out`) as `<name>-<tool>-<label>.<ext>`.

## Flags for every tool command

| Flag | |
|---|---|
| `-o`, `--out <value>` | Output folder (default ./garmo-out) |
| `-r`, `--recursive` | Also read photos in subfolders |
| `--concurrency <n>` | Images rendering at once (default: your key’s limit) |
| `--dry-run` | Send nothing: list the photos, the credits it would take and your balance |
| `-y`, `--yes` | Do not ask before spending credits (for scripts and CI) |
| `--no-wait` | Start the jobs and print their ids; fetch them later with `garmo jobs <id> --download` |
| `--overwrite` | Replace output files that already exist (default: keep them) |
| `--sku-from-name` | Send each file name as metadata.sku |

## Account and jobs

| Command | |
|---|---|
| `garmo login [--with-token]` | Save your API key (asked hidden, or --with-token from stdin) |
| `garmo logout` | Delete the saved key from this computer |
| `garmo whoami` | The key in use, its mode, tier, limits and balance |
| `garmo credits` | Your API credit balance |
| `garmo models` | Model ids for --model and --models |
| `garmo scenes` | Scene ids for background --scene |
| `garmo poses` | Pose ids for pose --pose |
| `garmo jobs [job_id] [--download] [-o dir]` | Your recent jobs, or one job (and its images with --download) |
| `garmo cancel <job_id>` | Stop a job; images not yet made are refunded |

## Flags for every command

| Flag | |
|---|---|
| `--json` | One JSON object per line on stdout (for scripts and agents) |
| `--key-file <value>` | Read the API key from this file |
| `--verbose` | Print each request |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show the version |

## The key

`garmo login` saves the key in `~/.config/garmo/config.json` (Windows: `%APPDATA%\garmo\config.json`), readable
only by you. `GARMO_API_KEY` and `--key-file` take precedence. There is no `--key` flag, so the key never lands in
your shell history, and it is only ever sent to `https://api.garmo.studio`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every photo done |
| 1 | Some photos failed, were not images, or are still rendering |
| 2 | Wrong command or flag; nothing was sent |
| 3 | No key, a wrong or revoked key, or no API pack |
| 4 | Out of API credits; buy more and run the same command again |

Version 0.9.0. MIT license.
