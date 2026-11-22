// The one place every command is described: name, API path, flags, help text, examples.
// main.js parses with it, `garmo --help` prints it, and the docs page and npm README are made from it.
// test/spec.test.js checks every API parameter here against api/openapi.json (made from scripts/api/spec.py).

export const VERSION = '0.9.3';

const SCENES = ['white', 'beige', 'grey', 'sage', 'lobby', 'cafe', 'gallery', 'living', 'paris', 'terrace', 'coast', 'desert', 'lake', 'marble', 'linen', 'wood', 'stone'];
const POSES = ['standing', 'three', 'side', 'back', 'walking', 'seated', 'pockets', 'leaning'];

/**
 * A flag of a tool command.
 *   param: the API parameter it fills. kind: string | int | bool | list | hex | image | images.
 *   enum: allowed values (each item for a list). file: the multipart field a local file goes in (image kinds).
 */

/** The eight tool commands. images(opts) and credits(opts) give what one photo makes and costs, before asking. */
export const TOOLS = [
  {
    name: 'generate', path: '/generate', tool: 'generate',
    summary: 'New photos from one product photo: product shots in a setting, or worn by a model.',
    flags: {
      prompt: { param: 'prompt', kind: 'string', max: 500, help: 'What you want, in any language (setting, light, props, mood)' },
      count: { param: 'count', kind: 'int', min: 1, max: 4, help: 'Images per photo, 1 to 4 (default 1)' },
      model: { param: 'model', kind: 'string', help: 'Put it on a model: an id from `garmo models`, custom_<id>, or auto' },
      category: { param: 'category', kind: 'string', enum: ['clothing', 'shoes', 'jewelry'], needs: 'model', help: 'With --model: what the product is' },
      scene: { param: 'scene', kind: 'string', enum: ['auto', 'studio', 'street', 'editorial'], needs: 'model', help: 'With --model: the place' },
      gender: { param: 'gender', kind: 'string', enum: ['female', 'male'], needs: 'model', help: 'With --model auto: who wears it' },
      ratio: { param: 'aspect_ratio', kind: 'string', enum: ['3:4', '2:3', '1:1', '4:5', '9:16'], help: 'Shape of the images (default 3:4)' },
    },
    images: (o) => o.count ?? 1,
    credits: (o) => o.count ?? 1,
    examples: ['garmo generate dress.jpg --prompt "a sunlit stone colonnade" --count 2', 'garmo generate ./dresses/ --model auto --scene street'],
  },
  {
    name: 'remove-bg', path: '/edit/remove-background', tool: 'remove-background',
    summary: 'Cut the product or model out: transparent, white or a color of your choice.',
    flags: {
      bg: { param: 'background', kind: 'string', enum: ['transparent', 'white', 'color'], help: 'What it sits on (default transparent)' },
      hex: { param: 'color_hex', kind: 'hex', help: 'The color with --bg color, like "#efe8dc"' },
      shadow: { param: 'shadow', kind: 'bool', help: 'A soft contact shadow (white and color backgrounds)' },
    },
    check: (o) => (o.bg === 'color' && !o.hex ? '--bg color needs --hex' : o.hex && o.bg !== 'color' ? '--hex needs --bg color' : null),
    images: () => 1,
    credits: () => 1,
    examples: ['garmo remove-bg ./products/ -o ./clean/', 'garmo remove-bg "shoot/*.jpg" --bg white --shadow'],
  },
  {
    name: 'background', path: '/edit/background', tool: 'background',
    summary: 'Keep the subject, put it somewhere new: a studio color, an interior, a street or a surface.',
    flags: {
      scene: { param: 'scenes', kind: 'list', enum: SCENES, help: 'Scene ids, comma-separated (see `garmo scenes`)' },
      describe: { param: 'description', kind: 'string', max: 300, help: 'Your own scene in words' },
      'scene-photo': { param: 'scene_image_url', kind: 'image', file: 'scene_image', help: 'A photo (file or https URL) of the place to use' },
      format: { param: 'format', kind: 'string', enum: ['same', 'square', 'portrait', 'story'], help: 'Shape of the result (default same)' },
    },
    check: (o) => (!o.scene && !o.describe && !o['scene-photo'] ? 'give --scene, --describe or --scene-photo' : null),
    images: (o) => (o.scene?.length ?? 0) + (o.describe || o['scene-photo'] ? 1 : 0),
    credits: (o) => (o.scene?.length ?? 0) + (o.describe || o['scene-photo'] ? 1 : 0),
    examples: ['garmo background bag.jpg --scene white,cafe', 'garmo background ./looks/ --describe "a sunlit concrete loft" --format portrait'],
  },
  {
    name: 'color', path: '/edit/color', tool: 'color',
    summary: 'Recolor one garment to an exact hex color, keeping fabric, folds and print.',
    flags: {
      hex: { param: 'color_hex', kind: 'hex', required: true, help: 'The new color, like "#c8553d" (required)' },
      name: { param: 'color_name', kind: 'string', max: 40, help: 'A name for the color, like terracotta' },
      garment: { param: 'garment', kind: 'string', max: 40, help: 'Which garment when there are several, like dress' },
    },
    images: () => 1,
    credits: () => 1,
    examples: ['garmo color dress.jpg --hex "#1f3a5f" --name navy', 'garmo color ./tees/ --hex c8553d --garment t-shirt'],
  },
  {
    name: 'pose', path: '/edit/pose', tool: 'pose',
    summary: 'The same model, outfit and place in other poses: back, side, walking, seated and more.',
    flags: {
      pose: { param: 'poses', kind: 'list', enum: POSES, help: 'Pose ids, comma-separated (see `garmo poses`)' },
      framing: { param: 'framing', kind: 'string', enum: ['full', 'knee', 'waist'], help: 'How much of the model is in frame (default full)' },
      describe: { param: 'description', kind: 'string', max: 200, help: 'A pose of your own in words' },
      'pose-photo': { param: 'pose_image_url', kind: 'image', file: 'pose_image', help: 'A photo (file or https URL) of someone in the pose' },
      'back-photo': { param: 'back_image_urls', kind: 'images', file: 'back_images[]', max: 2, help: 'Up to 2 photos of the real back of the garment (repeat the flag)' },
    },
    check: (o) => (!o.pose && !o.describe && !o['pose-photo'] ? 'give --pose, --describe or --pose-photo' : null),
    images: (o) => (o.pose?.length ?? 0) + (o.describe || o['pose-photo'] ? 1 : 0),
    credits: (o) => (o.pose?.length ?? 0) + (o.describe || o['pose-photo'] ? 1 : 0),
    examples: ['garmo pose look.jpg --pose back,walking', 'garmo pose ./looks/ --pose side --framing knee'],
  },
  {
    name: 'model-swap', path: '/edit/model-swap', tool: 'model-swap',
    summary: 'Replace the person in an on-model photo, keeping outfit, pose, framing and light.',
    flags: {
      models: { param: 'models', kind: 'list', required: true, help: 'Model ids, comma-separated (see `garmo models`) (required)' },
    },
    images: (o) => o.models?.length ?? 0,
    credits: (o) => o.models?.length ?? 0,
    examples: ['garmo model-swap look.jpg --models amara,emma'],
  },
  {
    name: 'ghost', path: '/edit/ghost-mannequin', tool: 'ghost-mannequin',
    summary: 'Turn a garment photo into an invisible-mannequin product shot.',
    flags: {
      bg: { param: 'background', kind: 'string', max: 200, help: 'The background in a few words (default a light studio)' },
    },
    images: () => 1,
    credits: () => 1,
    examples: ['garmo ghost ./shirts/ --bg "pure white"'],
  },
  {
    name: 'upscale', path: '/edit/upscale', tool: 'upscale',
    summary: 'Sharpen a product photo to 2048 or 4096 px, restoring fabric and material detail.',
    flags: {
      res: { param: 'resolution', kind: 'string', enum: ['2k', '4k'], help: 'Long side: 2k = 2048 px, 4k = 4096 px (default 2k)' },
      detail: { param: 'detail', kind: 'string', enum: ['enhanced', 'natural'], help: 'enhanced restores detail, natural only sharpens (default enhanced)' },
    },
    images: () => 1,
    credits: (o) => (o.res === '4k' ? 2 : 1),
    examples: ['garmo upscale ./catalog/ --res 4k -o ./hi-res/'],
  },
];

export const TOOL = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Flags every tool command takes. */
export const BATCH_FLAGS = {
  out: { short: 'o', kind: 'string', help: 'Output folder (default ./garmo-out)' },
  recursive: { short: 'r', kind: 'bool', help: 'Also read photos in subfolders' },
  concurrency: { kind: 'int', min: 1, max: 50, help: 'Images rendering at once (default: your key’s limit)' },
  'dry-run': { kind: 'bool', help: 'Send nothing: list the photos, the credits it would take and your balance' },
  yes: { short: 'y', kind: 'bool', help: 'Do not ask before spending credits (for scripts and CI)' },
  'no-wait': { kind: 'bool', help: 'Start the jobs and print their ids; fetch them later with `garmo jobs <id> --download`' },
  overwrite: { kind: 'bool', help: 'Replace output files that already exist (default: keep them)' },
  'sku-from-name': { kind: 'bool', help: 'Send each file name as metadata.sku' },
};

/** Flags every command takes. */
export const GLOBAL_FLAGS = {
  json: { kind: 'bool', help: 'One JSON object per line on stdout (for scripts and agents)' },
  'key-file': { kind: 'string', help: 'Read the API key from this file' },
  verbose: { kind: 'bool', help: 'Print each request' },
  help: { short: 'h', kind: 'bool', help: 'Show help' },
  version: { short: 'v', kind: 'bool', help: 'Show the version' },
};

/** The other commands. */
export const OTHER = [
  { name: 'login', summary: 'Save your API key (asked hidden, or --with-token from stdin)', usage: 'garmo login [--with-token]', flags: { 'with-token': { kind: 'bool', help: 'Read the key from stdin' } } },
  { name: 'logout', summary: 'Delete the saved key from this computer', usage: 'garmo logout' },
  { name: 'whoami', summary: 'The key in use, its mode, tier, limits and balance', usage: 'garmo whoami' },
  { name: 'credits', summary: 'Your API credit balance', usage: 'garmo credits' },
  { name: 'models', summary: 'Model ids for --model and --models', usage: 'garmo models' },
  { name: 'scenes', summary: 'Scene ids for background --scene', usage: 'garmo scenes' },
  { name: 'poses', summary: 'Pose ids for pose --pose', usage: 'garmo poses' },
  {
    name: 'jobs', summary: 'Your recent jobs, or one job (and its images with --download)', usage: 'garmo jobs [job_id] [--download] [-o dir]',
    flags: { download: { kind: 'bool', help: 'Download the job’s images' }, out: { short: 'o', kind: 'string', help: 'Folder for --download (default ./garmo-out)' }, status: { kind: 'string', enum: ['processing', 'completed', 'failed', 'canceled'], help: 'Only jobs with this status' }, limit: { kind: 'int', min: 1, max: 100, help: 'How many (default 20)' }, overwrite: BATCH_FLAGS.overwrite },
  },
  { name: 'cancel', summary: 'Stop a job; images not yet made are refunded', usage: 'garmo cancel <job_id>' },
];

/** Exit codes, as the docs list them. */
export const EXIT = { ok: 0, partial: 1, usage: 2, auth: 3, credits: 4 };
