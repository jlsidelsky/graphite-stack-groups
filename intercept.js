// Runs in the page's world so it can wrap the app's fetch and read the
// inbox-section API responses, which carry stack info the DOM doesn't.
const origFetch = window.fetch;
window.fetch = async (...args) => {
  const res = await origFetch(...args);
  const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
  if (url.includes("/api/v1/graphite/section/prs")) {
    res
      .clone()
      .json()
      .then((data) => {
        const items = (data?.root?.items ?? [])
          .map((it) => it.payload)
          .filter((p) => p?.number && p.stack?.stackId)
          .map((p) => ({
            number: p.number,
            stackId: p.stack.stackId,
            position: p.stack.position,
            height: p.stack.height,
            title: p.metadata?.title ?? "",
            branch: p.branch ?? "",
          }));
        if (items.length) {
          // detail as a JSON string so it crosses the isolated-world boundary
          window.dispatchEvent(
            new CustomEvent("gsg-stacks", { detail: JSON.stringify(items) }),
          );
        }
      })
      .catch(() => {});
  }
  return res;
};
