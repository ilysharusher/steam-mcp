export function page(title: string, body: string, status = 200): Response {
  const safeTitle = escapeHtml(title);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#111}
 h1{font-size:1.3rem;margin:0 0 1rem}
 code{background:#f2f2f2;padding:.1rem .35rem;border-radius:3px;font-size:.9em}
 button{font:inherit;background:#111;color:#fff;border:0;border-radius:6px;padding:.6rem 1.2rem;cursor:pointer}
 .muted{color:#666;font-size:.9rem}
</style>
<h1>${safeTitle}</h1>${body}`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The denial page echoes a GitHub login; none of these should be cached.
        "cache-control": "no-store",
      },
    },
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
