import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { writeRef } from '../render-effects';

export interface PreviewSheet {
  name: string;
  rows: string[][];
  clipped: boolean;
}

function columnLabel(index: number): string {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export const SpreadsheetPreview = tsxComponent(function SpreadsheetPreview(_props: {
  sheets: PreviewSheet[];
  clippedSheets?: boolean;
}) {
  const activeIndexState = shallowRef(0);
  const setActiveIndex = writeRef(activeIndexState);
  const filterState = shallowRef('');
  const setFilter = writeRef(filterState);

  return ({ sheets, clippedSheets = false }) => {
    const safeIndex = Math.min(activeIndexState.value, Math.max(0, sheets.length - 1));
    const sheet = sheets[safeIndex];
    const query = filterState.value.trim().toLowerCase();
    const allRows = sheet?.rows ?? [];
    const filteredRows = query
      ? allRows
          .map((row, idx) => ({ row, idx }))
          .filter(({ row, idx }) => idx === 0 || row.some((cell) => cell.toLowerCase().includes(query)))
      : allRows.map((row, idx) => ({ row, idx }));
    const columns = allRows.reduce((max, row) => Math.max(max, row.length), 0);

    return (
      <div class="fp-spreadsheet">
        <div class="fp-subbar">
          {sheets.length > 1 && (
            <div class="fp-sheet-tabs" role="tablist" aria-label="工作表切换">
              {sheets.map((item, idx) => (
                <button
                  key={`${item.name}:${idx}`}
                  type="button"
                  role="tab"
                  aria-selected={idx === safeIndex}
                  class={`fp-sheet-tab${idx === safeIndex ? ' active' : ''}`}
                  onClick={() => setActiveIndex(idx)}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}
          <input
            type="search"
            class="fp-filter-input"
            placeholder="筛选单元格内容…"
            value={filterState.value}
            onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          />
          <span class="fp-subbar-meta">
            {query ? `${filteredRows.length} / ${allRows.length} 行` : `${allRows.length} 行 · ${columns} 列`}
          </span>
        </div>
        {(sheet?.clipped || clippedSheets) && (
          <p class="fp-inline-note">
            {clippedSheets ? '仅显示前 24 个工作表；' : ''}
            {sheet?.clipped ? '当前工作表行数或列数较多，仅展示部分内容，完整数据请下载查看。' : ''}
          </p>
        )}
        <div class="fp-table-scroll">
          {columns === 0 ? (
            <p class="file-preview-state">当前工作表为空。</p>
          ) : (
            <table class="file-preview-table" aria-label={sheet?.name || '表格预览'}>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  {Array.from({ length: columns }, (_, index) => (
                    <th scope="col" key={index}>
                      {columnLabel(index)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(({ row, idx }) => (
                  <tr key={idx}>
                    <th scope="row">{idx + 1}</th>
                    {Array.from({ length: columns }, (_, column) => (
                      <td key={column}>{row[column] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };
});
