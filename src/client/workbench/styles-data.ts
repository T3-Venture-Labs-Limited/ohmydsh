// Studio's own curated style prompts: original text written for Studio (no third-party prompt text or images).
// `{subject}` is replaced by the user's subject. `aspect` is a hint applied when the model offers that ratio.
export interface StylePrompt {
  id: string
  name: string
  category: 'Photography' | 'Illustration' | 'Design' | '3D & Render' | 'Painting' | 'Cinematic' | 'Product'
  prompt: string
  negative?: string
  aspect?: string
  tags: string[]
}

export const STYLE_CATEGORIES = ['Photography', 'Illustration', 'Design', '3D & Render', 'Painting', 'Cinematic', 'Product'] as const

export const STYLES: readonly StylePrompt[] = [
  { id: 'portrait-natural', name: 'Natural light portrait', category: 'Photography', aspect: '3:4', tags: ['portrait', 'photo'],
    prompt: '{subject}, candid portrait photograph by a window with soft overcast daylight, 85mm lens at f/1.8, shallow depth of field, natural skin texture with visible pores, gentle catchlights, muted neutral colour grade, unposed expression.',
    negative: 'plastic skin, over-smoothing, harsh flash, extra fingers' },
  { id: 'street-35mm', name: '35mm street film', category: 'Photography', aspect: '3:2', tags: ['film', 'street', 'grain'],
    prompt: '{subject}, shot on 35mm colour negative film, a documentary street photograph at golden hour, mild halation around highlights, organic grain, slightly faded blacks, off-centre composition, a sense of a moment caught in passing.' },
  { id: 'macro-nature', name: 'Macro nature', category: 'Photography', aspect: '1:1', tags: ['macro', 'nature'],
    prompt: '{subject}, extreme macro photograph, dew drops and fine surface detail in razor focus, creamy blurred green background, soft diffused morning light, focus-stacked sharpness, rich natural colour.' },
  { id: 'aerial-landscape', name: 'Aerial landscape', category: 'Photography', aspect: '16:9', tags: ['landscape', 'drone'],
    prompt: '{subject}, high-altitude drone photograph looking straight down, geometric patterns of land and water, long shadows from low sun, subtle haze, crisp detail, calm earthy palette with one accent colour.' },
  { id: 'noir-night', name: 'Neon noir night', category: 'Photography', aspect: '2:3', tags: ['night', 'neon', 'city'],
    prompt: '{subject}, rain-soaked city street at night, reflections of pink and teal neon on wet asphalt, shallow depth of field, steam rising from vents, cinematic contrast with deep shadows, a lone figure for scale.' },
  { id: 'flat-vector', name: 'Flat vector illustration', category: 'Illustration', aspect: '1:1', tags: ['vector', 'flat', 'clean'],
    prompt: '{subject}, flat vector illustration, clean geometric shapes, limited palette of five harmonious colours, no outlines, subtle paper-cut shadows, generous negative space, friendly modern editorial feel.',
    negative: 'photo, gradients, text artifacts' },
  { id: 'ink-wash', name: 'Ink wash & line', category: 'Illustration', aspect: '3:4', tags: ['ink', 'monochrome'],
    prompt: '{subject}, loose black ink and wash illustration on cream paper, confident variable-width brush lines, soft grey washes bleeding at the edges, one small spot of vermilion red, lots of untouched paper.' },
  { id: 'storybook-gouache', name: 'Storybook gouache', category: 'Illustration', aspect: '4:3', tags: ['children', 'gouache', 'warm'],
    prompt: '{subject}, children\'s picture-book illustration in opaque gouache, soft textured brushwork, warm sunlit palette, rounded forms, gentle storytelling details in the background, visible paper grain.' },
  { id: 'retro-comic', name: 'Retro comic halftone', category: 'Illustration', aspect: '2:3', tags: ['comic', 'halftone', 'retro'],
    prompt: '{subject}, vintage comic book panel, bold black ink outlines, halftone dot shading, flat saturated colours with slight misregistration, dramatic angle, dynamic composition, aged newsprint texture.' },
  { id: 'botanical-plate', name: 'Botanical plate', category: 'Illustration', aspect: '3:4', tags: ['botanical', 'vintage'],
    prompt: '{subject}, antique botanical illustration plate, precise watercolour and fine pen detail, specimen centred on aged cream paper, neat hand-lettered Latin labels, soft foxing at the margins.' },
  { id: 'swiss-poster', name: 'Swiss poster', category: 'Design', aspect: '2:3', tags: ['poster', 'typography', 'grid'],
    prompt: 'A modernist Swiss-style poster about {subject}, strict grid layout, large bold grotesque type, asymmetrical balance, a single geometric graphic, two ink colours on off-white stock, generous margins.' },
  { id: 'isometric-icon', name: 'Isometric icon', category: 'Design', aspect: '1:1', tags: ['icon', 'isometric', 'ui'],
    prompt: '{subject}, isometric icon on a plain soft background, smooth rounded geometry, consistent 30 degree angles, soft pastel gradient fills, tiny contact shadow, polished app-store quality.' },
  { id: 'brand-mark', name: 'Minimal logo mark', category: 'Design', aspect: '1:1', tags: ['logo', 'minimal'],
    prompt: 'A minimal logo mark for {subject}, a single bold symbol built from simple geometric shapes, strong silhouette that works at small sizes, flat solid colour on white, balanced negative space, no text.' },
  { id: 'paper-collage', name: 'Cut-paper collage', category: 'Design', aspect: '4:5', tags: ['collage', 'paper', 'texture'],
    prompt: '{subject}, layered cut-paper collage, torn edges and hand-cut shapes, visible fibres and soft drop shadows between layers, muted earth palette with one vivid accent, tactile craft feel.' },
  { id: 'clay-3d', name: 'Soft clay 3D', category: '3D & Render', aspect: '1:1', tags: ['3d', 'clay', 'cute'],
    prompt: '{subject}, soft stylised 3D render in matte clay, rounded chunky forms, subtle fingerprints in the surface, pastel colours, soft studio lighting with gentle shadows, tilt-shift miniature feel.' },
  { id: 'glass-render', name: 'Glass & caustics', category: '3D & Render', aspect: '4:3', tags: ['3d', 'glass', 'abstract'],
    prompt: '{subject}, translucent glass sculpture, refraction and colourful caustics on a pale surface, physically based rendering, crisp edges with soft bokeh behind, calm minimal composition.' },
  { id: 'lowpoly-diorama', name: 'Low-poly diorama', category: '3D & Render', aspect: '16:9', tags: ['3d', 'lowpoly', 'game'],
    prompt: '{subject}, a tiny floating low-poly diorama, faceted flat-shaded surfaces, bright readable colours, soft ambient occlusion, simple sky gradient, clean game-art look.' },
  { id: 'blueprint', name: 'Technical blueprint', category: '3D & Render', aspect: '3:2', tags: ['technical', 'diagram'],
    prompt: 'A technical blueprint of {subject}, white linework on deep blue paper, orthographic views with dimension lines and callouts, exploded-view details, fine grid, small title block in the corner.' },
  { id: 'oil-impasto', name: 'Oil impasto', category: 'Painting', aspect: '4:5', tags: ['oil', 'painterly'],
    prompt: '{subject}, expressive oil painting with thick impasto brushstrokes, visible palette-knife ridges, rich layered colour, strong light and shadow, painted on rough linen canvas.' },
  { id: 'watercolour-loose', name: 'Loose watercolour', category: 'Painting', aspect: '3:2', tags: ['watercolour', 'soft'],
    prompt: '{subject}, loose watercolour painting, wet-on-wet blooms and soft colour bleeds, deliberate white paper highlights, translucent washes, light pencil sketch lines still visible.' },
  { id: 'ukiyo-e', name: 'Woodblock print', category: 'Painting', aspect: '2:3', tags: ['woodblock', 'japanese'],
    prompt: '{subject}, Japanese woodblock print aesthetic, flat areas of colour with fine carved outlines, subtle bokashi gradients, washi paper texture, restrained indigo, ochre and vermilion palette.' },
  { id: 'art-nouveau', name: 'Art nouveau poster', category: 'Painting', aspect: '2:3', tags: ['vintage', 'ornamental'],
    prompt: '{subject}, art nouveau lithograph poster, flowing organic lines, ornamental floral border, elegant flat colour with gold accents, decorative hand lettering, vintage paper tone.' },
  { id: 'cinematic-still', name: 'Cinematic film still', category: 'Cinematic', aspect: '21:9', tags: ['film', 'anamorphic'],
    prompt: '{subject}, cinematic film still, anamorphic lens with horizontal flares and oval bokeh, teal and amber colour grade, practical lighting, dust in the air, a story-driven composition with depth.' },
  { id: 'golden-epic', name: 'Golden hour epic', category: 'Cinematic', aspect: '16:9', tags: ['landscape', 'epic'],
    prompt: '{subject}, epic wide shot at golden hour, volumetric light rays through haze, tiny figures against a vast landscape, warm rim lighting, painterly atmospheric perspective.' },
  { id: 'sci-fi-concept', name: 'Sci-fi concept art', category: 'Cinematic', aspect: '16:9', tags: ['scifi', 'concept'],
    prompt: '{subject}, sci-fi environment concept art, huge scale with layered depth, hard-surface architecture, atmospheric fog, a limited cool palette with a single glowing warm light source, production-design quality.' },
  { id: 'wes-symmetry', name: 'Pastel symmetry', category: 'Cinematic', aspect: '4:3', tags: ['symmetry', 'pastel'],
    prompt: '{subject}, perfectly symmetrical centred composition, flat frontal framing, pastel pink, mint and butter-yellow palette, meticulous set dressing, deadpan whimsical mood.' },
  { id: 'studio-product', name: 'Studio product shot', category: 'Product', aspect: '4:5', tags: ['product', 'ecommerce'],
    prompt: '{subject}, premium studio product photograph on a seamless pale backdrop, soft large softbox lighting, subtle gradient reflection on the surface, crisp edges, true-to-life colour, ample space for copy.',
    negative: 'text, watermark, clutter' },
  { id: 'flatlay', name: 'Editorial flat lay', category: 'Product', aspect: '1:1', tags: ['flatlay', 'editorial'],
    prompt: '{subject}, overhead flat lay arranged on a textured linen surface, curated props and natural shadows from window light, harmonious colour story, magazine-style balance and breathing room.' },
  { id: 'packaging-mock', name: 'Packaging mockup', category: 'Product', aspect: '1:1', tags: ['packaging', 'mockup'],
    prompt: 'A packaging design for {subject}, matte box and pouch on a light concrete surface, tasteful minimal label typography, soft directional light and realistic contact shadows, brand-ready mockup.' },
  { id: 'food-moody', name: 'Moody food photography', category: 'Product', aspect: '4:5', tags: ['food', 'moody'],
    prompt: '{subject}, moody dark food photograph, single side light, deep shadows, rustic ceramic and wood textures, steam and fine crumbs, selective focus on the hero bite, rich warm tones.' },
]
