export async function pages(repo: any, filter: any, opts: any) {
  const result: any[] = [];
  let page = await repo.findPage(filter, opts);
  while (page.nextCursor) {
    result.push(page.items);
    page = await repo.findPage(filter, {
      ...opts,
      cursor: page.nextCursor,
    });
  }
  result.push(page.items);
  return result;
}

// gives IDs id-000, id-001, id-002, etc.
export function ascendingIds() {
  let idCounter = 0;
  return () => `id-${String(idCounter++).padStart(3, '0')}`;
}
