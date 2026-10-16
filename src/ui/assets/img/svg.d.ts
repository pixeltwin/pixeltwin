// SVG files are imported as text (`with { type: 'text' }`) and served as they are.
declare module '*.svg' {
  const text: string;
  export default text;
}
