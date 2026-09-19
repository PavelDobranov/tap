/**
 * Renders fixed-width columns. Columns are padded to their widest cell so the
 * output stays readable in a terminal and greppable in a pipe.
 */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();

  return [line(headers), ...rows.map(line)].map((text) => `${text}\n`).join("");
}
