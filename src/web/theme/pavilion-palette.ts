const moonWhite = {
  '--canvas': '#f6f2ea',
  '--surface': '#fffcf5',
  '--surface-raised': '#fffcf5',
  '--surface-subtle': '#f1ece2',
  '--surface-hover': '#eae5da',
  '--surface-active': '#e1ebdf',
  '--ink': '#24343a',
  '--muted': '#53625f',
  '--line': '#d9d2c3',
  '--border': '#c8c3b6',
  '--outline': '#78877e',
  '--accent': '#2b665d',
  '--on-accent': '#fffcf5',
  '--accent-hover': '#20564f',
  '--soft': '#ddece6',
  '--on-soft': '#244e47',
  '--shadow': '#3a30251a',
  '--scrim': '#242e2c66',
  '--switch-thumb': '#fffcf5',
};

const nightPavilion = {
  '--canvas': '#172329',
  '--surface': '#1a2a2f',
  '--surface-raised': '#283c3f',
  '--surface-subtle': '#20363a',
  '--surface-hover': '#2a4445',
  '--surface-active': '#354e4e',
  '--ink': '#f6f2ea',
  '--muted': '#b8c7c2',
  '--line': '#40595a',
  '--border': '#577171',
  '--outline': '#829c97',
  '--accent': '#8cc9bb',
  '--on-accent': '#102e29',
  '--accent-hover': '#a8dacd',
  '--soft': '#304d4e',
  '--on-soft': '#e2ede7',
  '--shadow': '#00000055',
  '--scrim': '#00000099',
  '--switch-thumb': '#102e29',
};

export function pavilionPalette(id: string | undefined, mode: 'light' | 'dark') {
  if (id === 'pavilion-light' && mode === 'light') return moonWhite;
  if (id === 'pavilion-dark' && mode === 'dark') return nightPavilion;
}
