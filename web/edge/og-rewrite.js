/** Point a page's link preview (title, description, image) at one market's card. */
export function rewrite(res, { title, description, pageUrl, img }) {
  const set = (value) => ({ element: (e) => e.setAttribute("content", value) });
  return new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[name="twitter:description"]', set(description))
    .on('meta[property="og:url"]', set(pageUrl))
    .on('meta[property="og:image"]', set(img))
    .on('meta[name="twitter:image"]', set(img))
    .on('meta[property="og:image:width"]', set("1200"))
    .on('meta[property="og:image:height"]', set("630"))
    .on('meta[property="og:image:alt"]', set(title))
    .transform(res);
}
