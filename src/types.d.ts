declare const __VERSION__: string;
declare const __PYODIDE_VERSION__: string;

declare module 'virtual:worker' {
  const source: string;
  export default source;
}

declare module 'virtual:pyodide-js' {
  const source: string;
  export default source;
}

declare module '*.py' {
  const source: string;
  export default source;
}
