export type SizeRow = { id: string; name: string; full: string; mb: number }
type SizedImage = { id: string; repo: string; tag: string; size: string }

/**
 * The `n` largest images, biggest first. `name` is a short axis label that is always
 * unique (Bklit's band scale merges duplicate keys into one row), e.g. several dangling
 * `<none>:latest` images become "<none>", "<none>:latest", "<none>:latest (3)".
 */
export function largestImages(images: SizedImage[], parseMb: (s: string) => number, n: number): SizeRow[] {
  const used = new Set<string>()
  return images
    .map(img => ({ img, mb: parseMb(img.size) }))
    .filter(r => r.mb > 0)
    .sort((a, b) => b.mb - a.mb)
    .slice(0, n)
    .map(({ img, mb }) => {
      const short = img.repo.split("/").pop() || img.repo
      let name = used.has(short) ? `${short}:${img.tag}` : short
      for (let k = 2; used.has(name); k++) name = `${short}:${img.tag} (${k})`
      used.add(name)
      return { id: img.id, name, full: `${img.repo}:${img.tag}`, mb }
    })
}
