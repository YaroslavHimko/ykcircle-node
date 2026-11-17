export function createHttpDatabase({ queries }) {
  const ensureTable = () => queries.initialize();
  return { ensureTable };
}
