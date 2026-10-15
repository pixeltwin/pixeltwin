// `import x from './file.css' with { type: 'text' }` yields the file's text.
declare module '*.css' {
  const text: string;
  export default text;
}
