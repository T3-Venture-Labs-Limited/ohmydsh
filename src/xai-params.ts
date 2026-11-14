/** xAI's image routes use aspect_ratio/resolution rather than OpenAI's size. */
const RATIOS = new Set(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2'])

export function xaiToolParameters(options: { aspectRatio?: string; imageSize?: string; size?: string }): Record<string, string> {
  let ratio = options.aspectRatio
  if (options.size !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(options.size)
    if (match === null) throw new Error('xAI size must be WIDTHxHEIGHT; or pass aspect_ratio instead')
    const width = Number(match[1])
    const height = Number(match[2])
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error('xAI size must have a positive integer width and height')
    let divisor = width
    let remainder = height
    while (remainder !== 0) {
      const next = divisor % remainder
      divisor = remainder
      remainder = next
    }
    const fromSize = `${String(width / divisor)}:${String(height / divisor)}`
    if (ratio !== undefined && ratio !== fromSize) throw new Error('xAI size and aspect_ratio disagree')
    ratio = fromSize
  }
  if (ratio !== undefined && !RATIOS.has(ratio)) throw new Error(`xAI does not support aspect ratio ${ratio}`)
  const resolution = options.imageSize?.toLowerCase()
  if (resolution !== undefined && resolution !== '1k' && resolution !== '2k') throw new Error(`xAI does not support resolution ${options.imageSize}`)
  return { ...(ratio === undefined || ratio === 'auto' ? {} : { aspect_ratio: ratio }), ...(resolution === undefined ? {} : { resolution }) }
}
