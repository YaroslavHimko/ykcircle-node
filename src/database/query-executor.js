// Preserve parameter normalization and legacy soft-delete filtering for query callers.
export function configureQueryExecutor(database) {
  const execute = database.execute.bind(database);
  const normalizeParams = (params) =>
    Array.isArray(params)
      ? params.map((value) => {
          if (value === undefined || (typeof value === 'number' && Number.isNaN(value)))
            return null;
          if (value instanceof Date && Number.isNaN(value.getTime())) return null;
          if (
            value &&
            typeof value === 'object' &&
            !Buffer.isBuffer(value) &&
            !(value instanceof Date)
          )
            return JSON.stringify(value);
          return value;
        })
      : params;
  database.execute = (sql, params) => {
    if (
      /^\s*SELECT\b/i.test(sql) &&
      /\b(?:FROM|JOIN) events\b/i.test(sql) &&
      !/\bdeleted_at\b/i.test(sql)
    ) {
      const column = /\b(?:FROM|JOIN) events\s+e\b/i.test(sql) ? 'e.deleted_at' : 'deleted_at';
      const whereIndex = sql.toUpperCase().lastIndexOf(' WHERE ');
      if (whereIndex >= 0) {
        const orderIndex = sql.toUpperCase().indexOf(' ORDER BY ', whereIndex);
        const endIndex = orderIndex >= 0 ? orderIndex : sql.length;
        const condition = sql.slice(whereIndex + 7, endIndex);
        sql = `${sql.slice(0, whereIndex)} WHERE (${condition}) AND ${column} IS NULL${sql.slice(endIndex)}`;
      }
    }
    return execute(sql, normalizeParams(params));
  };
}
